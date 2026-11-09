-- The latest run per thread and the phase it was last seen in, so a run that ended while the hub was
-- down is reported on its return.
ALTER TABLE threads ADD COLUMN last_run_id TEXT;
  ALTER TABLE threads ADD COLUMN last_run_status TEXT;
