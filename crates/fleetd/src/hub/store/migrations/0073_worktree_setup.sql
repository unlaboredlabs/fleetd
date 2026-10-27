-- A project's setup commands (`WorktreeSetup` as JSON; none set without a row or with NULL), and the variables
-- delivered for one order's agents: each one's name, fingerprint and size, never its value, until the order
-- closes and its node has forgotten them.
ALTER TABLE project_settings ADD COLUMN setup TEXT;
  CREATE TABLE order_env (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, workstream_id TEXT NOT NULL, name TEXT NOT NULL,
    fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL, request_id TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (machine_id, project_id, workstream_id, name)
  );
