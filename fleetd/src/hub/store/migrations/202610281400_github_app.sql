-- The hub's own GitHub App (D190): `GithubApp` as JSON, one row, with its private key, client secret and webhook
-- secret each sealed to the hub's own box key (crypto_box_seal), as GitHub handed them to the hub.
CREATE TABLE github_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  sealed_key BLOB NOT NULL,
  sealed_client_secret BLOB,
  sealed_webhook_secret BLOB
);
