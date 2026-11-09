-- The work ledger: claims on work fleetd can't otherwise see, and the repo and base each project's work lands on,
-- so projects on one repo see each other's work.
CREATE TABLE work_claims (
    n INTEGER PRIMARY KEY AUTOINCREMENT, repo_key TEXT NOT NULL, base TEXT NOT NULL, state TEXT NOT NULL,
    owner_key TEXT NOT NULL, expires_ms INTEGER NOT NULL, ended_ms INTEGER, data TEXT NOT NULL
  );
  CREATE INDEX work_claims_by_scope ON work_claims (repo_key, base, state);
  CREATE INDEX work_claims_active_by_expiry ON work_claims (expires_ms) WHERE state = 'active';
  CREATE TABLE work_projects (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, repo_key TEXT NOT NULL, base TEXT NOT NULL,
    updated_ms INTEGER NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
  CREATE INDEX work_projects_by_scope ON work_projects (repo_key, base);
