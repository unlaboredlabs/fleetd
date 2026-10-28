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
