-- fleetd has no Google or Notion integration now (D236): the Google client, each Navi's account and the mail state
-- go, and so does each Navi's Notion server. Each node holding a Notion server's secrets is queued to forget them
-- (`mcp_secret_forgets`, drained by hub/mcp_servers once the node is online), so no token is left behind; a node drops
-- its Google tokens itself at start.
DROP TABLE google_client;
DROP TABLE google_accounts;
DROP TABLE google_mail_state;
CREATE TABLE mcp_secret_forgets (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (machine_id, project_id, name)
);
INSERT OR IGNORE INTO mcp_secret_forgets (machine_id, project_id, name)
  SELECT json_extract(holder.value, '$.machineId'), s.project_id, s.name
  FROM mcp_servers s, json_each(s.data, '$.env') v, json_each(v.value, '$.sealedOn') holder
  WHERE json_extract(s.data, '$.integration.kind') = 'notion'
  UNION
  SELECT json_extract(holder.value, '$.machineId'), s.project_id, s.name
  FROM mcp_servers s, json_each(s.data, '$.headers') v, json_each(v.value, '$.sealedOn') holder
  WHERE json_extract(s.data, '$.integration.kind') = 'notion';
DELETE FROM mcp_servers WHERE json_extract(data, '$.integration.kind') = 'notion';
