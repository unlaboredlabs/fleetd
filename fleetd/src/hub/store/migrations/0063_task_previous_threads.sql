-- The threads a task ran in before a fresh restart (`previousThreads`), so their late events still find the task
-- on an index.
CREATE TABLE task_threads (
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (machine_id, thread_id)
  );
  CREATE INDEX task_threads_by_thread ON task_threads (thread_id);
