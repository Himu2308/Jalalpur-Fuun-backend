const express = require('express');
const { query } = require('../db');

const router = express.Router();
const LEVELS = new Set(['beginner', 'medium', 'expert']);

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').trim();
}

function normalizeName(name) {
  return String(name || '').trim();
}

function nameKey(name) {
  return normalizeName(name).toLowerCase();
}

function serialize(row) {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    rideCount: row.ride_count,
    level: row.level,
    lastRideAt: row.last_ride_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const headers = ['phone', 'name', 'ride_count', 'level', 'last_ride_at', 'created_at', 'updated_at'];
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.phone,
        row.name,
        row.ride_count,
        row.level,
        row.last_ride_at ? row.last_ride_at.toISOString() : '',
        row.created_at ? row.created_at.toISOString() : '',
        row.updated_at ? row.updated_at.toISOString() : '',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\n');
}

router.get('/', async (req, res) => {
  const result = await query(
    `SELECT id, phone, name, ride_count, level, last_ride_at, created_at, updated_at
     FROM user_logs
     ORDER BY updated_at DESC
     LIMIT 100`
  );
  res.json({ logs: result.rows.map(serialize) });
});

router.get('/export', async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ''))) {
    return res.status(400).json({ error: 'Start date and end date must be YYYY-MM-DD' });
  }
  if (String(startDate) > String(endDate)) {
    return res.status(400).json({ error: 'Start date cannot be after end date' });
  }

  const result = await query(
    `SELECT phone, name, ride_count, level, last_ride_at, created_at, updated_at
     FROM user_logs
     WHERE (last_ride_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
        OR (updated_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
        OR (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
     ORDER BY updated_at DESC`,
    [startDate, endDate]
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="user-logs-${startDate}-to-${endDate}.csv"`);
  res.send(toCsv(result.rows));
});

router.post('/search', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone number must be exactly 10 digits' });
  }

  const result = await query(
    `SELECT id, phone, name, ride_count, level, last_ride_at, created_at, updated_at
     FROM user_logs
     WHERE phone = $1
     ORDER BY updated_at DESC`,
    [phone]
  );

  res.json({ phone, logs: result.rows.map(serialize) });
});

router.patch('/:id', async (req, res) => {
  const { name, level } = req.body;

  if (level && !LEVELS.has(level)) {
    return res.status(400).json({ error: 'Level must be beginner, medium, or expert' });
  }

  const result = await query(
    `UPDATE user_logs
     SET name = COALESCE($1, name),
         level = COALESCE($2, level),
         updated_at = now()
     WHERE id = $3
     RETURNING id, phone, name, ride_count, level, last_ride_at, created_at, updated_at`,
    [
      name === undefined ? null : String(name).trim() || null,
      level || null,
      req.params.id,
    ]
  );

  if (!result.rows[0]) return res.status(404).json({ error: 'User log not found' });
  res.json({ log: serialize(result.rows[0]) });
});

router.post('/save-ride', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = normalizeName(req.body.name);
  const key = nameKey(name);
  const level = req.body.level || 'beginner';

  if (!/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone number must be exactly 10 digits' });
  }
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!LEVELS.has(level)) {
    return res.status(400).json({ error: 'Level must be beginner, medium, or expert' });
  }

  const result = await query(
    `INSERT INTO user_logs (phone, name, name_key, level, ride_count, last_ride_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, now(), now())
     ON CONFLICT (phone, name_key) DO UPDATE
       SET name = EXCLUDED.name,
           level = EXCLUDED.level,
           ride_count = user_logs.ride_count + 1,
           last_ride_at = now(),
           updated_at = now()
     RETURNING id, phone, name, ride_count, level, last_ride_at, created_at, updated_at`,
    [phone, name, key, level]
  );

  res.json({ log: serialize(result.rows[0]) });
});

router.post('/:id/rides', async (req, res) => {
  const incrementBy = Number(req.body.incrementBy || 1);
  if (!Number.isInteger(incrementBy) || incrementBy < 1) {
    return res.status(400).json({ error: 'Increment must be a positive whole number' });
  }

  const result = await query(
    `UPDATE user_logs
     SET ride_count = ride_count + $1,
         last_ride_at = now(),
         updated_at = now()
     WHERE id = $2
     RETURNING id, phone, name, ride_count, level, last_ride_at, created_at, updated_at`,
    [incrementBy, req.params.id]
  );

  if (!result.rows[0]) return res.status(404).json({ error: 'User log not found' });
  res.json({ log: serialize(result.rows[0]) });
});

module.exports = router;
