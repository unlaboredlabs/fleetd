-- When the human asked for an order the lead opened, and how that was found (`chat` or `opened`). Older orders
-- and submitted ones have none: they read back from the order's own times.
ALTER TABLE workstreams ADD COLUMN requested_ms INTEGER;
  ALTER TABLE workstreams ADD COLUMN requested_basis TEXT;
