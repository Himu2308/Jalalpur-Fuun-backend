const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { client: redisClient } = require('./redis');
const { query } = require('./db');
const { logSuccess, logError } = require('./lib/log');

const authRoutes = require('./routes/auth');
const gamesRoutes = require('./routes/games');
const bookingsRoutes = require('./routes/bookings');
const ticketsRoutes = require('./routes/tickets');
const staffRoutes = require('./routes/staff');
const userLogsRoutes = require('./routes/userLogs');
const counterRoutes = require('./routes/counter');
const attendanceRoutes = require('./routes/attendance');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/games', gamesRoutes);
app.use('/bookings', bookingsRoutes);
app.use('/tickets', ticketsRoutes);
app.use('/staff', staffRoutes);
app.use('/user-logs', userLogsRoutes);
app.use('/counter', counterRoutes);
app.use('/attendance', attendanceRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;

async function start() {
  try {
    await query('SELECT 1');
    logSuccess('Postgres connected');
  } catch (err) {
    logError(`Postgres connection failed: ${err.message}`);
    process.exit(1);
  }

  try {
    await redisClient.connect();
  } catch (err) {
    logError(`Redis connection failed: ${err.message}`);
    process.exit(1);
  }

  app.listen(port, () => logSuccess(`Backend listening on port ${port}`));
}

start();
