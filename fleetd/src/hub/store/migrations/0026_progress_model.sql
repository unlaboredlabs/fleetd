-- The progress model: each viewed scope's estimate over time (the last 96 points; `drop` is the JSON reason a
-- point fell), each order's planning share once its plan exists (fixed from then on), and lookups of an order's
-- tasks and Changes for its stages.
CREATE TABLE status_series (scope TEXT NOT NULL, at_ms INTEGER NOT NULL, pct INTEGER NOT NULL,
    verified INTEGER NOT NULL, drop_reason TEXT, PRIMARY KEY (scope, at_ms)) WITHOUT ROWID;
  CREATE TABLE status_planning (workstream_id TEXT PRIMARY KEY, share REAL NOT NULL, ended_ms INTEGER NOT NULL);
  CREATE INDEX tasks_by_workstream ON tasks (workstream_id);
  CREATE INDEX changes_by_workstream ON changes (CASE WHEN json_valid(data) THEN json_extract(data, '$.workstreamId') END);
