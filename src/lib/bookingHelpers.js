const { nanoid } = require('nanoid');
const { query } = require('../db');

// `minutes` comes from game_variants.laps, which now holds ride time in minutes (see migration 010).
function variantLabel(mode, minutes) {
  if (!mode) return null;
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  return `${modeLabel} · ${minutes} min`;
}

// Saturday/Sunday in India time. Tiers with a weekend_price charge it on these days.
function isWeekendToday(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(now);
  return day === 'Sat' || day === 'Sun';
}

// The price a tier costs today.
function variantPriceToday(variant, weekend = isWeekendToday()) {
  if (weekend && variant.weekend_price != null) return Number(variant.weekend_price);
  return Number(variant.price_per_person);
}

// Prices a cart of [{ gameKey, variantId?, quantity }] against the live catalog.
// Returns { total, resolvedItems } or { error } with a message suitable for a 400.
async function resolveCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'items must be a non-empty array' };
  }

  const gamesResult = await query('SELECT id, key, price_per_person FROM games WHERE is_active = true');
  const gamesByKey = Object.fromEntries(gamesResult.rows.map((g) => [g.key, g]));

  const variantsResult = await query('SELECT id, game_id, price_per_person, weekend_price FROM game_variants WHERE is_active = true');
  const weekend = isWeekendToday();
  const variantsById = Object.fromEntries(variantsResult.rows.map((v) => [String(v.id), v]));
  const gameHasVariants = new Set(variantsResult.rows.map((v) => v.game_id));

  let total = 0;
  const resolvedItems = [];
  for (const item of items) {
    const game = gamesByKey[item.gameKey];
    const quantity = Number(item.quantity);
    if (!game || !Number.isInteger(quantity) || quantity <= 0) {
      return { error: `Invalid item for gameKey ${item.gameKey}` };
    }

    let pricePerPerson;
    let variantId = null;
    if (gameHasVariants.has(game.id)) {
      const variant = item.variantId != null ? variantsById[String(item.variantId)] : null;
      if (!variant || variant.game_id !== game.id) {
        return { error: `A valid variantId is required for ${item.gameKey}` };
      }
      variantId = variant.id;
      pricePerPerson = variantPriceToday(variant, weekend);
    } else {
      pricePerPerson = Number(game.price_per_person);
    }

    total += pricePerPerson * quantity;
    resolvedItems.push({ gameId: game.id, variantId, quantity, unitPrice: pricePerPerson });
  }

  return { total, resolvedItems };
}

// Creates one QR ticket per person per booking line. `db` is the pool's query fn or a transaction client.
async function issueTickets(db, bookingId, visitDate) {
  const itemsResult = await db.query(
    `SELECT bi.id AS booking_item_id, bi.quantity, g.key AS game_key, g.name AS game_name, g.image_url,
            gv.mode, gv.laps
     FROM booking_items bi
     JOIN games g ON g.id = bi.game_id
     LEFT JOIN game_variants gv ON gv.id = bi.game_variant_id
     WHERE bi.booking_id = $1
     ORDER BY bi.id`,
    [bookingId]
  );

  const items = [];
  for (const item of itemsResult.rows) {
    const tickets = [];
    for (let i = 0; i < item.quantity; i += 1) {
      const qrToken = nanoid(24);
      const ticketResult = await db.query(
        `INSERT INTO tickets (booking_item_id, qr_token, visit_date, status)
         VALUES ($1, $2, $3, 'unused') RETURNING id, qr_token`,
        [item.booking_item_id, qrToken, visitDate]
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
  return items;
}

// Attach counter bookings made for this email/phone (before the customer had an account) to their account.
async function linkCounterBookings(userId, { email, phone }) {
  if (!email && !phone) return;
  await query(
    `UPDATE bookings SET user_id = $1
     WHERE user_id IS NULL AND source = 'counter'
       AND ((LOWER(customer_email) = LOWER($2) AND $2 IS NOT NULL) OR (customer_phone = $3 AND $3 IS NOT NULL))`,
    [userId, email || null, phone || null]
  );
}

module.exports = { variantLabel, resolveCart, issueTickets, linkCounterBookings, isWeekendToday, variantPriceToday };
