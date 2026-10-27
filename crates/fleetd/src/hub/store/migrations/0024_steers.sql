-- Steers: a person's (or a lead's) words to a running agent and their receipt. `n` is the S<n> id; `data` the
-- Steer; `held` marks a steer to a task that is not running, sent with the task's next run (`message`, the text
-- it added to the task's pending message), and `rides_with` the steer whose run carried it. A queued write
-- remembers its send mode and steer, so one sent while the machine was away goes out as it was given (null
-- mode = a plain send). A plan change made with `--steer` names its steer.
CREATE TABLE steers (n INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, task_id TEXT,
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, by TEXT NOT NULL, mode TEXT NOT NULL,
    stage TEXT NOT NULL, queued_ms INTEGER NOT NULL, delivered_ms INTEGER, acked_ms INTEGER,
    held INTEGER NOT NULL DEFAULT 0, rides_with INTEGER, message TEXT, data TEXT NOT NULL);
  CREATE INDEX steers_by_workstream ON steers (workstream_id, n);
  CREATE INDEX steers_by_run ON steers (run_id);
  ALTER TABLE queued_writes ADD COLUMN mode TEXT;
  ALTER TABLE queued_writes ADD COLUMN steer_id TEXT;
  ALTER TABLE plan_changes ADD COLUMN steer_id TEXT;
