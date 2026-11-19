const express = require('express');
const { query, pool } = require('../db');
const { requireWorkerOrAdmin } = require('../middleware/auth');
const { variantLabel, resolveCart, issueTickets } = require('../lib/bookingHelpers');

const router = express.Router();

// Admin can always sell; a worker only when the admin has turned on "can sell" for them (checked live, not from the session).
async function requireSeller(req, res, next) {
  if (req.isAdmin) return next();
  const result = await query('SELECT can_sell FROM staff WHERE id = $1', [req.workerId]);
  if (!result.rows[0]?.can_sell) {
    return res.status(403).json({ error: 'You are not allowed to sell tickets. Ask the admin to enable counter sales for you.' });
  }
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_METHODS = new Set(['cash', 'upi', 'split']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Stores phone numbers the same way the customer app does: 10 digits, no +91.
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

const toPaise = (amount) => Math.round(Number(amount) * 100);

// Walk-in sale at the counter: any logged-in worker, or admin, sells tickets on behalf of a customer
// who pays cash, UPI (to the park's own UPI QR, recorded manually), or a split of both.
router.post('/sales', requireWorkerOrAdmin, requireSeller, async (req, res) => {
  const { items, customer = {}, payment = {}, expectedTotal } = req.body;

  const phone = customer.phone ? normalizePhone(customer.phone) : null;
  const email = customer.email ? String(customer.email).trim().toLowerCase() : null;
  const name = customer.name ? String(customer.name).trim().slice(0, 100) : null;
  if (!phone && !email) return res.status(400).json({ error: 'Enter the customer phone number or email' });
  if (phone && !/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });

  const cart = await resolveCart(items);
  if (cart.error) return res.status(400).json({ error: cart.error });
  const totalPaise = toPaise(cart.total);

  // Guards against a price being edited between the counter loading the catalog and taking the money.
  if (expectedTotal != null && toPaise(expectedTotal) !== totalPaise) {
    return res.status(409).json({
      error: `Prices have changed — the total is now ₹${cart.total}. Refresh and check the amount with the customer.`,
    });
  }

  const method = payment.method;
  if (!PAYMENT_METHODS.has(method)) return res.status(400).json({ error: 'Choose cash, UPI, or split payment' });

  let cashPaise;
  if (method === 'cash') cashPaise = totalPaise;
  else if (method === 'upi') cashPaise = 0;
  else {
    cashPaise = toPaise(payment.cashAmount);
    if (!Number.isFinite(cashPaise) || cashPaise <= 0 || cashPaise >= totalPaise) {
      return res.status(400).json({ error: 'For split payment, the cash part must be more than ₹0 and less than the total' });
    }
  }
  const upiPaise = totalPaise - cashPaise;
  const upiRef = upiPaise > 0 && payment.upiRef ? String(payment.upiRef).trim().slice(0, 64) : null;

  // If this customer already has an app account, put the tickets straight into it (email match wins over phone).
  const userResult = await query(
    `SELECT id FROM users
     WHERE (LOWER(email) = LOWER($1) AND $1::text IS NOT NULL) OR (phone = $2 AND $2::text IS NOT NULL)
     ORDER BY (LOWER(email) = LOWER($1)) DESC NULLS LAST, id
     LIMIT 1`,
    [email, phone]
  );
  const userId = userResult.rows[0]?.id || null;

  const client = await pool.connect();
  let bookingId;
  let visitDate;
  let issuedItems;
  try {
    await client.query('BEGIN');
    const bookingResult = await client.query(
      `INSERT INTO bookings
         (user_id, visit_date, total_amount, status, source, sold_by_staff_id,
          customer_name, customer_phone, customer_email, payment_method, cash_amount, upi_amount, upi_ref)
       VALUES ($1, CURRENT_DATE, $2, 'paid', 'counter', $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, visit_date`,
      [
        userId,
        totalPaise / 100,
        req.isAdmin ? null : req.workerId,
        name,
        phone,
        email,
        method,
        cashPaise / 100,
        upiPaise / 100,
        upiRef,
      ]
    );
    bookingId = bookingResult.rows[0].id;
    visitDate = bookingResult.rows[0].visit_date;

    for (const item of cart.resolvedItems) {
      await client.query(
        'INSERT INTO booking_items (booking_id, game_id, game_variant_id, quantity) VALUES ($1, $2, $3, $4)',
        [bookingId, item.gameId, item.variantId, item.quantity]
      );
    }
    issuedItems = await issueTickets(client, bookingId, visitDate);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({
    sale: {
      id: bookingId,
      visitDate,
      total: totalPaise / 100,
      paymentMethod: method,
      cashAmount: cashPaise / 100,
      upiAmount: upiPaise / 100,
      upiRef,
      customer: { name, phone, email },
      linkedToAccount: Boolean(userId),
      items: issuedItems.map((item) => ({ ...item, tickets: item.tickets.map((t) => ({ id: t.id, qrToken: t.qr_token, status: 'unused' })) })),
    },
  });
});

// Counter sales for one day with totals. Admin sees everyone's (optionally one seller's); a worker sees only their own.
router.get('/sales', requireWorkerOrAdmin, async (req, res) => {
  const date = DATE_RE.test(String(req.query.date || '')) ? req.query.date : null;
  const params = [date];
  let sellerFilter = '';
  if (!req.isAdmin) {
    params.push(req.workerId);
    sellerFilter = `AND b.sold_by_staff_id = $${params.length}`;
  } else if (req.query.seller === 'admin') {
    sellerFilter = 'AND b.sold_by_staff_id IS NULL';
  } else if (/^\d+$/.test(String(req.query.seller || ''))) {
    params.push(req.query.seller);
    sellerFilter = `AND b.sold_by_staff_id = $${params.length}`;
  }

  const result = await query(
    `SELECT b.id, b.created_at, b.total_amount, b.payment_method, b.cash_amount, b.upi_amount, b.upi_ref,
            b.customer_name, b.customer_phone, b.customer_email, b.user_id IS NOT NULL AS linked,
            s.uid AS sold_by_uid, s.name AS sold_by_name,
            (SELECT STRING_AGG(g.name || COALESCE(' (' || INITCAP(gv.mode) || ' · ' || gv.laps || ' laps)', '') || ' × ' || bi.quantity, ', ' ORDER BY bi.id)
               FROM booking_items bi
               JOIN games g ON g.id = bi.game_id
               LEFT JOIN game_variants gv ON gv.id = bi.game_variant_id
              WHERE bi.booking_id = b.id) AS items_summary,
            (SELECT COALESCE(SUM(bi.quantity), 0) FROM booking_items bi WHERE bi.booking_id = b.id)::int AS ticket_count
     FROM bookings b
     LEFT JOIN staff s ON s.id = b.sold_by_staff_id
     WHERE b.source = 'counter' AND b.visit_date = COALESCE($1::date, CURRENT_DATE) ${sellerFilter}
     ORDER BY b.created_at DESC`,
    params
  );

  const totals = result.rows.reduce(
    (acc, row) => ({
      sales: acc.sales + 1,
      tickets: acc.tickets + row.ticket_count,
      total: acc.total + Number(row.total_amount),
      cash: acc.cash + Number(row.cash_amount),
      upi: acc.upi + Number(row.upi_amount),
    }),
    { sales: 0, tickets: 0, total: 0, cash: 0, upi: 0 }
  );

  res.json({ sales: result.rows, totals });
});

// One counter sale with its QR tickets, for reprinting. A worker can only open their own sales.
router.get('/sales/:id', requireWorkerOrAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Sale not found' });

  const bookingResult = await query(
    `SELECT id, visit_date, total_amount, payment_method, cash_amount, upi_amount, upi_ref,
            customer_name, customer_phone, customer_email, sold_by_staff_id, user_id
     FROM bookings WHERE id = $1 AND source = 'counter'`,
    [req.params.id]
  );
  const booking = bookingResult.rows[0];
  if (!booking || (!req.isAdmin && String(booking.sold_by_staff_id) !== String(req.workerId))) {
    return res.status(404).json({ error: 'Sale not found' });
  }

  const rows = await query(
    `SELECT bi.id AS booking_item_id, g.key AS game_key, g.name AS game_name, g.image_url, gv.mode, gv.laps,
            t.id AS ticket_id, t.qr_token, t.status
     FROM booking_items bi
     JOIN games g ON g.id = bi.game_id
     LEFT JOIN game_variants gv ON gv.id = bi.game_variant_id
     JOIN tickets t ON t.booking_item_id = bi.id
     WHERE bi.booking_id = $1
     ORDER BY bi.id, t.id`,
    [booking.id]
  );

  const itemsMap = new Map();
  for (const row of rows.rows) {
    if (!itemsMap.has(row.booking_item_id)) {
      itemsMap.set(row.booking_item_id, {
        bookingItemId: row.booking_item_id,
        gameKey: row.game_key,
        gameName: row.game_name,
        imageUrl: row.image_url,
        variantLabel: variantLabel(row.mode, row.laps),
        tickets: [],
      });
    }
    itemsMap.get(row.booking_item_id).tickets.push({ id: row.ticket_id, qrToken: row.qr_token, status: row.status });
  }

  res.json({
    sale: {
      id: booking.id,
      visitDate: booking.visit_date,
      total: Number(booking.total_amount),
      paymentMethod: booking.payment_method,
      cashAmount: Number(booking.cash_amount),
      upiAmount: Number(booking.upi_amount),
      upiRef: booking.upi_ref,
      customer: { name: booking.customer_name, phone: booking.customer_phone, email: booking.customer_email },
      linkedToAccount: Boolean(booking.user_id),
      items: Array.from(itemsMap.values()),
    },
  });
});

module.exports = router;
