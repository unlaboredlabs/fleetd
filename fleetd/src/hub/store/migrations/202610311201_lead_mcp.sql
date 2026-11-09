-- W236: the MCP servers each project's lead thread (a Navi's too) started with, as `hub::mcp_servers::LeadMcpSet` JSON.
-- When its project's set differs at a turn, that turn starts a fresh session instead.
CREATE TABLE lead_mcp (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (machine_id, project_id)
);
