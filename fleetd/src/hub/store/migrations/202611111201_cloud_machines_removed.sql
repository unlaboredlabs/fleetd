-- Cloud machines (boat.dev) are removed from fleetd. Each cloud machine goes as `fleetd machine remove` takes a
-- machine (hub_store `forgetMachine`): its row in the machine list and everything its node reported or the hub kept for
-- it. Then the cloud tables go, with the pool's settings, its sealed boat.dev key and the per-project cloud ticks, and the
-- cloud columns of node_keys, enroll_tokens, slot_claims, machines' and tasks' data. A cloud machine is one enrolled with
-- a pool token, a pool slot, or a machine row marked cloud.
CREATE TEMP TABLE cloud_gone AS
  SELECT machine_id FROM node_keys WHERE pool = 1
  UNION SELECT slot FROM pool_machines
  UNION SELECT machine_id FROM machines WHERE json_extract(data, '$.cloud') = 1;
DELETE FROM automation_runs WHERE automation_id IN
  (SELECT automation_id FROM automations WHERE machine_id IN (SELECT machine_id FROM cloud_gone));
DELETE FROM machines WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM node_keys WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM enroll_tokens WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM machine_roles WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM slot_machine_caps WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM slot_shares WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM slot_claims WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM shell_cursors WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM projects WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM project_settings WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM project_env WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM project_avatars WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM project_icons WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM project_profiles WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM work_projects WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM metric_project_repos WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM threads WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM thread_accounts WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM task_threads WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM session_prompts WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM queued_writes WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM wakes WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM steers WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM chat_projects WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM chat_messages WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM checklists WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM leads WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM lead_mcp WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM approval_checks WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM automations WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM trains WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM train_watches WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM order_env WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM github_order_tokens WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM hub_links WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM mcp_servers WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM mcp_oauth WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM mcp_secret_forgets WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM memory_imports WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM memory_refreshes WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM memory_refresh_lines WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM navi_approvals WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM navi_auto_approved WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM navi_sites WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM skill_versions WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM skill_uses WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM artifact_versions WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM browser_sessions WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM screen_waits WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM vault_shares WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM vault_deliveries WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM vault_imports WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM repos WHERE machine_id IN (SELECT machine_id FROM cloud_gone) OR checkout_machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM navi_asks WHERE from_machine_id IN (SELECT machine_id FROM cloud_gone);
DELETE FROM session_places WHERE origin_machine IN (SELECT machine_id FROM cloud_gone);
DELETE FROM vault_items WHERE machine_id IN (SELECT machine_id FROM cloud_gone);
DROP TABLE cloud_gone;
UPDATE machines SET data = json_remove(data, '$.cloud') WHERE json_extract(data, '$.cloud') IS NOT NULL;
UPDATE tasks SET data = json_remove(data, '$.ranOn') WHERE json_extract(data, '$.ranOn') IS NOT NULL;
DROP TABLE cloud_outbox;
DROP TABLE pool_settings;
DROP TABLE pool_machines;
DROP TABLE pool_starts;
DROP TABLE pool_spend;
DROP TABLE pool_boat_cost;
ALTER TABLE node_keys DROP COLUMN pool;
ALTER TABLE enroll_tokens DROP COLUMN pool;
ALTER TABLE slot_claims DROP COLUMN on_machine;
