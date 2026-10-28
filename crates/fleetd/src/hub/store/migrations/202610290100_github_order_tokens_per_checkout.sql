-- An order's GitHub token is now per checkout (the repo each task works in, W79), with whose it is: each repo gets the
-- token for its owner's installation, or none where the App doesn't reach. `blocked`: the person's token was taken
-- back (they disconnected, lapsed or left), and the agents hold a value that makes gh fail until they reconnect.
CREATE TABLE github_order_tokens_new (
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  checkout_machine_id TEXT NOT NULL,
  checkout_project_id TEXT NOT NULL,
  repo_id TEXT,
  person_id TEXT,
  expires_ms INTEGER NOT NULL,
  margin_ms INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workstream_id, checkout_machine_id, checkout_project_id)
);
INSERT INTO github_order_tokens_new
  SELECT machine_id, project_id, workstream_id, machine_id, project_id, repo_id, NULL, expires_ms, margin_ms, 0
  FROM github_order_tokens;
DROP TABLE github_order_tokens;
ALTER TABLE github_order_tokens_new RENAME TO github_order_tokens;
