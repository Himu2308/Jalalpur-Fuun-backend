const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { query } = require('../db');
const {
  createSession,
  destroySession,
  USER_TTL_SECONDS,
  WORKER_TTL_SECONDS,
  ADMIN_TTL_SECONDS,
} = require('../lib/sessions');
const { requireUser, requireWorker, requireAdmin } = require('../middleware/auth');
const { linkCounterBookings } = require('../lib/bookingHelpers');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Customer login via Google ID token (from Google Identity Services on the frontend)
router.post('/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken is required' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Google token' });
  }

  const { sub, email, name } = payload;

  const existing = await query('SELECT * FROM users WHERE google_sub = $1', [sub]);
  let user = existing.rows[0];

  if (!user) {
    const inserted = await query(
      'INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3) RETURNING *',
      [sub, email, name]
    );
    user = inserted.rows[0];
  }

  // Tickets bought at the counter with this email/phone before the customer had an account show up now.
  await linkCounterBookings(user.id, { email: user.email, phone: user.phone });

  const token = await createSession('user', user.id, {}, USER_TTL_SECONDS);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, phone: user.phone } });
});

router.post('/logout', requireUser, async (req, res) => {
  await destroySession('user', req.userId, req.sid);
  res.json({ ok: true });
});

// Collect/update phone number for the logged-in user (one-time step after Google login)
router.post('/phone', requireUser, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const result = await query(
    'UPDATE users SET phone = $1 WHERE id = $2 RETURNING id, email, name, phone',
    [phone, req.userId]
  );
  await linkCounterBookings(req.userId, { phone });
  res.json({ user: result.rows[0] });
});

// Worker login: UID only, no password. A worker can only scan tickets for their assigned game.
router.post('/worker-login', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid is required' });

  const result = await query('SELECT * FROM staff WHERE uid = $1', [uid]);
  const worker = result.rows[0];
  if (!worker) return res.status(401).json({ error: 'Invalid UID' });

  const token = await createSession('worker', worker.id, { role: worker.role }, WORKER_TTL_SECONDS);
  res.json({ token, worker: { id: worker.id, uid: worker.uid, name: worker.name, role: worker.role } });
});

router.post('/worker-logout', requireWorker, async (req, res) => {
  await destroySession('worker', req.workerId, req.sid);
  res.json({ ok: true });
});

// Admin login: a single shared password (ADMIN_PASSWORD env var) — no individual admin accounts.
router.post('/admin-login', async (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = await createSession('admin', 'shared', {}, ADMIN_TTL_SECONDS);
  res.json({ token });
});

router.post('/admin-logout', requireAdmin, async (req, res) => {
  await destroySession('admin', 'shared', req.sid);
  res.json({ ok: true });
});

module.exports = router;
