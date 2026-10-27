-- Agents' browser sessions, one row per session as JSON (`BrowserSession`); `bytes` is its recording's size on
-- disk under <home>/browser/<session_id>/. And the recordings' retention; no row means the default.
CREATE TABLE browser_sessions (
    session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, started_ms INTEGER NOT NULL,
    state TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
  );
  CREATE INDEX browser_sessions_by_project ON browser_sessions (machine_id, project_id, started_ms DESC);
  CREATE TABLE browser_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
