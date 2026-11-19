-- Walk-in (counter) sales: staff or admin sell tickets on behalf of a customer who pays cash and/or UPI.
-- A counter booking may have no app account yet (user_id NULL); it is linked to the customer's account
-- automatically when someone logs in with the same email or adds the same phone number.
ALTER TABLE bookings ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'online'; -- online | counter
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sold_by_staff_id BIGINT REFERENCES staff(id); -- NULL on a counter sale = admin
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT; -- counter only: cash | upi | split
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cash_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS upi_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS upi_ref TEXT;

CREATE INDEX IF NOT EXISTS bookings_unlinked_email_idx ON bookings (LOWER(customer_email)) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS bookings_unlinked_phone_idx ON bookings (customer_phone) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS bookings_source_visit_idx ON bookings (source, visit_date);
