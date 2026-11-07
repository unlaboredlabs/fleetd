-- D310 projects.one-model: a Navi is a project, so what `assistants` kept of one becomes its project's own columns in
-- `project_settings`: only_me (only owner_person sees and uses it; on for every Navi), owner_person, archived_ms,
-- card_ref (the card it pays with, an op://vault/item reference), and the key that made it with when. Nothing on disk
-- moves, and every other table keeps its keys: a Navi's chat, memory, skills, automations, Telegram, hub links,
-- approvals, sites, purchases and asks are keyed by its project already. Each person's sidebar order puts their own
-- Navis first, as their sidebar showed them, so nothing moves once the apps show one list: the ones the order named,
-- in its order, then the rest, oldest first, then everything else as it was.
ALTER TABLE project_settings ADD COLUMN only_me INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE project_settings ADD COLUMN owner_person TEXT;
  ALTER TABLE project_settings ADD COLUMN archived_ms INTEGER;
  ALTER TABLE project_settings ADD COLUMN card_ref TEXT;
  ALTER TABLE project_settings ADD COLUMN created_ms INTEGER;
  ALTER TABLE project_settings ADD COLUMN created_by_key TEXT;
  ALTER TABLE project_settings ADD COLUMN created_by_name TEXT;
  INSERT INTO project_settings (machine_id, project_id, only_me, owner_person, archived_ms, card_ref, created_ms,
      created_by_key, created_by_name)
    SELECT machine_id, project_id, 1, owner_person, archived_ms, card_ref, created_ms, created_by_key, created_by_name
    FROM assistants WHERE true
    ON CONFLICT (machine_id, project_id) DO UPDATE SET only_me = 1, owner_person = excluded.owner_person,
      archived_ms = excluded.archived_ms, card_ref = excluded.card_ref, created_ms = excluded.created_ms,
      created_by_key = excluded.created_by_key, created_by_name = excluded.created_by_name;
  INSERT INTO sidebar_orders (person_id, refs)
    SELECT o.person_id, (
        SELECT json_group_array(json(x.ref) ORDER BY x.navi DESC, x.pos IS NULL, x.pos, x.created_ms)
        FROM (
          SELECT e.value AS ref, n.project_id IS NOT NULL AS navi, e.key AS pos, n.created_ms AS created_ms
          FROM json_each(o.refs) e
          LEFT JOIN assistants n ON n.owner_person = o.person_id
            AND n.machine_id = json_extract(e.value, '$.machineId')
            AND n.project_id = json_extract(e.value, '$.projectId')
          UNION ALL
          SELECT json_object('machineId', n.machine_id, 'projectId', n.project_id), 1, NULL, n.created_ms
          FROM assistants n
          WHERE n.owner_person = o.person_id AND NOT EXISTS (SELECT 1 FROM json_each(o.refs) e
            WHERE json_extract(e.value, '$.machineId') = n.machine_id
              AND json_extract(e.value, '$.projectId') = n.project_id)
        ) x)
    FROM (SELECT a.owner_person AS person_id, COALESCE((SELECT s.refs FROM sidebar_orders s
            WHERE s.person_id = a.owner_person AND json_valid(s.refs) AND json_type(s.refs) = 'array'), '[]') AS refs
          FROM assistants a WHERE a.owner_person IS NOT NULL GROUP BY a.owner_person) o
    WHERE true
    ON CONFLICT (person_id) DO UPDATE SET refs = excluded.refs;
  DROP TABLE assistants;
  CREATE INDEX project_settings_by_owner ON project_settings (owner_person) WHERE owner_person IS NOT NULL;
