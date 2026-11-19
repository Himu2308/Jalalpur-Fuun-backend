-- Ticket cancellation & refunds (admin only).

-- The price each ticket was sold at, so a refund uses the price the customer actually paid,
-- not today's catalog price.
ALTER TABLE booking_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10, 2);

-- Backfill old rows. A booking with a single line is exact (total / quantity) ...
UPDATE booking_items bi
SET unit_price = ROUND(b.total_amount / bi.quantity, 2)
FROM bookings b
WHERE b.id = bi.booking_id
  AND bi.unit_price IS NULL
  AND (SELECT COUNT(*) FROM booking_items x WHERE x.booking_id = b.id) = 1;

-- ... multi-line bookings fall back to the current catalog price of that game/variant.
UPDATE booking_items bi
SET unit_price = COALESCE(
  (SELECT gv.price_per_person FROM game_variants gv WHERE gv.id = bi.game_variant_id),
  (SELECT g.price_per_person FROM games g WHERE g.id = bi.game_id)
)
WHERE bi.unit_price IS NULL;

-- One refund = money returned on one booking, split across Razorpay / cash / UPI,
-- optionally cancelling some of its unused tickets at the same time.
CREATE TABLE IF NOT EXISTS refunds (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(id),
  amount NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),          -- razorpay + cash + upi
  razorpay_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  cash_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  upi_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  upi_ref TEXT,
  razorpay_refund_id TEXT,
  razorpay_status TEXT,                                        -- pending | processed | failed; NULL when no Razorpay part
  reason TEXT NOT NULL,
  ticket_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refunds_booking_idx ON refunds (booking_id);
CREATE INDEX IF NOT EXISTS refunds_created_idx ON refunds (created_at);

-- Tickets gain a 'cancelled' status (status is free text: unused | used | expired | cancelled).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS refund_id BIGINT REFERENCES refunds(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
