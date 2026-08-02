const express = require('express');
const { query } = require('../db');
const { requireWorkerOrAdmin } = require('../middleware/auth');

const router = express.Router();

// Worker scans a QR code for their assigned game; admin can scan and validate any game's ticket.
router.post('/scan', requireWorkerOrAdmin, async (req, res) => {
  const { qrToken } = req.body;
  if (!qrToken) return res.status(400).json({ error: 'qrToken is required' });

  const normalizedToken = String(qrToken).trim().replace(/^#/, '');
  if (!normalizedToken) return res.status(400).json({ error: 'Enter a valid ticket code' });

  // The customer ticket displays the final 8 characters as a human-readable fallback.
  // Only admins may validate using that shortened code; workers must scan the full QR token.
  const isShortCode = normalizedToken.length <= 8;
  if (isShortCode && !req.isAdmin) {
    return res.status(400).json({ error: 'Staff must scan the full QR code' });
  }

  const result = await query(
    `SELECT t.id, t.status, t.visit_date, g.key AS game_key, g.name AS game_name,
            u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
     FROM tickets t
     JOIN booking_items bi ON bi.id = t.booking_item_id
     JOIN games g ON g.id = bi.game_id
     JOIN bookings b ON b.id = bi.booking_id
     JOIN users u ON u.id = b.user_id
     WHERE ${isShortCode ? 'LOWER(RIGHT(t.qr_token, 8)) = LOWER($1)' : 't.qr_token = $1'}
     LIMIT 2`,
    [normalizedToken]
  );

  if (result.rows.length > 1) {
    return res.status(409).json({
      ok: false,
      reason: 'ambiguous_code',
      message: 'This short code matches multiple tickets. Scan the QR code instead.',
    });
  }
  const ticket = result.rows[0];

  if (!ticket) {
    return res.status(404).json({ ok: false, reason: 'not_found', message: 'Ticket not found' });
  }

  if (!req.isAdmin && req.workerRole !== ticket.game_key) {
    return res.status(403).json({
      ok: false,
      reason: 'wrong_role',
      message: `This ticket is for ${ticket.game_name}, not your assigned activity`,
    });
  }

  const isToday = new Date(ticket.visit_date).toDateString() === new Date().toDateString();
  if (!isToday || ticket.status === 'expired') {
    if (ticket.status === 'unused') {
      await query("UPDATE tickets SET status = 'expired' WHERE id = $1", [ticket.id]);
    }
    return res.status(410).json({ ok: false, reason: 'expired', message: 'Ticket has expired' });
  }

  if (ticket.status === 'used') {
    return res.status(409).json({ ok: false, reason: 'already_used', message: 'Ticket already scanned' });
  }

  // Admin scans have no worker identity behind them, so scanned_by_staff_id/uid stay NULL for those.
  let workerUid = null;
  if (!req.isAdmin) {
    const workerResult = await query('SELECT uid FROM staff WHERE id = $1', [req.workerId]);
    workerUid = workerResult.rows[0]?.uid || null;
  }

  await query(
    "UPDATE tickets SET status = 'used', scanned_by_staff_id = $1, scanned_at = now() WHERE id = $2",
    [req.isAdmin ? null : req.workerId, ticket.id]
  );

  await query(
    `INSERT INTO scan_logs
       (ticket_id, game_name, scanned_by_staff_id, scanned_by_uid, customer_name, customer_phone, customer_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ticket.id,
      ticket.game_name,
      req.isAdmin ? null : req.workerId,
      workerUid,
      ticket.customer_name,
      ticket.customer_phone,
      ticket.customer_email,
    ]
  );

  res.json({ ok: true, gameKey: ticket.game_key, gameName: ticket.game_name });
});

module.exports = router;
