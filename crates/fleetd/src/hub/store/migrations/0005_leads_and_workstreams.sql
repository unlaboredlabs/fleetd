-- M3 leads and workstreams. AUTOINCREMENT so a workstream number is never reused.
CREATE TABLE leads (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, started_at TEXT NOT NULL,
    last_wake_at TEXT, session_generation INTEGER NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE lead_settings (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, model TEXT, effort TEXT, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE workstreams (
    n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    client_request_id TEXT, state TEXT NOT NULL, amends TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL,
    UNIQUE (machine_id, project_id, client_request_id)
  );
  CREATE INDEX workstreams_by_project ON workstreams (machine_id, project_id, n DESC);
