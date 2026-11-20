const express = require('express');
const { query } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { isWeekendToday, variantPriceToday } = require('../lib/bookingHelpers');

const router = express.Router();

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

router.get('/', async (req, res) => {
  const gamesResult = await query(
    'SELECT id, key, name, price_per_person, image_url FROM games WHERE is_active = true ORDER BY sort_order, name'
  );
  const variantsResult = await query(
    `SELECT id, game_id, mode, laps, price_per_person, weekend_price, package_name FROM game_variants
     WHERE is_active = true ORDER BY mode, laps`
  );
  const weekend = isWeekendToday();

  const variantsByGameId = new Map();
  for (const v of variantsResult.rows) {
    if (!variantsByGameId.has(v.game_id)) variantsByGameId.set(v.game_id, []);
    variantsByGameId.get(v.game_id).push({
      id: v.id,
      mode: v.mode,
      minutes: v.laps, // column is still named laps; it stores minutes
      packageName: v.package_name,
      pricePerPerson: variantPriceToday(v, weekend), // what it costs today (per kart for double seater)
      weekdayPrice: Number(v.price_per_person),
      weekendPrice: v.weekend_price == null ? null : Number(v.weekend_price),
    });
  }

  const games = gamesResult.rows.map((g) => ({ ...g, isWeekend: weekend, variants: variantsByGameId.get(g.id) || [] }));
  res.json({ games });
});

// Admin adds a new activity to the catalog (flat-priced; variants can be added afterward)
router.post('/', requireAdmin, async (req, res) => {
  const { name, pricePerPerson, imageUrl } = req.body;
  const price = Number(pricePerPerson);
  if (!name || !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'name and a positive pricePerPerson are required' });
  }

  const baseKey = slugify(name);
  if (!baseKey) return res.status(400).json({ error: 'name must contain at least one letter or number' });

  let key = baseKey;
  let suffix = 1;
  // Keep the base slug if free; otherwise disambiguate (e.g. two activities both named "Racing").
  while ((await query('SELECT 1 FROM games WHERE key = $1', [key])).rows.length > 0) {
    suffix += 1;
    key = `${baseKey}_${suffix}`;
  }

  const nextSort = await query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM games');

  const result = await query(
    'INSERT INTO games (key, name, price_per_person, image_url, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id, key, name, price_per_person, image_url',
    [key, name, price, imageUrl || null, nextSort.rows[0].next]
  );
  res.status(201).json({ game: { ...result.rows[0], variants: [] } });
});

// Admin permanently deletes an activity only when it has no booking history.
// Booked activities are protected because deleting them would break old tickets.
router.delete('/:id', requireAdmin, async (req, res) => {
  const existing = await query('SELECT id, key, name FROM games WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Activity not found' });

  const bookingCount = await query(
    'SELECT COUNT(*)::int AS count FROM booking_items WHERE game_id = $1',
    [req.params.id]
  );
  if (bookingCount.rows[0].count > 0) {
    return res.status(409).json({
      error: 'This activity has booking history and cannot be permanently deleted. Existing tickets must be preserved.',
    });
  }

  const result = await query('DELETE FROM games WHERE id = $1 RETURNING id, key, name', [req.params.id]);
  res.json({ ok: true, activity: result.rows[0] });
});

// Admin edits the customer-facing activity details. The stable key is deliberately
// not changed because staff roles and historical integrations use it.
router.patch('/:id', requireAdmin, async (req, res) => {
  const { name, pricePerPerson, imageUrl } = req.body;
  const price = Number(pricePerPerson);
  if (!name || !name.trim() || !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'name and a positive pricePerPerson are required' });
  }

  const result = await query(
    `UPDATE games
     SET name = $1, price_per_person = $2, image_url = $3
     WHERE id = $4
     RETURNING id, key, name, price_per_person, image_url`,
    [name.trim(), price, imageUrl?.trim() || null, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Activity not found' });
  res.json({ game: result.rows[0] });
});

// Validates a tier from the admin form: { mode, minutes, pricePerPerson (weekday), weekendPrice?, packageName? }
function parseVariant(body) {
  const mode = String(body.mode || '').trim();
  const minutes = Number(body.minutes ?? body.laps);
  const price = Number(body.pricePerPerson);
  const hasWeekend = body.weekendPrice !== undefined && body.weekendPrice !== null && body.weekendPrice !== '';
  const weekendPrice = hasWeekend ? Number(body.weekendPrice) : null;
  const packageName = body.packageName ? String(body.packageName).trim().slice(0, 40) || null : null;

  if (!mode || !Number.isInteger(minutes) || minutes <= 0 || !Number.isFinite(price) || price <= 0) {
    return { error: 'mode, a positive whole number of minutes, and a positive weekday price are required' };
  }
  if (hasWeekend && (!Number.isFinite(weekendPrice) || weekendPrice <= 0)) {
    return { error: 'Weekend price must be a positive number (or left empty to use the weekday price)' };
  }
  return { mode, minutes, price, weekendPrice, packageName };
}

const VARIANT_RETURNING =
  'RETURNING id, mode, laps AS minutes, price_per_person, weekend_price, package_name';

// Admin adds a priced tier (mode + ride time in minutes) to an existing game
router.post('/:id/variants', requireAdmin, async (req, res) => {
  const v = parseVariant(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const gameResult = await query('SELECT id FROM games WHERE id = $1', [req.params.id]);
  if (!gameResult.rows[0]) return res.status(404).json({ error: 'Game not found' });

  const result = await query(
    `INSERT INTO game_variants (game_id, mode, laps, price_per_person, weekend_price, package_name)
     VALUES ($1, $2, $3, $4, $5, $6) ${VARIANT_RETURNING}`,
    [req.params.id, v.mode, v.minutes, v.price, v.weekendPrice, v.packageName]
  );
  res.status(201).json({ variant: result.rows[0] });
});

// Admin edits a tier. Past bookings keep the price they were sold at (booking_items.unit_price).
router.patch('/:id/variants/:variantId', requireAdmin, async (req, res) => {
  const v = parseVariant(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const result = await query(
    `UPDATE game_variants
     SET mode = $1, laps = $2, price_per_person = $3, weekend_price = $4, package_name = $5
     WHERE id = $6 AND game_id = $7 AND is_active = true
     ${VARIANT_RETURNING}`,
    [v.mode, v.minutes, v.price, v.weekendPrice, v.packageName, req.params.variantId, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Pricing tier not found' });
  res.json({ variant: result.rows[0] });
});

// Admin removes a variant (soft delete — keeps price history for past bookings intact)
router.delete('/:id/variants/:variantId', requireAdmin, async (req, res) => {
  await query('UPDATE game_variants SET is_active = false WHERE id = $1 AND game_id = $2', [
    req.params.variantId,
    req.params.id,
  ]);
  res.json({ ok: true });
});

module.exports = router;
