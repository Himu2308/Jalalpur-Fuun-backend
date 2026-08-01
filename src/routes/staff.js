const express = require('express');
const { query } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { destroyAllSessions } = require('../lib/sessions');

const router = express.Router();

// Admin creates a worker account: a UID + display name + the one game they can scan
router.post('/', requireAdmin, async (req, res) => {
  const { uid, name, role } = req.body;
  if (!uid || !role) {
    return res.status(400).json({ error: 'uid and role are required' });
  }

  try {
    const result = await query(
      'INSERT INTO staff (uid, name, role) VALUES ($1, $2, $3) RETURNING id, uid, name, role',
      [uid, name || null, role]
    );
    res.status(201).json({ staff: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'UID already exists' });
    throw err;
  }
});

router.get('/', requireAdmin, async (req, res) => {
  const result = await query('SELECT id, uid, name, role, created_at FROM staff ORDER BY created_at DESC');
  res.json({ staff: result.rows });
});

// Force-logout every active session for this worker (compromised UID, worker left, etc.)
router.post('/:id/revoke', requireAdmin, async (req, res) => {
  await destroyAllSessions('worker', req.params.id);
  res.json({ ok: true });
});

// Recent scan activity — which worker scanned which ticket, for the audit trail
router.get('/scans', requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT t.id, t.scanned_at, g.name AS game_name, s.uid AS staff_uid, s.name AS staff_name
     FROM tickets t
     JOIN booking_items bi ON bi.id = t.booking_item_id
     JOIN games g ON g.id = bi.game_id
     LEFT JOIN staff s ON s.id = t.scanned_by_staff_id
     WHERE t.status = 'used'
     ORDER BY t.scanned_at DESC
     LIMIT 100`
  );
  res.json({ scans: result.rows });
});

module.exports = router;
