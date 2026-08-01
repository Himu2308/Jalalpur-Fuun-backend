-- Workers now authenticate with just a UID (no password); admin access is a single
-- shared password (ADMIN_PASSWORD env var), not a staff account, so the old
-- role='admin' bootstrap rows and the now-unused password column are dropped.
DELETE FROM staff WHERE role = 'admin';
ALTER TABLE staff DROP COLUMN IF EXISTS password_hash;
