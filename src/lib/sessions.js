const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { client: redis } = require('../redis');

const SECRET = process.env.JWT_SECRET;
const USER_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const WORKER_TTL_SECONDS = 24 * 60 * 60; // 1 day
const ADMIN_TTL_SECONDS = 24 * 60 * 60; // 1 day

function indexKey(kind, id) {
  return `sessions:${kind}:${id}`;
}

// Signs a JWT carrying only {kind, id, sid} and records the session in Redis
// so it can be looked up (and force-revoked) independently of the JWT's own expiry.
async function createSession(kind, id, extra, ttlSeconds) {
  const sid = nanoid();
  const token = jwt.sign({ kind, id, sid }, SECRET, { expiresIn: ttlSeconds });
  await redis.set(`session:${sid}`, JSON.stringify({ kind, id, ...extra }), { EX: ttlSeconds });
  await redis.sAdd(indexKey(kind, id), sid);
  return token;
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

async function getSession(sid) {
  const raw = await redis.get(`session:${sid}`);
  return raw ? JSON.parse(raw) : null;
}

async function destroySession(kind, id, sid) {
  await redis.del(`session:${sid}`);
  await redis.sRem(indexKey(kind, id), sid);
}

// Force-logout every device/session for a given user or staff account
// (e.g. a staff UID was compromised or the worker no longer works here).
async function destroyAllSessions(kind, id) {
  const sids = await redis.sMembers(indexKey(kind, id));
  if (sids.length > 0) {
    await redis.del(sids.map((sid) => `session:${sid}`));
  }
  await redis.del(indexKey(kind, id));
}

module.exports = {
  createSession,
  verifyToken,
  getSession,
  destroySession,
  destroyAllSessions,
  USER_TTL_SECONDS,
  WORKER_TTL_SECONDS,
  ADMIN_TTL_SECONDS,
};
