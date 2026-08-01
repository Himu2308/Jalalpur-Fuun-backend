-- Permanent scan audit trail. Deliberately denormalized (game name, worker UID, customer
-- phone/email captured as they were at scan time) so this history stays accurate and complete
-- even if the ticket's own status changes later, or the staff/customer records are edited.
CREATE TABLE IF NOT EXISTS scan_logs (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id),
  game_name TEXT NOT NULL,
  scanned_by_staff_id BIGINT REFERENCES staff(id),
  scanned_by_uid TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_logs_ticket_id ON scan_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at DESC);
