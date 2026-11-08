-- What the merge train's watch after a merge did about a failed check run on the merged commit, besides a fix order:
-- re-ran it once (`reran`), or left it for being a manual or scheduled run (`manual`). Kept across restarts, so a
-- check is re-run once per commit, never again after an update.
CREATE TABLE train_watch_checks (
    repo TEXT NOT NULL, sha TEXT NOT NULL, check_name TEXT NOT NULL, run_id INTEGER NOT NULL, did TEXT NOT NULL,
    at_ms INTEGER NOT NULL, PRIMARY KEY (repo, sha, check_name, run_id)
  );
