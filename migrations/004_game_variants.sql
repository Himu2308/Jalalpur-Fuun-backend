-- Controls display order on the homepage (lower = shown first); admin-added games append at the end.
ALTER TABLE games ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
UPDATE games SET sort_order = 0 WHERE key = 'gokarting';
UPDATE games SET sort_order = 1 WHERE key = 'zipline';
UPDATE games SET sort_order = 2 WHERE key = 'ai_cricket';

-- A game can optionally offer priced variants (e.g. GoKarting: single/double mode x lap count)
-- instead of one flat price_per_person. Soft-deleted (is_active = false) rather than removed so
-- past bookings that reference a variant keep their price history intact.
CREATE TABLE IF NOT EXISTS game_variants (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  laps INT NOT NULL,
  price_per_person NUMERIC(10, 2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_variants_game_id ON game_variants(game_id);

ALTER TABLE booking_items ADD COLUMN IF NOT EXISTS game_variant_id BIGINT REFERENCES game_variants(id);

-- Seed GoKarting's initial pricing tiers, if the game exists and has no variants yet.
INSERT INTO game_variants (game_id, mode, laps, price_per_person)
SELECT g.id, v.mode, v.laps, v.price_per_person
FROM games g
CROSS JOIN (VALUES
  ('single', 5, 500.00),
  ('single', 10, 800.00),
  ('single', 15, 1200.00),
  ('single', 20, 1550.00),
  ('single', 25, 2000.00),
  ('double', 5, 650.00),
  ('double', 10, 1150.00)
) AS v(mode, laps, price_per_person)
WHERE g.key = 'gokarting'
  AND NOT EXISTS (SELECT 1 FROM game_variants gv WHERE gv.game_id = g.id);
