-- MCP servers signed in with OAuth (hub/mcp_oauth): one row per server, keyed as `mcp_servers` is. `data` is what the
-- hub needs to sign in and renew: the service's endpoints, the client (its secret, if any, sealed to the hub's own box
-- key), when the token ends, and a sign-in waiting for its callback, whose OAuth `state` is in `state` until it comes.
-- The access and refresh tokens are each sealed to the hub's own box key (crypto_box_seal), as the GitHub App's are.
CREATE TABLE mcp_oauth (
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  state TEXT UNIQUE,
  sealed_access BLOB,
  sealed_refresh BLOB,
  PRIMARY KEY (machine_id, project_id, name)
);
