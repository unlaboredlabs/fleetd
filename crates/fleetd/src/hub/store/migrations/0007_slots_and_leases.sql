-- M5 slots and leases. A slot claim is queued, held (reserved or its thread running) or idle (its thread
-- stopped; kept so a re-run is counted again). `order_n` is FIFO order within a priority.
CREATE TABLE slot_claims (
    holder TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, priority TEXT NOT NULL,
    thread_id TEXT, state TEXT NOT NULL, order_n INTEGER NOT NULL
  );
  CREATE INDEX slot_claims_by_thread ON slot_claims (machine_id, thread_id);
  CREATE TABLE slot_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE slot_shares (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, share INTEGER NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE leases (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, area TEXT NOT NULL, task_id TEXT NOT NULL, since TEXT NOT NULL,
    stale_flagged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (machine_id, project_id, area)
  );
  CREATE INDEX leases_by_task ON leases (task_id);
