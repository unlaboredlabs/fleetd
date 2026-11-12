-- W638: one team vault (decision vault.one-team-vault). The hub keeps logins, cards and addresses in one team vault
-- (scope `hub`: everyone lists and fills them, their creator or an admin changes them), variables per project and per
-- order. Nothing is deleted and no value is sealed again here: a row whose scope moves keeps its envelope, and
-- `sealed_scope` names the scope part of the AAD it was sealed under until its next write seals it again.
-- - A project's logins, cards and addresses join the team vault; one whose label another team item of its kind has
--   gets its project's name appended. Its creator (a person) becomes its `person_id`, as a new team item's.
-- - A person's own logins, cards and addresses join it on a hub with one live person; on a hub with more, only those
--   they shared with a project or a project pays with (`project_settings.card_ref`), which that project's work could
--   fill already.
-- - A person's own variable becomes a project's variable: on a hub with one live person, in each project not archived
--   that has none of that name; on a hub with more, in each project it was shared with that has none. The row itself
--   moves to the first such project; `vault_settings` `team_vault_copies` lists the rest, which the hub copies once
--   the vault's key is open (migrate.ts `copyTeamVars`).
-- - Anything else of a person's stays `person`: set aside, listed only to its owner, never filled or delivered, until
--   they move it to the team vault (a variable: to a project) or delete it.
-- `vault_shares` goes: nothing is shared any more.
ALTER TABLE vault_items ADD COLUMN sealed_scope TEXT;
CREATE TEMP TABLE team_live_people AS SELECT person_id FROM people WHERE removed_ms IS NULL;
CREATE TEMP TABLE team_one AS
  SELECT person_id FROM team_live_people WHERE (SELECT count(*) FROM team_live_people) = 1;
CREATE TEMP TABLE team_shared AS
  SELECT item_id, machine_id, project_id FROM vault_shares
  UNION SELECT substr(card_ref, 7), machine_id, project_id FROM project_settings WHERE card_ref LIKE 'vault:%';
CREATE TEMP TABLE team_moving AS
  SELECT item_id FROM vault_items
  WHERE kind <> 'env' AND (scope = 'project'
    OR (scope = 'person' AND (person_id IN (SELECT person_id FROM team_one) OR item_id IN (SELECT item_id FROM team_shared))));
UPDATE vault_items
  SET label = substr(label || ' (' || coalesce((SELECT json_extract(p.data, '$.title') FROM projects p
      WHERE p.machine_id = vault_items.machine_id AND p.project_id = vault_items.project_id), project_id) || ')', 1, 120)
  WHERE scope = 'project' AND kind <> 'env' AND deleted_ms IS NULL AND EXISTS (
    SELECT 1 FROM vault_items o
    WHERE o.item_id <> vault_items.item_id AND o.kind = vault_items.kind AND o.deleted_ms IS NULL
      AND o.label = vault_items.label COLLATE NOCASE
      AND (o.scope = 'hub' OR o.item_id IN (SELECT item_id FROM team_moving)));
UPDATE vault_items
  SET sealed_scope = CASE scope WHEN 'project' THEN 'project:' || machine_id || '/' || project_id ELSE 'person:' || person_id END,
    person_id = CASE scope WHEN 'project' THEN (SELECT person_id FROM people WHERE person_id = vault_items.created_by) ELSE person_id END,
    scope = 'hub', machine_id = NULL, project_id = NULL
  WHERE item_id IN (SELECT item_id FROM team_moving);
CREATE TEMP TABLE team_targets AS
  SELECT item_id, machine_id, project_id,
      row_number() OVER (PARTITION BY item_id ORDER BY machine_id, project_id) AS nth
  FROM (
    SELECT v.item_id, p.machine_id, p.project_id,
        row_number() OVER (PARTITION BY p.machine_id, p.project_id, v.env_name ORDER BY v.created_ms, v.item_id) AS first
    FROM vault_items v JOIN projects p
    WHERE v.kind = 'env' AND v.scope = 'person' AND v.deleted_ms IS NULL AND json_extract(v.meta, '$.sink') IS NULL
      AND ((v.person_id IN (SELECT person_id FROM team_one) AND NOT EXISTS (SELECT 1 FROM project_settings s
              WHERE s.machine_id = p.machine_id AND s.project_id = p.project_id AND s.archived_ms IS NOT NULL))
        OR EXISTS (SELECT 1 FROM team_shared t WHERE t.item_id = v.item_id AND t.machine_id = p.machine_id AND t.project_id = p.project_id))
      AND NOT EXISTS (SELECT 1 FROM vault_items o WHERE o.kind = 'env' AND o.scope = 'project' AND o.deleted_ms IS NULL
        AND o.machine_id = p.machine_id AND o.project_id = p.project_id AND o.env_name = v.env_name))
  WHERE first = 1;
INSERT INTO vault_settings (key, value)
  SELECT 'team_vault_copies', json_group_array(json_object('itemId', item_id, 'machineId', machine_id, 'projectId', project_id))
  FROM (SELECT item_id, machine_id, project_id FROM team_targets WHERE nth > 1 ORDER BY item_id, machine_id, project_id)
  HAVING count(*) > 0;
UPDATE vault_items
  SET sealed_scope = 'person:' || person_id, scope = 'project', person_id = NULL,
    machine_id = (SELECT machine_id FROM team_targets t WHERE t.item_id = vault_items.item_id AND t.nth = 1),
    project_id = (SELECT project_id FROM team_targets t WHERE t.item_id = vault_items.item_id AND t.nth = 1)
  WHERE item_id IN (SELECT item_id FROM team_targets WHERE nth = 1);
DROP TABLE vault_shares;
DROP TABLE team_live_people;
DROP TABLE team_one;
DROP TABLE team_shared;
DROP TABLE team_moving;
DROP TABLE team_targets;
