-- Agents run on the team's own computers, directly on each, or on fleetd's cloud (D594): a self-hosted hub keeps no
-- hosted sandbox key, runs no node of its own for them, and no Tailscale gateway for their boxes; no machine runs its
-- agents in VMs. What it kept of them goes here, and nothing on disk: the hosted sandboxes' folder of checkouts
-- (`<hub home>/runner`) stays where it is.
--
-- Each bot that had picked a Local VM or a hosted sandbox for its agents, or that lived in the hosted sandboxes, is
-- told once in its chat (hub/hosted_gone reads `hosted_removed`, posts the line and marks it said): a pick's bot
-- runs on its machine again from now on; a hosted sandboxes' bot (machine `hosted`) stays as it is, with its files.
CREATE TABLE hosted_removed (
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- 'vm' (it picked a Local VM), 'boat' (it picked a hosted sandbox), 'runner' (it lived in the hosted sandboxes).
  was TEXT NOT NULL,
  said INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, project_id)
);
INSERT OR IGNORE INTO hosted_removed (machine_id, project_id, was)
  SELECT machine_id, project_id, 'runner' FROM projects WHERE machine_id = 'hosted';
INSERT OR IGNORE INTO hosted_removed (machine_id, project_id, was)
  SELECT machine_id, project_id, CASE WHEN json_extract(computer, '$.kind') = 'vm' THEN 'vm' ELSE 'boat' END
  FROM project_settings
  WHERE computer IS NOT NULL AND json_valid(computer) AND machine_id IN (SELECT machine_id FROM projects WHERE machine_id <> 'hosted');
UPDATE project_settings SET computer = NULL WHERE computer IS NOT NULL;
-- The team's own provider keys (sealed), their limits, the Linux machine's pick and the removed providers' lines.
DROP TABLE sandbox_providers;
DROP TABLE sandbox_settings;
DROP TABLE providers_removed;
-- The Tailscale gateway's own login state (sealed). Nothing else of Tailscale is the hub's: machines on the tailnet
-- keep their own tailscaled.
DROP TABLE tailnet_gateway;
-- The hosted sandboxes' node: its machine row, its key and any code it could join with. Its bots stay, as bots of a
-- removed machine do.
DELETE FROM machines WHERE machine_id = 'hosted';
DELETE FROM node_keys WHERE machine_id = 'hosted';
DELETE FROM enroll_tokens WHERE machine_id = '(the hub''s runner)';
