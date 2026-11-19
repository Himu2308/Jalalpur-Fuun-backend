const express = require('express');
const { query, pool } = require('../db');
const { requireUser } = require('../middleware/auth');
const { createOrder, verifyPayment, keyId } = require('../lib/razorpay');
const { variantLabel, resolveCart, issueTickets } = require('../lib/bookingHelpers');

const router = express.Router();

// Create a booking (multi-game, multi-variant cart) for today's visit date, and a Razorpay order to pay for it
router.post('/', requireUser, async (req, res) => {
  const { items } = req.body; // [{ gameKey, variantId?, quantity }]
  const cart = await resolveCart(items);
  if (cart.error) return res.status(400).json({ error: cart.error });
  const { total, resolvedItems } = cart;

  const bookingResult = await query(
    `INSERT INTO bookings (user_id, visit_date, total_amount, status)
     VALUES ($1, CURRENT_DATE, $2, 'pending') RETURNING id`,
    [req.userId, total]
  );
  const bookingId = bookingResult.rows[0].id;

  for (const item of resolvedItems) {
    await query(
      'INSERT INTO booking_items (booking_id, game_id, game_variant_id, quantity, unit_price) VALUES ($1, $2, $3, $4, $5)',
      [bookingId, item.gameId, item.variantId, item.quantity, item.unitPrice]
    );
  }

  let order;
  try {
    order = await createOrder({ amount: total, receipt: `booking_${bookingId}` });
  } catch (err) {
    if (err.code === 'RAZORPAY_CONFIG_MISSING') {
      return res.status(500).json({ error: 'Payment gateway is not configured' });
    }

    const gatewayCode = err.error?.code;
    const gatewayDescription = err.error?.description;
    if (err.statusCode === 401 || gatewayDescription === 'Authentication failed') {
      console.error('Razorpay authentication failed. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
      return res.status(502).json({ error: 'Payment gateway authentication failed' });
    }

    console.error('Razorpay order creation failed:', {
      statusCode: err.statusCode,
      code: gatewayCode,
      description: gatewayDescription,
    });
    return res.status(502).json({ error: 'Payment gateway order creation failed' });
  }

  await query('UPDATE bookings SET razorpay_order_id = $1 WHERE id = $2', [order.id, bookingId]);

  res.status(201).json({
    bookingId,
    razorpayOrderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId,
  });
});

// Verify payment, mark booking paid, and generate one QR ticket per person per booking line
router.post('/:id/verify-payment', requireUser, async (req, res) => {
  const bookingId = req.params.id;
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  const bookingResult = await query(
    'SELECT * FROM bookings WHERE id = $1 AND user_id = $2',
    [bookingId, req.userId]
  );
  const booking = bookingResult.rows[0];
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.razorpay_order_id !== razorpayOrderId) {
    return res.status(400).json({ error: 'Order mismatch' });
  }

  const valid = verifyPayment({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  });
  if (!valid) {
    await query("UPDATE bookings SET status = 'failed' WHERE id = $1", [bookingId]);
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  await query(
    "UPDATE bookings SET status = 'paid', razorpay_payment_id = $1 WHERE id = $2",
    [razorpayPaymentId, bookingId]
  );

  const items = await issueTickets(pool, bookingId, booking.visit_date);

  res.json({ bookingId, items });
});

// List the logged-in user's bookings with their tickets, for a "my bookings" page
router.get('/mine', requireUser, async (req, res) => {
  const bookingsResult = await query(
    `SELECT b.id, b.visit_date, b.total_amount, b.status, b.created_at,
            (SELECT COALESCE(SUM(r.cash_amount + r.upi_amount + CASE WHEN r.razorpay_status = 'failed' THEN 0 ELSE r.razorpay_amount END), 0)
               FROM refunds r WHERE r.booking_id = b.id) AS refunded_amount
     FROM bookings b WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
    [req.userId]
  );

  const bookings = [];
  for (const booking of bookingsResult.rows) {
    const itemsResult = await query(
      `SELECT bi.id AS booking_item_id, g.key AS game_key, g.name AS game_name, g.image_url,
              gv.mode, gv.laps,
              t.id AS ticket_id, t.qr_token, t.status AS ticket_status
       FROM booking_items bi
       JOIN games g ON g.id = bi.game_id
       LEFT JOIN game_variants gv ON gv.id = bi.game_variant_id
       LEFT JOIN tickets t ON t.booking_item_id = bi.id
       WHERE bi.booking_id = $1
       ORDER BY bi.id, t.id`,
      [booking.id]
    );

    const itemsMap = new Map();
    for (const row of itemsResult.rows) {
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
      if (row.ticket_id) {
        itemsMap.get(row.booking_item_id).tickets.push({
          id: row.ticket_id,
          qrToken: row.qr_token,
          status: row.ticket_status,
        });
      }
    }

    bookings.push({ ...booking, items: Array.from(itemsMap.values()) });
  }

  res.json({ bookings });
});

module.exports = router;
