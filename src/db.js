const { Pool } = require('pg');
const { logError } = require('./lib/log');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// An idle client throwing (e.g. the DB restarted) would otherwise crash the process.
pool.on('error', (err) => logError(`Postgres connection error: ${err.message}`));

function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
