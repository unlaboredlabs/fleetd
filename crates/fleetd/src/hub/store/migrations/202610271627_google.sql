-- A Navi's own Google connection (W97): the admin's OAuth client (`GoogleClient` as JSON, no secret), one row, and
-- each Navi's account (`GoogleAccount` as JSON, no token).
CREATE TABLE google_client (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
CREATE TABLE google_accounts (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (machine_id, project_id)
);
