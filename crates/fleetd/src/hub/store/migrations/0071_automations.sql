-- Automations: a project's stored prompt and triggers, and their runs. `webhook_hash` is the SHA-256 of the webhook
-- URL's secret, never the secret; `payload` is a webhook run's body, kept with its run only.
CREATE TABLE automations (
    automation_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, created_by TEXT NOT NULL,
    client_request_id TEXT, paused INTEGER NOT NULL DEFAULT 0, next_run_ms INTEGER, webhook_hash TEXT,
    data TEXT NOT NULL, UNIQUE (created_by, client_request_id)
  );
  CREATE INDEX automations_by_project ON automations (machine_id, project_id);
  CREATE INDEX automations_due ON automations (next_run_ms) WHERE next_run_ms IS NOT NULL;
  CREATE TABLE automation_runs (
    run_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, at_ms INTEGER NOT NULL, state TEXT NOT NULL,
    workstream_id TEXT, payload TEXT, data TEXT NOT NULL
  );
  CREATE INDEX automation_runs_by_automation ON automation_runs (automation_id, at_ms DESC);
