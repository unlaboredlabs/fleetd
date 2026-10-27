-- M5 tasks. AUTOINCREMENT so a task number is never reused; `pending_message` is a `task message` waiting for a
-- slot or lease.
CREATE TABLE tasks (
    n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, ended_at TEXT, pending_message TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX tasks_by_project ON tasks (machine_id, project_id, n DESC);
  CREATE INDEX tasks_by_thread ON tasks (machine_id, thread_id) WHERE thread_id IS NOT NULL;
  CREATE INDEX tasks_queued ON tasks (n) WHERE state = 'queued';
