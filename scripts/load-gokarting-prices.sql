-- Loads the go-karting price list from the printed flyers (weekday Mon–Fri / weekend Sat–Sun).
-- Run AFTER migration 011 (weekend_price / package_name columns) has been deployed.
-- Old tiers are switched off (not deleted), so past bookings keep their history. Safe to re-run.
-- Single seater: price per person (one driver per kart). Double seater: price per kart (driver + passenger).
-- Note: game_variants.laps stores MINUTES.
BEGIN;

INSERT INTO games (key, name, price_per_person, is_active, sort_order)
VALUES ('gokarting', 'Go Karting', 599.00, true, 0)
ON CONFLICT (key) DO UPDATE SET is_active = true;

UPDATE game_variants SET is_active = false
WHERE is_active AND game_id = (SELECT id FROM games WHERE key = 'gokarting');

INSERT INTO game_variants (game_id, mode, laps, package_name, price_per_person, weekend_price)
SELECT g.id, v.mode, v.minutes, v.package_name, v.weekday, v.weekend
FROM games g
CROSS JOIN (VALUES
  ('single',  7, 'Quick Ride',     599.00,  699.00),
  ('single',  9, 'Sprint Ride',    799.00,  899.00),
  ('single', 12, 'Thrill Ride',    999.00, 1099.00),
  ('single', 14, 'Pro Ride',      1199.00, 1299.00),
  ('single', 17, 'Champion Ride', 1399.00, 1549.00),
  ('double',  7, NULL,             799.00,  899.00),
  ('double',  9, NULL,             999.00, 1099.00),
  ('double', 12, NULL,            1299.00, 1399.00),
  ('double', 14, NULL,            1499.00, 1599.00),
  ('double', 17, NULL,            1799.00, 1899.00)
) AS v(mode, minutes, package_name, weekday, weekend)
WHERE g.key = 'gokarting';

COMMIT;

-- Check (should list 10 rows):
SELECT gv.mode, gv.laps AS minutes, gv.package_name, gv.price_per_person AS weekday, gv.weekend_price AS weekend
FROM game_variants gv JOIN games g ON g.id = gv.game_id
WHERE g.key = 'gokarting' AND gv.is_active
ORDER BY gv.mode, gv.laps;
