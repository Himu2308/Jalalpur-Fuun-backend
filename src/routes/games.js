const express = require('express');
const { query } = require('../db');
const { requireAdmin } = require('../middleware/auth');

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
    `SELECT id, game_id, mode, laps, price_per_person FROM game_variants
     WHERE is_active = true ORDER BY mode, laps`
  );

  const variantsByGameId = new Map();
  for (const v of variantsResult.rows) {
    if (!variantsByGameId.has(v.game_id)) variantsByGameId.set(v.game_id, []);
    variantsByGameId.get(v.game_id).push({
      id: v.id,
      mode: v.mode,
      minutes: v.laps, // column is still named laps; it stores minutes
      pricePerPerson: v.price_per_person,
    });
  }

  const games = gamesResult.rows.map((g) => ({ ...g, variants: variantsByGameId.get(g.id) || [] }));
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

// Admin adds a priced variant (mode + ride time in minutes) to an existing game
router.post('/:id/variants', requireAdmin, async (req, res) => {
  const { mode, pricePerPerson } = req.body;
  const minutes = Number(req.body.minutes ?? req.body.laps);
  const price = Number(pricePerPerson);

  if (!mode || !Number.isInteger(minutes) || minutes <= 0 || !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'mode, a positive whole number of minutes, and a positive pricePerPerson are required' });
  }

  const gameResult = await query('SELECT id FROM games WHERE id = $1', [req.params.id]);
  if (!gameResult.rows[0]) return res.status(404).json({ error: 'Game not found' });

  const result = await query(
    'INSERT INTO game_variants (game_id, mode, laps, price_per_person) VALUES ($1, $2, $3, $4) RETURNING id, mode, laps AS minutes, price_per_person',
    [req.params.id, mode, minutes, price]
  );
  res.status(201).json({ variant: result.rows[0] });
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
