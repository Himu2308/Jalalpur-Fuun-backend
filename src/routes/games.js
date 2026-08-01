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
  const result = await query(
    'SELECT id, key, name, price_per_person, image_url FROM games WHERE is_active = true ORDER BY name'
  );
  res.json({ games: result.rows });
});

// Admin adds a new activity to the catalog
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

  const result = await query(
    'INSERT INTO games (key, name, price_per_person, image_url) VALUES ($1, $2, $3, $4) RETURNING id, key, name, price_per_person, image_url',
    [key, name, price, imageUrl || null]
  );
  res.status(201).json({ game: result.rows[0] });
});

module.exports = router;
