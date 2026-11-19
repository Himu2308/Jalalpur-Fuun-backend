-- Only workers the admin allows can sell walk-in tickets at the counter. Off by default; admin can always sell.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS can_sell BOOLEAN NOT NULL DEFAULT false;
