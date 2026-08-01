const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireUser } = require('../middleware/auth');
const { createOrder, verifyPayment } = require('../lib/razorpay');

const router = express.Router();

// Create a booking (multi-game cart) for today's visit date, and a Razorpay order to pay for it
router.post('/', requireUser, async (req, res) => {
  const { items } = req.body; // [{ gameKey, quantity }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  const gamesResult = await query('SELECT id, key, price_per_person FROM games WHERE is_active = true');
  const gamesByKey = Object.fromEntries(gamesResult.rows.map((g) => [g.key, g]));

  let total = 0;
  const resolvedItems = [];
  for (const item of items) {
    const game = gamesByKey[item.gameKey];
    const quantity = Number(item.quantity);
    if (!game || !Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: `Invalid item for gameKey ${item.gameKey}` });
    }
    total += Number(game.price_per_person) * quantity;
    resolvedItems.push({ gameId: game.id, quantity });
  }

  const bookingResult = await query(
    `INSERT INTO bookings (user_id, visit_date, total_amount, status)
     VALUES ($1, CURRENT_DATE, $2, 'pending') RETURNING id`,
    [req.userId, total]
  );
  const bookingId = bookingResult.rows[0].id;

  for (const item of resolvedItems) {
    await query(
      'INSERT INTO booking_items (booking_id, game_id, quantity) VALUES ($1, $2, $3)',
      [bookingId, item.gameId, item.quantity]
    );
  }

  const order = await createOrder({ amount: total, receipt: `booking_${bookingId}` });
  await query('UPDATE bookings SET razorpay_order_id = $1 WHERE id = $2', [order.id, bookingId]);

  res.status(201).json({
    bookingId,
    razorpayOrderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
  });
});

// Verify payment, mark booking paid, and generate one QR ticket per person per game
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

  const itemsResult = await query(
    `SELECT bi.id AS booking_item_id, bi.quantity, g.key AS game_key, g.name AS game_name
     FROM booking_items bi JOIN games g ON g.id = bi.game_id
     WHERE bi.booking_id = $1`,
    [bookingId]
  );

  const ticketsByGame = [];
  for (const item of itemsResult.rows) {
    const gameTickets = [];
    for (let i = 0; i < item.quantity; i += 1) {
      const qrToken = nanoid(24);
      const ticketResult = await query(
        `INSERT INTO tickets (booking_item_id, qr_token, visit_date, status)
         VALUES ($1, $2, $3, 'unused') RETURNING id, qr_token`,
        [item.booking_item_id, qrToken, booking.visit_date]
      );
      gameTickets.push(ticketResult.rows[0]);
    }
    ticketsByGame.push({ gameKey: item.game_key, gameName: item.game_name, tickets: gameTickets });
  }

  res.json({ bookingId, ticketsByGame });
});

// List the logged-in user's bookings with their tickets, for a "my tickets" page
router.get('/mine', requireUser, async (req, res) => {
  const bookingsResult = await query(
    "SELECT id, visit_date, total_amount, status, created_at FROM bookings WHERE user_id = $1 ORDER BY created_at DESC",
    [req.userId]
  );

  const bookings = [];
  for (const booking of bookingsResult.rows) {
    const itemsResult = await query(
      `SELECT bi.id AS booking_item_id, g.key AS game_key, g.name AS game_name,
              t.id AS ticket_id, t.qr_token, t.status AS ticket_status
       FROM booking_items bi
       JOIN games g ON g.id = bi.game_id
       LEFT JOIN tickets t ON t.booking_item_id = bi.id
       WHERE bi.booking_id = $1
       ORDER BY g.name, t.id`,
      [booking.id]
    );

    const gamesMap = new Map();
    for (const row of itemsResult.rows) {
      if (!gamesMap.has(row.game_key)) {
        gamesMap.set(row.game_key, { gameKey: row.game_key, gameName: row.game_name, tickets: [] });
      }
      if (row.ticket_id) {
        gamesMap.get(row.game_key).tickets.push({
          id: row.ticket_id,
          qrToken: row.qr_token,
          status: row.ticket_status,
        });
      }
    }

    bookings.push({ ...booking, ticketsByGame: Array.from(gamesMap.values()) });
  }

  res.json({ bookings });
});

module.exports = router;
