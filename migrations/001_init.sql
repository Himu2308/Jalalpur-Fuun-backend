-- Customers (Gmail + phone login)
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Staff / admin accounts. role = 'admin' or a games.key value (e.g. 'gokarting')
CREATE TABLE IF NOT EXISTS staff (
  id BIGSERIAL PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Activity/game catalog
CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_per_person NUMERIC(10, 2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- One booking = one checkout/payment, can contain multiple games (multi-game cart)
CREATE TABLE IF NOT EXISTS bookings (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  visit_date DATE NOT NULL,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  total_amount NUMERIC(10, 2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per game within a booking
CREATE TABLE IF NOT EXISTS booking_items (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  game_id BIGINT NOT NULL REFERENCES games(id),
  quantity INT NOT NULL CHECK (quantity > 0)
);

-- One row per person per game = one QR code
CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  booking_item_id BIGINT NOT NULL REFERENCES booking_items(id) ON DELETE CASCADE,
  qr_token TEXT UNIQUE NOT NULL,
  visit_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused', -- unused | used | expired
  scanned_by_staff_id BIGINT REFERENCES staff(id),
  scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking_id ON booking_items(booking_id);
CREATE INDEX IF NOT EXISTS idx_tickets_booking_item_id ON tickets(booking_item_id);
CREATE INDEX IF NOT EXISTS idx_tickets_qr_token ON tickets(qr_token);

-- Seed a starter catalog (safe to re-run)
INSERT INTO games (key, name, price_per_person, is_active) VALUES
  ('gokarting', 'Go Karting', 500.00, true),
  ('zipline', 'Zipline', 400.00, true),
  ('ai_cricket', 'AI Cricket', 300.00, true)
ON CONFLICT (key) DO NOTHING;
