-- W598: small settings gone.
-- Setup: a project's own setup no longer stands in for a repo without one. Each of its other repos that had none
-- gets a copy of it; the project's own directory, whose repo row had setup of its own, keeps that one as the
-- project's. The time limit and "start the agent anyway" inside the JSON are ignored from now on.
UPDATE repos SET setup = (
    SELECT s.setup FROM project_settings s WHERE s.machine_id = repos.machine_id AND s.project_id = repos.project_id
  )
  WHERE setup IS NULL AND NOT (checkout_machine_id = machine_id AND checkout_project_id = project_id);
UPDATE project_settings SET setup = (
    SELECT r.setup FROM repos r
    WHERE r.machine_id = project_settings.machine_id AND r.project_id = project_settings.project_id
      AND r.checkout_machine_id = r.machine_id AND r.checkout_project_id = r.project_id
  )
  WHERE EXISTS (
    SELECT 1 FROM repos r
    WHERE r.machine_id = project_settings.machine_id AND r.project_id = project_settings.project_id
      AND r.checkout_machine_id = r.machine_id AND r.checkout_project_id = r.project_id AND r.setup IS NOT NULL
  );
INSERT INTO project_settings (machine_id, project_id, setup)
  SELECT r.machine_id, r.project_id, r.setup FROM repos r
  WHERE r.checkout_machine_id = r.machine_id AND r.checkout_project_id = r.project_id AND r.setup IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM project_settings s WHERE s.machine_id = r.machine_id AND s.project_id = r.project_id);
UPDATE repos SET setup = NULL WHERE checkout_machine_id = machine_id AND checkout_project_id = project_id;
-- Refresh memory every night: always on now, for every project.
ALTER TABLE project_settings DROP COLUMN memory_refresh;
-- An MCP server's lead / writers / reviewers become one "Agents get it too": any that reached writers or reviewers
-- reaches every agent; one for no one is its lead's, and off. Integrations stay their lead's.
UPDATE mcp_servers SET data = json_set(data, '$.roles', json('{"lead":true,"writers":true,"reviewers":true}'))
  WHERE json_valid(data) AND json_extract(data, '$.integration') IS NULL
    AND (json_extract(data, '$.roles.writers') = 1 OR json_extract(data, '$.roles.reviewers') = 1);
UPDATE mcp_servers SET data = json_set(data, '$.roles', json('{"lead":true,"writers":false,"reviewers":false}'), '$.enabled', json('false'))
  WHERE json_valid(data) AND json_extract(data, '$.roles.lead') = 0 AND json_extract(data, '$.roles.writers') = 0 AND json_extract(data, '$.roles.reviewers') = 0;
