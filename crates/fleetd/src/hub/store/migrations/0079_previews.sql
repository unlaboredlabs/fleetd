-- Try it (W58): a project's preview setting (`PreviewConfig` as JSON; none without a row or with NULL), each
-- preview as JSON (`Preview`) with where it runs and its state, kept across restarts, and the agents' suggestions to
-- try a PR, one per PR.
ALTER TABLE project_settings ADD COLUMN preview TEXT;
  CREATE TABLE previews (
    preview_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, runner_id TEXT NOT NULL,
    state TEXT NOT NULL, started_ms INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX previews_by_project ON previews (machine_id, project_id, started_ms DESC);
  CREATE INDEX previews_by_state ON previews (state);
  CREATE TABLE preview_suggestions (
    repo TEXT NOT NULL, number INTEGER NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    at_ms INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo, number)
  );
