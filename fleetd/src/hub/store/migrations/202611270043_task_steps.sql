-- A finished agent's step log, kept on the workspace (hub/tasks/steps_kept.ts): when a task ends, its thread's newest
-- steps (agent_work's WorkStep rows, secrets already replaced) as one JSON array, oldest first, so agent_work reads them
-- once its node, box or worktree is gone. One row per thread, written again at each end; rows go 30 days after it.
CREATE TABLE task_steps (
    machine_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    ended_ms INTEGER NOT NULL,
    steps TEXT NOT NULL,
    PRIMARY KEY (machine_id, thread_id)
  );
CREATE INDEX task_steps_ended ON task_steps (ended_ms);
