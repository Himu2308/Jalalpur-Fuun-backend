const express = require('express');
const { query } = require('../db');
const { requireWorkerOrAdmin } = require('../middleware/auth');

const router = express.Router();

// Worker scans a QR code for their assigned game; admin can scan and validate any game's ticket.
router.post('/scan', requireWorkerOrAdmin, async (req, res) => {
  const { qrToken } = req.body;
  if (!qrToken) return res.status(400).json({ error: 'qrToken is required' });

  const result = await query(
    `SELECT t.id, t.status, t.visit_date, g.key AS game_key, g.name AS game_name
     FROM tickets t
     JOIN booking_items bi ON bi.id = t.booking_item_id
     JOIN games g ON g.id = bi.game_id
     WHERE t.qr_token = $1`,
    [qrToken]
  );
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

  // Admin scans have no worker identity behind them, so scanned_by_staff_id stays NULL for those.
  await query(
    "UPDATE tickets SET status = 'used', scanned_by_staff_id = $1, scanned_at = now() WHERE id = $2",
    [req.isAdmin ? null : req.workerId, ticket.id]
  );

  res.json({ ok: true, gameKey: ticket.game_key, gameName: ticket.game_name });
});

module.exports = router;
