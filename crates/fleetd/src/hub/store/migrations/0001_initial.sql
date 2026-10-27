CREATE TABLE machines (machine_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE node_keys (machine_id TEXT PRIMARY KEY, pub_key TEXT NOT NULL);
  CREATE TABLE projects (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, search TEXT NOT NULL, last_activity_at TEXT NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE threads (
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL, last_progress_at TEXT NOT NULL,
    last_sequence INTEGER, data TEXT NOT NULL, PRIMARY KEY (machine_id, thread_id)
  );
  CREATE INDEX threads_by_project ON threads (machine_id, project_id, last_progress_at DESC);
  CREATE TABLE shell_cursors (machine_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, created_ms INTEGER NOT NULL, type TEXT NOT NULL, machine_id TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX events_by_created ON events (created_ms);
  CREATE TABLE agent_keys (
    key_id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT NOT NULL,
    grants TEXT NOT NULL, created_ms INTEGER NOT NULL, last_used_ms INTEGER, revoked_ms INTEGER
  );
  CREATE TABLE enroll_tokens (
    hash TEXT PRIMARY KEY, machine_id TEXT NOT NULL, expires_ms INTEGER NOT NULL, used_ms INTEGER
  );
