-- A project's settings: whether finished worktrees stay, and its agents' environment variables. A plain
-- variable's row holds its value; a secret's holds only the fingerprint its node computed, never the value.
ALTER TABLE project_settings ADD COLUMN keep_worktrees INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE project_env (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, value TEXT,
    fingerprint TEXT, bytes INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (machine_id, project_id, name),
    CHECK ((kind = 'plain' AND fingerprint IS NULL) OR (kind = 'secret' AND value IS NULL AND fingerprint IS NOT NULL))
  );
