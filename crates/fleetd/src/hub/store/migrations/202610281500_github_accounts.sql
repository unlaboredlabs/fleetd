-- Each person's own GitHub account, connected through the hub's App (D187, D190): `GithubAccount` as JSON, with the
-- user-to-server access and refresh tokens each sealed to the hub's own box key, and when each ends.
CREATE TABLE github_accounts (
  person_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  sealed_access BLOB NOT NULL,
  access_expires_ms INTEGER NOT NULL,
  sealed_refresh BLOB,
  refresh_expires_ms INTEGER
);

-- The GitHub token each open order's agents hold (`GH_TOKEN`, one of the order's variables): the repo it was for, when
-- it ends and how close to that it is delivered again. Kept here so the sweep renews it after a hub restart too.
CREATE TABLE github_order_tokens (
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  repo_id TEXT,
  expires_ms INTEGER NOT NULL,
  margin_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, project_id, workstream_id)
);
