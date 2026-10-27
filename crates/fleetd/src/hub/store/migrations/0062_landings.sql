-- Landings: every commit on the first-parent line of a watched base, however it got there, and how far each
-- watched base has been read.
CREATE TABLE landings (
    repo_key TEXT NOT NULL, base TEXT NOT NULL, sha TEXT NOT NULL, at_ms INTEGER NOT NULL, route TEXT NOT NULL,
    pr_number INTEGER, rewrite_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo_key, base, sha)
  );
  CREATE INDEX landings_by_time ON landings (repo_key, base, at_ms DESC);
  CREATE INDEX landings_by_rewrite ON landings (repo_key, base, rewrite_key);
  CREATE TABLE landing_watch (
    repo_key TEXT NOT NULL, base TEXT NOT NULL, last_sha TEXT NOT NULL, since_ms INTEGER NOT NULL,
    PRIMARY KEY (repo_key, base)
  );
