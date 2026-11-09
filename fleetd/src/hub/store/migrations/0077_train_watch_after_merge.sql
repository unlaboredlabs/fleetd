-- The merge train's watch after each merge, of the checks it doesn't wait for, on the merged commit; and the fix
-- order each failed check opened, so one failure opens one order.
CREATE TABLE train_watches (
    repo TEXT NOT NULL, sha TEXT NOT NULL, base TEXT NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    pr_url TEXT NOT NULL, since_ms INTEGER NOT NULL, PRIMARY KEY (repo, sha)
  );
  CREATE TABLE train_fix_orders (
    repo TEXT NOT NULL, check_name TEXT NOT NULL, sha TEXT NOT NULL, workstream_id TEXT NOT NULL, at_ms INTEGER NOT NULL,
    PRIMARY KEY (repo, check_name, sha)
  );
