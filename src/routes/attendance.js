const express = require('express');
const { query, pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const STATUSES = new Set(['present', 'absent', 'half_day', 'leave', 'week_off']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const ATTENDANCE_COLUMNS = `a.status, TO_CHAR(a.check_in, 'HH24:MI') AS check_in,
  TO_CHAR(a.check_out, 'HH24:MI') AS check_out, a.note`;

function isValidDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Daily register: every worker with their attendance for that date (null = not marked yet).
router.get('/', requireAdmin, async (req, res) => {
  const { date } = req.query;
  if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const result = await query(
    `SELECT s.id AS staff_id, s.uid, s.name, s.role, ${ATTENDANCE_COLUMNS}
     FROM staff s
     LEFT JOIN attendance a ON a.staff_id = s.id AND a.date = $1
     ORDER BY s.uid`,
    [date]
  );
  res.json({ date, workers: result.rows });
});

// Save the register for one date in one go. An entry with status null clears that worker's mark.
router.put('/', requireAdmin, async (req, res) => {
  const { date, entries } = req.body;
  if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  // One day of slack so a server running on UTC still accepts "today" in India.
  const futureCheck = await query('SELECT $1::date > CURRENT_DATE + 1 AS is_future', [date]);
  if (futureCheck.rows[0].is_future) return res.status(400).json({ error: 'Attendance cannot be marked for a future date' });
  if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: 'entries must be a non-empty array' });

  for (const entry of entries) {
    if (!/^\d+$/.test(String(entry.staffId))) return res.status(400).json({ error: 'Each entry needs a staffId' });
    if (entry.status != null && !STATUSES.has(entry.status)) return res.status(400).json({ error: `Unknown status ${entry.status}` });
    for (const field of ['checkIn', 'checkOut']) {
      if (entry[field] && !TIME_RE.test(entry[field])) return res.status(400).json({ error: `${field} must be HH:MM` });
    }
    if (entry.checkIn && entry.checkOut && entry.checkOut <= entry.checkIn) {
      return res.status(400).json({ error: 'Out time must be after in time' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      if (entry.status == null) {
        await client.query('DELETE FROM attendance WHERE staff_id = $1 AND date = $2', [entry.staffId, date]);
        continue;
      }
      // Times only make sense when the worker actually came in.
      const worked = entry.status === 'present' || entry.status === 'half_day';
      await client.query(
        `INSERT INTO attendance (staff_id, date, status, check_in, check_out, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (staff_id, date) DO UPDATE SET
           status = EXCLUDED.status, check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out,
           note = EXCLUDED.note, updated_at = now()`,
        [
          entry.staffId,
          date,
          entry.status,
          worked ? entry.checkIn || null : null,
          worked ? entry.checkOut || null : null,
          entry.note ? String(entry.note).trim().slice(0, 200) || null : null,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(400).json({ error: 'Unknown worker in entries' });
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true });
});

// Monthly report: every worker's marks for the month plus per-status totals.
router.get('/month', requireAdmin, async (req, res) => {
  const { month } = req.query;
  if (!MONTH_RE.test(String(month || ''))) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const start = `${month}-01`;

  const [staffResult, marksResult] = await Promise.all([
    query('SELECT id, uid, name, role FROM staff ORDER BY uid'),
    query(
      `SELECT a.staff_id, TO_CHAR(a.date, 'YYYY-MM-DD') AS date, ${ATTENDANCE_COLUMNS}
       FROM attendance a
       WHERE a.date >= $1::date AND a.date < ($1::date + INTERVAL '1 month')
       ORDER BY a.date`,
      [start]
    ),
  ]);

  const byStaff = new Map(staffResult.rows.map((s) => [String(s.id), {
    staffId: s.id,
    uid: s.uid,
    name: s.name,
    role: s.role,
    days: {},
    totals: { present: 0, absent: 0, half_day: 0, leave: 0, week_off: 0, daysWorked: 0 },
  }]));

  for (const mark of marksResult.rows) {
    const worker = byStaff.get(String(mark.staff_id));
    if (!worker) continue;
    worker.days[mark.date] = { status: mark.status, checkIn: mark.check_in, checkOut: mark.check_out, note: mark.note };
    worker.totals[mark.status] += 1;
  }
  for (const worker of byStaff.values()) {
    worker.totals.daysWorked = worker.totals.present + worker.totals.half_day * 0.5;
  }

  res.json({ month, workers: Array.from(byStaff.values()) });
});

module.exports = router;
