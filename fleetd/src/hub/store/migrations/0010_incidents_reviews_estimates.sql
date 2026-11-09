-- M6 incidents, review verdicts (newest row per PR wins; `pr_key` is null for judge tasks) and estimate samples
-- (one per workstream that started running with a raw estimate; `done_ms` set when it is done).
CREATE TABLE incidents (
    n INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    workstream_id TEXT, data TEXT NOT NULL
  );
  CREATE INDEX incidents_by_project ON incidents (machine_id, project_id, n DESC);
  CREATE TABLE review_verdicts (
    n INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, pr_key TEXT, sha TEXT NOT NULL,
    blocking INTEGER NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX review_verdicts_by_pr ON review_verdicts (pr_key, n DESC) WHERE pr_key IS NOT NULL;
  CREATE TABLE estimates (
    workstream_id TEXT PRIMARY KEY, tier TEXT NOT NULL, raw_minutes REAL NOT NULL, ratio_at_start REAL NOT NULL,
    started_ms INTEGER NOT NULL, done_ms INTEGER, actual_minutes REAL
  );
  CREATE INDEX estimates_done_by_tier ON estimates (tier, done_ms DESC) WHERE done_ms IS NOT NULL;
