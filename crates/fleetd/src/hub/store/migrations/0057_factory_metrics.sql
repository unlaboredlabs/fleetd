-- Factory metrics: one row per landed change (a PR merged into a repo's default branch, a train batch's members
-- one each, or a direct push), keyed by the repo's remote so any host fits; the person's touches; each repo's
-- read cursors; and when each Change first passed review, kept here as the event log goes after 30 days.
CREATE TABLE metric_merges (
    repo TEXT NOT NULL, unit_key TEXT NOT NULL, machine_id TEXT, project_id TEXT, pr_number INTEGER,
    merged_ms INTEGER NOT NULL, merged_sha TEXT, route TEXT NOT NULL, skip_why TEXT, workstream_id TEXT, task_id TEXT,
    change_id TEXT, batch_pr INTEGER, requested_ms INTEGER, requested_basis TEXT, pr_created_ms INTEGER,
    first_pr_ms INTEGER, review_passed_ms INTEGER, author_kind TEXT, merged_by_kind TEXT, additions INTEGER,
    deletions INTEGER, title TEXT, url TEXT, seen_claim TEXT, src TEXT NOT NULL,
    PRIMARY KEY (repo, unit_key)
  ) WITHOUT ROWID;
  CREATE INDEX metric_merges_by_day ON metric_merges (merged_ms);
  CREATE INDEX metric_merges_by_order ON metric_merges (workstream_id) WHERE workstream_id IS NOT NULL;
  CREATE INDEX metric_merges_by_change ON metric_merges (change_id) WHERE change_id IS NOT NULL;
  CREATE TABLE metric_touches (
    id INTEGER PRIMARY KEY, src TEXT NOT NULL, src_key TEXT NOT NULL, kind TEXT NOT NULL, at_ms INTEGER NOT NULL,
    credit_ms INTEGER NOT NULL, end_ms INTEGER, machine_id TEXT, project_id TEXT, repo TEXT, workstream_id TEXT,
    pr_number INTEGER, key_id TEXT, estimated INTEGER NOT NULL DEFAULT 0, UNIQUE (src, src_key)
  );
  CREATE INDEX metric_touches_by_at ON metric_touches (at_ms);
  CREATE TABLE metric_repos (
    repo TEXT PRIMARY KEY, host TEXT NOT NULL, default_branch TEXT, merged_cursor_ms INTEGER,
    commits_cursor_sha TEXT, reviews_cursor_ms INTEGER, last_ok_ms INTEGER, last_error TEXT, backfilled_ms INTEGER
  );
  CREATE TABLE metric_changes (change_id TEXT PRIMARY KEY, review_passed_ms INTEGER NOT NULL);
