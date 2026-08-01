const { verifyToken, getSession } = require('../lib/sessions');

function getToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.cookies && req.cookies.token;
}

async function requireUser(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = verifyToken(token);
    if (payload.kind !== 'user') return res.status(401).json({ error: 'Not a user session' });
    const session = await getSession(payload.sid);
    if (!session) return res.status(401).json({ error: 'Session expired or revoked' });
    req.userId = payload.id;
    req.sid = payload.sid;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Workers log in with just a UID (no password) and can only scan tickets for their assigned game.
async function requireWorker(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = verifyToken(token);
    if (payload.kind !== 'worker') return res.status(401).json({ error: 'Not a worker session' });
    const session = await getSession(payload.sid);
    if (!session) return res.status(401).json({ error: 'Session expired or revoked' });
    req.workerId = payload.id;
    req.workerRole = session.role;
    req.sid = payload.sid;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Admin is a single shared password (ADMIN_PASSWORD), not tied to any staff account.
async function requireAdmin(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = verifyToken(token);
    if (payload.kind !== 'admin') return res.status(401).json({ error: 'Not an admin session' });
    const session = await getSession(payload.sid);
    if (!session) return res.status(401).json({ error: 'Session expired or revoked' });
    req.sid = payload.sid;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Ticket scanning is allowed for a worker (their assigned game only) OR the shared
// admin session (any game) — this sets req.isAdmin so the route can branch on it.
async function requireWorkerOrAdmin(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = verifyToken(token);
    if (payload.kind !== 'worker' && payload.kind !== 'admin') {
      return res.status(401).json({ error: 'Not authorized to scan' });
    }
    const session = await getSession(payload.sid);
    if (!session) return res.status(401).json({ error: 'Session expired or revoked' });

    req.isAdmin = payload.kind === 'admin';
    req.workerId = req.isAdmin ? null : payload.id;
    req.workerRole = req.isAdmin ? null : session.role;
    req.sid = payload.sid;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { requireUser, requireWorker, requireAdmin, requireWorkerOrAdmin };
