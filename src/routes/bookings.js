const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireUser } = require('../middleware/auth');
const { createOrder, verifyPayment } = require('../lib/razorpay');

const router = express.Router();

function variantLabel(mode, laps) {
  if (!mode) return null;
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  return `${modeLabel} · ${laps} Laps`;
}

// Create a booking (multi-game, multi-variant cart) for today's visit date, and a Razorpay order to pay for it
router.post('/', requireUser, async (req, res) => {
  const { items } = req.body; // [{ gameKey, variantId?, quantity }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  const gamesResult = await query('SELECT id, key, price_per_person FROM games WHERE is_active = true');
  const gamesByKey = Object.fromEntries(gamesResult.rows.map((g) => [g.key, g]));

  const variantsResult = await query('SELECT id, game_id, price_per_person FROM game_variants WHERE is_active = true');
  const variantsById = Object.fromEntries(variantsResult.rows.map((v) => [String(v.id), v]));
  const gameHasVariants = new Set(variantsResult.rows.map((v) => v.game_id));

  let total = 0;
  const resolvedItems = [];
  for (const item of items) {
    const game = gamesByKey[item.gameKey];
    const quantity = Number(item.quantity);
    if (!game || !Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: `Invalid item for gameKey ${item.gameKey}` });
    }

    let pricePerPerson;
    let variantId = null;
    if (gameHasVariants.has(game.id)) {
      const variant = item.variantId != null ? variantsById[String(item.variantId)] : null;
      if (!variant || variant.game_id !== game.id) {
        return res.status(400).json({ error: `A valid variantId is required for ${item.gameKey}` });
      }
      variantId = variant.id;
      pricePerPerson = Number(variant.price_per_person);
    } else {
      pricePerPerson = Number(game.price_per_person);
    }

    total += pricePerPerson * quantity;
    resolvedItems.push({ gameId: game.id, variantId, quantity });
  }

  const bookingResult = await query(
    `INSERT INTO bookings (user_id, visit_date, total_amount, status)
     VALUES ($1, CURRENT_DATE, $2, 'pending') RETURNING id`,
    [req.userId, total]
  );
  const bookingId = bookingResult.rows[0].id;

  for (const item of resolvedItems) {
    await query(
      'INSERT INTO booking_items (booking_id, game_id, game_variant_id, quantity) VALUES ($1, $2, $3, $4)',
      [bookingId, item.gameId, item.variantId, item.quantity]
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

  const itemsResult = await query(
    `SELECT bi.id AS booking_item_id, bi.quantity, g.key AS game_key, g.name AS game_name, g.image_url,
            gv.mode, gv.laps
     FROM booking_items bi
     JOIN games g ON g.id = bi.game_id
     LEFT JOIN game_variants gv ON gv.id = bi.game_variant_id
     WHERE bi.booking_id = $1`,
    [bookingId]
  );

  const items = [];
  for (const item of itemsResult.rows) {
    const tickets = [];
    for (let i = 0; i < item.quantity; i += 1) {
      const qrToken = nanoid(24);
      const ticketResult = await query(
        `INSERT INTO tickets (booking_item_id, qr_token, visit_date, status)
         VALUES ($1, $2, $3, 'unused') RETURNING id, qr_token`,
        [item.booking_item_id, qrToken, booking.visit_date]
      );
      tickets.push(ticketResult.rows[0]);
    }
    items.push({
      bookingItemId: item.booking_item_id,
      gameKey: item.game_key,
      gameName: item.game_name,
      imageUrl: item.image_url,
      variantLabel: variantLabel(item.mode, item.laps),
      tickets,
    });
  }

  res.json({ bookingId, items });
});

// List the logged-in user's bookings with their tickets, for a "my bookings" page
router.get('/mine', requireUser, async (req, res) => {
  const bookingsResult = await query(
    "SELECT id, visit_date, total_amount, status, created_at FROM bookings WHERE user_id = $1 ORDER BY created_at DESC",
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
