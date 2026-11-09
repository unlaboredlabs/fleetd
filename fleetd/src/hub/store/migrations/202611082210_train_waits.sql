-- The merge train's waits on a Change at one head, kept across restarts so an update doesn't start them over:
-- `unstarted` (no check started on it yet; state `waiting` or `read` once its checks were looked at), `blocked` (its
-- review's findings hold it; `waiting` or `told` once the lead heard), `regen` (its regeneration; `running`, `pushed` or
-- `failed`). `since_ms` is when it began at that head.
CREATE TABLE train_waits (
    change_id TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL, head TEXT NOT NULL, since_ms INTEGER NOT NULL,
    state TEXT NOT NULL, PRIMARY KEY (change_id, kind)
  );
CREATE INDEX train_waits_repo ON train_waits (repo);
