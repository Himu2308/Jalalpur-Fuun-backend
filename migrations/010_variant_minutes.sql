-- Go-karting is now sold by ride time instead of laps. The column keeps its old name (renaming it would
-- break migration 004, which re-runs on every deploy), but from here on it holds MINUTES.
-- The API exposes it as `minutes`.
COMMENT ON COLUMN game_variants.laps IS 'Ride time in minutes (named laps for historical reasons)';
