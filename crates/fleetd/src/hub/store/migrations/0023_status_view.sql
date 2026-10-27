-- The status view: each project's plan (milestones, items, and the markers of every scope change), what each
-- person last looked at, each scope's first ETA, the latest generated headline per scope, and the repo hooks
-- made by opt-in GitHub webhooks. An order with no plan items counts as one placeholder item from when it starts
-- running until it gets a plan, stops, or a day after it is done. `events_by_type` counts "since you looked".
CREATE TABLE plan_milestones (n INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT NOT NULL, title TEXT NOT NULL,
    position INTEGER NOT NULL, created_ms INTEGER NOT NULL, first_item_ms INTEGER, done_ms INTEGER);
  CREATE TABLE plan_items (n INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT NOT NULL, milestone INTEGER NOT NULL,
    workstream_id TEXT, state TEXT NOT NULL, weight TEXT NOT NULL, size INTEGER NOT NULL, position INTEGER NOT NULL,
    started_ms INTEGER, done_ms INTEGER, data TEXT NOT NULL);
  CREATE INDEX plan_items_by_project ON plan_items (project_ref, state);
  CREATE INDEX plan_items_by_workstream ON plan_items (workstream_id) WHERE workstream_id IS NOT NULL;
  CREATE INDEX plan_items_done ON plan_items (project_ref, done_ms) WHERE done_ms IS NOT NULL;
  CREATE TABLE plan_changes (n INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT NOT NULL, milestone INTEGER NOT NULL,
    workstream_id TEXT, at_ms INTEGER NOT NULL, by TEXT NOT NULL, kind TEXT NOT NULL, delta_items INTEGER NOT NULL,
    delta_size INTEGER NOT NULL, pct_before INTEGER, pct_after INTEGER, note TEXT NOT NULL);
  CREATE INDEX plan_changes_by_project ON plan_changes (project_ref, n DESC);
  CREATE TABLE status_seen (key_id TEXT NOT NULL, scope TEXT NOT NULL, seq INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    PRIMARY KEY (key_id, scope)) WITHOUT ROWID;
  CREATE TABLE status_eta (scope TEXT PRIMARY KEY, original_ms INTEGER NOT NULL, set_ms INTEGER NOT NULL,
    basis TEXT NOT NULL);
  CREATE TABLE status_headlines (scope TEXT PRIMARY KEY, facts_hash BLOB NOT NULL, text TEXT NOT NULL, run TEXT NOT NULL,
    at_ms INTEGER NOT NULL);
  CREATE TABLE plan_placeholders (workstream_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, size INTEGER NOT NULL,
    title TEXT NOT NULL, state TEXT NOT NULL, entered_ms INTEGER NOT NULL, done_ms INTEGER, left_ms INTEGER);
  CREATE INDEX plan_placeholders_live ON plan_placeholders (state, done_ms) WHERE state != 'left';
  CREATE INDEX changes_by_task ON changes (CASE WHEN json_valid(data) THEN json_extract(data, '$.taskId') END);
  CREATE TABLE github_hooks (repo TEXT PRIMARY KEY, hook_id INTEGER NOT NULL, url TEXT NOT NULL);
  CREATE INDEX events_by_type ON events (type, seq);
