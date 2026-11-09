-- M7 merge train. A Change row per enqueued PR (`train_order` is its place in its repo's train; a re-queue at the
-- front takes one below the lowest), one train per repo with the project whose machine runs its git, and the
-- merges outside the train already reported as policy_bypass incidents. Repos are stored lowercased.
CREATE TABLE changes (
    n INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, state TEXT NOT NULL,
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, train_order INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX changes_by_repo ON changes (repo, train_order);
  CREATE INDEX changes_by_pr ON changes (repo, pr_number, n DESC);
  CREATE TABLE trains (
    repo TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, frozen INTEGER NOT NULL DEFAULT 0,
    watch_since_ms INTEGER NOT NULL
  );
  CREATE TABLE train_bypasses (repo TEXT NOT NULL, pr_number INTEGER NOT NULL, PRIMARY KEY (repo, pr_number));
