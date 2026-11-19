const express = require('express');
const { query, pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { variantLabel } = require('../lib/bookingHelpers');
const { refundPayment, fetchRefund } = require('../lib/razorpay');

// Ticket cancellation & refunds — admin only.
const router = express.Router();
router.use(requireAdmin);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toPaise = (amount) => Math.round(Number(amount) * 100);
const fromPaise = (paise) => paise / 100;

// Money actually returned on a booking. A Razorpay refund that failed returned nothing, so it doesn't count.
const RAZORPAY_EFFECTIVE = "CASE WHEN r.razorpay_status = 'failed' THEN 0 ELSE r.razorpay_amount END";
const refundedSql = (bookingAlias) => `(SELECT COALESCE(SUM(r.cash_amount + r.upi_amount + ${RAZORPAY_EFFECTIVE}), 0)
   FROM refunds r WHERE r.booking_id = ${bookingAlias}.id)`;

const ITEMS_SUMMARY_SQL = `(SELECT STRING_AGG(g.name || COALESCE(' (' || INITCAP(gv.mode) || ' · ' || gv.laps || ' laps)', '') || ' × ' || bi.quantity, ', ' ORDER BY bi.id)
   FROM booking_items bi
   JOIN games g ON g.id = bi.game_id
   LEFT JOIN game_variants gv ON gv.id = bi.game_variant_id
   WHERE bi.booking_id = b.id)`;

function shortCode(qrToken) {
  return qrToken.slice(-8).toUpperCase();
}

function razorpayErrorMessage(err) {
  if (err.code === 'RAZORPAY_CONFIG_MISSING') return 'Razorpay is not configured on the server';
  return err.error?.description || err.message || 'Razorpay request failed';
}

// ---------- Booking search ----------

// GET /refunds/bookings?q=  — phone, email, ticket code, booking id (JF-00012 / 12) or name.
// With no q: today's bookings, newest first.
router.get('/bookings', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const params = [];
  let where;

  const digits = q.replace(/\D/g, '');
  const code = q.replace(/^#/, '');
  if (!q) {
    where = 'b.visit_date = CURRENT_DATE';
  } else if (q.includes('@')) {
    params.push(`%${q.toLowerCase()}%`);
    where = `(LOWER(COALESCE(u.email, '')) LIKE $1 OR LOWER(COALESCE(b.customer_email, '')) LIKE $1)`;
  } else if (/^(jf-?)?\d{1,9}$/i.test(q)) {
    params.push(Number(digits), code);
    // An 8-digit number could also be a ticket's short code.
    where = `(b.id = $1 OR (LENGTH($2) = 8 AND EXISTS (
               SELECT 1 FROM tickets t JOIN booking_items bi ON bi.id = t.booking_item_id
               WHERE bi.booking_id = b.id AND LOWER(RIGHT(t.qr_token, 8)) = LOWER($2))))`;
  } else if (digits.length >= 10 && /^[+\d\s-]+$/.test(q)) {
    params.push(digits.slice(-10));
    where = `(b.customer_phone = $1 OR RIGHT(REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g'), 10) = $1)`;
  } else if (/^[A-Za-z0-9_-]{8}$/.test(code) || /^[A-Za-z0-9_-]{24}$/.test(code)) {
    params.push(code);
    where = `EXISTS (SELECT 1 FROM tickets t JOIN booking_items bi ON bi.id = t.booking_item_id
                     WHERE bi.booking_id = b.id
                       AND (t.qr_token = $1 OR LOWER(RIGHT(t.qr_token, 8)) = LOWER($1)))`;
  } else {
    params.push(`%${q.toLowerCase()}%`);
    where = `(LOWER(COALESCE(u.name, '')) LIKE $1 OR LOWER(COALESCE(b.customer_name, '')) LIKE $1)`;
  }

  const result = await query(
    `SELECT b.id, b.created_at, b.visit_date, b.source, b.total_amount, b.payment_method,
            COALESCE(b.customer_name, u.name) AS customer_name,
            COALESCE(b.customer_phone, u.phone) AS customer_phone,
            COALESCE(b.customer_email, u.email) AS customer_email,
            ${ITEMS_SUMMARY_SQL} AS items_summary,
            (SELECT COUNT(*) FROM tickets t JOIN booking_items bi ON bi.id = t.booking_item_id WHERE bi.booking_id = b.id)::int AS ticket_count,
            (SELECT COUNT(*) FROM tickets t JOIN booking_items bi ON bi.id = t.booking_item_id
              WHERE bi.booking_id = b.id AND t.status = 'cancelled')::int AS cancelled_count,
            ${refundedSql('b')} AS refunded_amount
     FROM bookings b
     LEFT JOIN users u ON u.id = b.user_id
     WHERE b.status = 'paid' AND ${where}
     ORDER BY b.created_at DESC
     LIMIT 100`,
    params
  );

  res.json({ bookings: result.rows });
});

// ---------- Booking detail ----------

async function loadBookingDetail(bookingId) {
  const bookingResult = await query(
    `SELECT b.*, b.visit_date = CURRENT_DATE AS is_today,
            COALESCE(b.customer_name, u.name) AS cust_name,
            COALESCE(b.customer_phone, u.phone) AS cust_phone,
            COALESCE(b.customer_email, u.email) AS cust_email,
            s.uid AS sold_by_uid
     FROM bookings b
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN staff s ON s.id = b.sold_by_staff_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const b = bookingResult.rows[0];
  if (!b) return null;

  const ticketRows = await query(
    `SELECT bi.id AS booking_item_id, bi.unit_price, g.name AS game_name, gv.mode, gv.laps,
            t.id AS ticket_id, t.qr_token, t.status, t.scanned_at, t.cancelled_at
     FROM booking_items bi
     JOIN games g ON g.id = bi.game_id
     LEFT JOIN game_variants gv ON gv.id = bi.game_variant_id
     LEFT JOIN tickets t ON t.booking_item_id = bi.id
     WHERE bi.booking_id = $1
     ORDER BY bi.id, t.id`,
    [bookingId]
  );
  const itemsMap = new Map();
  for (const row of ticketRows.rows) {
    if (!itemsMap.has(row.booking_item_id)) {
      itemsMap.set(row.booking_item_id, {
        bookingItemId: row.booking_item_id,
        gameName: row.game_name,
        variantLabel: variantLabel(row.mode, row.laps),
        unitPrice: Number(row.unit_price),
        tickets: [],
      });
    }
    if (row.ticket_id) {
      itemsMap.get(row.booking_item_id).tickets.push({
        id: row.ticket_id,
        code: shortCode(row.qr_token),
        status: row.status,
        scannedAt: row.scanned_at,
        cancelledAt: row.cancelled_at,
      });
    }
  }

  const refundsResult = await query('SELECT * FROM refunds WHERE booking_id = $1 ORDER BY created_at DESC', [bookingId]);
  const refunds = refundsResult.rows.map(refundJson);

  const paidPaise = toPaise(b.total_amount);
  let refundedPaise = 0;
  let razorpayRefundedPaise = 0;
  for (const r of refundsResult.rows) {
    const rp = r.razorpay_status === 'failed' ? 0 : toPaise(r.razorpay_amount);
    razorpayRefundedPaise += rp;
    refundedPaise += rp + toPaise(r.cash_amount) + toPaise(r.upi_amount);
  }
  const razorpayPaidPaise = b.source === 'online' && b.razorpay_payment_id ? paidPaise : 0;

  let blockedReason = null;
  if (b.status !== 'paid') blockedReason = 'This booking was never paid.';
  else if (!b.is_today) blockedReason = 'Refunds are only allowed on the visit day. This booking was for an earlier date.';

  return {
    booking: {
      id: b.id,
      createdAt: b.created_at,
      visitDate: b.visit_date,
      source: b.source,
      status: b.status,
      total: fromPaise(paidPaise),
      paymentMethod: b.source === 'online' ? 'razorpay' : b.payment_method,
      cashAmount: Number(b.cash_amount),
      upiAmount: Number(b.upi_amount),
      upiRef: b.upi_ref,
      razorpayPaymentId: b.razorpay_payment_id,
      soldBy: b.source === 'counter' ? b.sold_by_uid || 'Admin' : null,
      customer: { name: b.cust_name, phone: b.cust_phone, email: b.cust_email },
    },
    items: Array.from(itemsMap.values()),
    refunds,
    summary: {
      paid: fromPaise(paidPaise),
      refunded: fromPaise(refundedPaise),
      refundable: fromPaise(Math.max(0, paidPaise - refundedPaise)),
      razorpayPaid: fromPaise(razorpayPaidPaise),
      razorpayRefundable: fromPaise(Math.max(0, Math.min(razorpayPaidPaise - razorpayRefundedPaise, paidPaise - refundedPaise))),
      canRefund: !blockedReason,
      blockedReason,
    },
  };
}

function refundJson(r) {
  return {
    id: r.id,
    bookingId: r.booking_id,
    amount: Number(r.amount),
    razorpayAmount: Number(r.razorpay_amount),
    cashAmount: Number(r.cash_amount),
    upiAmount: Number(r.upi_amount),
    upiRef: r.upi_ref,
    razorpayRefundId: r.razorpay_refund_id,
    razorpayStatus: r.razorpay_status,
    reason: r.reason,
    ticketCount: r.ticket_count,
    createdAt: r.created_at,
  };
}

router.get('/bookings/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Booking not found' });
  const detail = await loadBookingDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Booking not found' });
  res.json(detail);
});

// ---------- Create a refund ----------

function parseAmount(value, label) {
  if (value == null || value === '') return { paise: 0 };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} amount must be 0 or more` };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { error: `${label} amount can have at most 2 decimals` };
  return { paise: Math.round(n * 100) };
}

// POST /refunds  { bookingId, ticketIds: [], razorpayAmount, cashAmount, upiAmount, upiRef, reason }
// Cancels the given unused tickets (if any) and records money returned via any mix of Razorpay / cash / UPI.
// The Razorpay part is sent to Razorpay first; if Razorpay refuses, nothing is cancelled or recorded.
router.post('/', async (req, res) => {
  const { bookingId, ticketIds = [], upiRef } = req.body;
  const reason = String(req.body.reason || '').trim().slice(0, 300);

  if (!/^\d+$/.test(String(bookingId || ''))) return res.status(400).json({ error: 'bookingId is required' });
  if (!reason) return res.status(400).json({ error: 'Enter a reason for the refund' });
  if (!Array.isArray(ticketIds) || ticketIds.some((id) => !/^\d+$/.test(String(id)))) {
    return res.status(400).json({ error: 'ticketIds must be a list of ticket ids' });
  }
  const uniqueTicketIds = [...new Set(ticketIds.map(String))];

  const amounts = {};
  for (const [key, label] of [['razorpayAmount', 'Razorpay'], ['cashAmount', 'Cash'], ['upiAmount', 'UPI']]) {
    const parsed = parseAmount(req.body[key], label);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    amounts[key] = parsed.paise;
  }
  const totalPaise = amounts.razorpayAmount + amounts.cashAmount + amounts.upiAmount;
  if (uniqueTicketIds.length === 0 && totalPaise === 0) {
    return res.status(400).json({ error: 'Select tickets to cancel or enter an amount to refund' });
  }
  const cleanUpiRef = amounts.upiAmount > 0 && upiRef ? String(upiRef).trim().slice(0, 64) || null : null;

  const client = await pool.connect();
  let refundId;
  try {
    await client.query('BEGIN');

    // Row lock: two refunds on the same booking can't both pass the "how much is left" check.
    const bookingResult = await client.query(
      'SELECT *, visit_date = CURRENT_DATE AS is_today FROM bookings WHERE id = $1 FOR UPDATE',
      [bookingId]
    );
    const booking = bookingResult.rows[0];
    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.status !== 'paid') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This booking was never paid' });
    }
    if (!booking.is_today) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Refunds are only allowed on the visit day' });
    }

    if (uniqueTicketIds.length > 0) {
      const ticketsResult = await client.query(
        `SELECT t.id, t.status, t.qr_token
         FROM tickets t JOIN booking_items bi ON bi.id = t.booking_item_id
         WHERE bi.booking_id = $1 AND t.id = ANY($2::bigint[])
         FOR UPDATE OF t`,
        [bookingId, uniqueTicketIds]
      );
      if (ticketsResult.rows.length !== uniqueTicketIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Some tickets do not belong to this booking' });
      }
      const notUnused = ticketsResult.rows.find((t) => t.status !== 'unused');
      if (notUnused) {
        await client.query('ROLLBACK');
        const what = notUnused.status === 'used' ? 'has already been scanned' : `is ${notUnused.status}`;
        return res.status(409).json({ error: `Ticket #${shortCode(notUnused.qr_token)} ${what} and can't be cancelled` });
      }
    }

    const sums = await client.query(
      `SELECT COALESCE(SUM(r.cash_amount + r.upi_amount + ${RAZORPAY_EFFECTIVE}), 0) AS refunded,
              COALESCE(SUM(${RAZORPAY_EFFECTIVE}), 0) AS razorpay_refunded
       FROM refunds r WHERE r.booking_id = $1`,
      [bookingId]
    );
    const paidPaise = toPaise(booking.total_amount);
    const leftPaise = paidPaise - toPaise(sums.rows[0].refunded);
    const razorpayPaidPaise = booking.source === 'online' && booking.razorpay_payment_id ? paidPaise : 0;
    const razorpayLeftPaise = razorpayPaidPaise - toPaise(sums.rows[0].razorpay_refunded);

    if (totalPaise > leftPaise) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Refund is more than what's left on this booking (₹${fromPaise(leftPaise)})` });
    }
    if (amounts.razorpayAmount > 0 && razorpayPaidPaise === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This booking was not paid via Razorpay — refund it in cash or UPI' });
    }
    if (amounts.razorpayAmount > razorpayLeftPaise) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `At most ₹${fromPaise(razorpayLeftPaise)} can go back via Razorpay` });
    }

    const insert = await client.query(
      `INSERT INTO refunds (booking_id, amount, razorpay_amount, cash_amount, upi_amount, upi_ref, razorpay_status, reason, ticket_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        bookingId,
        fromPaise(totalPaise),
        fromPaise(amounts.razorpayAmount),
        fromPaise(amounts.cashAmount),
        fromPaise(amounts.upiAmount),
        cleanUpiRef,
        amounts.razorpayAmount > 0 ? 'pending' : null,
        reason,
        uniqueTicketIds.length,
      ]
    );
    refundId = insert.rows[0].id;

    if (uniqueTicketIds.length > 0) {
      await client.query(
        "UPDATE tickets SET status = 'cancelled', cancelled_at = now(), refund_id = $1 WHERE id = ANY($2::bigint[])",
        [refundId, uniqueTicketIds]
      );
    }

    // Razorpay last, while the rows are still locked: if it refuses, the rollback undoes everything above.
    if (amounts.razorpayAmount > 0) {
      let rzpRefund;
      try {
        rzpRefund = await refundPayment({
          paymentId: booking.razorpay_payment_id,
          amount: fromPaise(amounts.razorpayAmount),
          receipt: `refund_${refundId}`,
          notes: { booking_id: String(bookingId), reason: reason.slice(0, 250) },
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Razorpay refund failed:', { bookingId, statusCode: err.statusCode, error: err.error || err.message });
        return res.status(502).json({ error: `Razorpay refused the refund: ${razorpayErrorMessage(err)}. Nothing was cancelled.` });
      }
      await client.query(
        'UPDATE refunds SET razorpay_refund_id = $1, razorpay_status = $2, updated_at = now() WHERE id = $3',
        [rzpRefund.id, rzpRefund.status || 'pending', refundId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const detail = await loadBookingDetail(bookingId);
  res.status(201).json({ refundId, ...detail });
});

// ---------- Refund list ----------

// GET /refunds?from=YYYY-MM-DD&to=YYYY-MM-DD  (both default to today)
router.get('/', async (req, res) => {
  const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : null;
  const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : null;

  const result = await query(
    `SELECT r.*, b.source, b.total_amount AS booking_total,
            COALESCE(b.customer_name, u.name) AS customer_name,
            COALESCE(b.customer_phone, u.phone) AS customer_phone,
            COALESCE(b.customer_email, u.email) AS customer_email
     FROM refunds r
     JOIN bookings b ON b.id = r.booking_id
     LEFT JOIN users u ON u.id = b.user_id
     WHERE r.created_at::date BETWEEN COALESCE($1::date, CURRENT_DATE) AND COALESCE($2::date, $1::date, CURRENT_DATE)
     ORDER BY r.created_at DESC`,
    [from, to]
  );

  const totals = { count: 0, tickets: 0, amount: 0, razorpay: 0, razorpayPending: 0, razorpayFailed: 0, cash: 0, upi: 0 };
  const refunds = result.rows.map((r) => {
    const rp = Number(r.razorpay_amount);
    totals.count += 1;
    totals.tickets += r.ticket_count;
    totals.cash += Number(r.cash_amount);
    totals.upi += Number(r.upi_amount);
    if (r.razorpay_status === 'failed') totals.razorpayFailed += rp;
    else {
      totals.razorpay += rp;
      if (r.razorpay_status === 'pending') totals.razorpayPending += rp;
    }
    totals.amount += Number(r.cash_amount) + Number(r.upi_amount) + (r.razorpay_status === 'failed' ? 0 : rp);
    return {
      ...refundJson(r),
      source: r.source,
      bookingTotal: Number(r.booking_total),
      customer: { name: r.customer_name, phone: r.customer_phone, email: r.customer_email },
    };
  });
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;

  res.json({ refunds, totals });
});

// POST /refunds/:id/sync — ask Razorpay for the latest status of a refund (pending -> processed / failed).
router.post('/:id/sync', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Refund not found' });
  const result = await query(
    `SELECT r.*, b.razorpay_payment_id FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1`,
    [req.params.id]
  );
  const refund = result.rows[0];
  if (!refund) return res.status(404).json({ error: 'Refund not found' });
  if (!refund.razorpay_refund_id) return res.status(400).json({ error: 'This refund has no Razorpay part' });

  let rzpRefund;
  try {
    rzpRefund = await fetchRefund(refund.razorpay_payment_id, refund.razorpay_refund_id);
  } catch (err) {
    return res.status(502).json({ error: `Could not reach Razorpay: ${razorpayErrorMessage(err)}` });
  }
  const updated = await query(
    'UPDATE refunds SET razorpay_status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [rzpRefund.status, refund.id]
  );
  res.json({ refund: refundJson(updated.rows[0]) });
});

module.exports = router;
