-- The MCP servers agents get: one row per server, a global one's machine and project empty. `data` is the server
-- as the tools show it: a plain value, and for a secret only each node's fingerprint, never its value. And whether
-- agents also get the person's own MCP servers; no row means on.
CREATE TABLE mcp_servers (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (machine_id, project_id, name)
  );
  CREATE TABLE mcp_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
