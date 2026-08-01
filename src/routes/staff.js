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

// Recent scan activity — permanent audit trail, independent of the ticket's current status
router.get('/scans', requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT id, game_name, scanned_by_uid, customer_name, customer_phone, customer_email, scanned_at
     FROM scan_logs
     ORDER BY scanned_at DESC
     LIMIT 100`
  );
  res.json({ scans: result.rows });
});

module.exports = router;
