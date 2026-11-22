-- A watcher's run (hub/watchers) runs in a session of its own, not an order: the session it runs in, when that
-- started, and what it looked at (`seen`, a hash of the evidence it was given), so a look at the same evidence as the
-- last quiet run starts no session.
ALTER TABLE automation_runs ADD COLUMN thread_id TEXT;
ALTER TABLE automation_runs ADD COLUMN started_ms INTEGER;
ALTER TABLE automation_runs ADD COLUMN seen TEXT;
CREATE INDEX automation_runs_by_thread ON automation_runs (thread_id) WHERE thread_id IS NOT NULL;
