-- Hub-owned wakes and the offline write queue.
CREATE TABLE wakes (
    wake_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, client_request_id TEXT NOT NULL, machine_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, state TEXT NOT NULL, next_run_ms INTEGER, fired INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL, UNIQUE (created_by, client_request_id)
  );
  CREATE INDEX wakes_due ON wakes (next_run_ms) WHERE state = 'active';
  CREATE TABLE queued_writes (
    write_id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL UNIQUE, message TEXT NOT NULL, wake_id TEXT, queued_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL
  );
  CREATE INDEX queued_writes_by_machine ON queued_writes (machine_id, write_id);
