-- A project's repos (W79): the git repos in a project's own directory or attached to it, each with the node
-- checkout holding its files. `n` is the `R<n>` and is never reused. A project's own repo, the one whose checkout is
-- the project itself, exists only when its directory is a git repo. `setup` and `preview` are for per-repo settings
-- (NULL: the project's own).
CREATE TABLE repos (
    n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
    checkout_machine_id TEXT NOT NULL, checkout_project_id TEXT NOT NULL, repo_key TEXT, base TEXT, setup TEXT,
    preview TEXT, UNIQUE (machine_id, project_id, name),
    UNIQUE (machine_id, project_id, checkout_machine_id, checkout_project_id)
  );
  CREATE INDEX repos_by_checkout ON repos (checkout_machine_id, checkout_project_id);
  CREATE INDEX repos_by_key ON repos (repo_key);
