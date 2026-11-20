-- Pricing tiers get a separate weekend (Sat/Sun, India time) price and an optional package name
-- (e.g. "Quick Ride"). price_per_person stays the weekday price; weekend_price NULL = same as weekday.
-- For the double-seater go-kart, a tier's price is per kart (one ticket per kart).
ALTER TABLE game_variants ADD COLUMN IF NOT EXISTS weekend_price NUMERIC(10, 2);
ALTER TABLE game_variants ADD COLUMN IF NOT EXISTS package_name TEXT;
