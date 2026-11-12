-- The last Navi names go (D317, D327, D491): what the hub keeps under them now goes by the project's.
-- Tables and their indexes: a project's asks of other projects and the orders opened for them, its allowed sites, its
-- approval mode, what it ran without asking, and the projects whose erase was asked for.
ALTER TABLE navi_asks RENAME TO project_asks;
DROP INDEX navi_asks_by_from;
CREATE INDEX project_asks_by_from ON project_asks (from_machine_id, from_project_id, n DESC);
DROP INDEX navi_asks_by_remote;
CREATE INDEX project_asks_by_remote ON project_asks (to_hub, remote);
ALTER TABLE navi_ask_orders RENAME TO project_ask_orders;
DROP INDEX navi_ask_orders_by_n;
CREATE INDEX project_ask_orders_by_n ON project_ask_orders (n);
ALTER TABLE navi_sites RENAME TO project_sites;
ALTER TABLE navi_approvals RENAME TO project_approvals;
ALTER TABLE navi_auto_approved RENAME TO project_auto_approved;
DROP INDEX navi_auto_approved_by_navi;
CREATE INDEX project_auto_approved_by_project ON project_auto_approved (machine_id, project_id, n);
ALTER TABLE navi_erases RENAME TO project_erases;

-- The ask bridge's place in the event log, and the name a secure input's request goes by (only a name: a request
-- under the old one is answered as before).
UPDATE time_cursors SET source = 'project.bridge' WHERE source = 'navi.bridge';
UPDATE requests SET data = json_set(data, '$.secret.key', 'browser.secure_input')
  WHERE kind = 'secret' AND json_extract(data, '$.secret.key') = 'navi.secure_input';

-- No project has a kind: a node's report kept from before it said `assistant` for one with no repo.
UPDATE projects SET data = json_remove(data, '$.kind') WHERE json_extract(data, '$.kind') IS NOT NULL;

-- Prompts renamed in D310, old id first: the hub moves a person's overrides of them to the new id at its start
-- (prompts/store.ts `moveRenamed`), and the texts sessions were pinned to follow here.
CREATE TABLE prompt_renames (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
INSERT INTO prompt_renames (old_id, new_id) VALUES
  ('navi.start', 'assistant.start'),
  ('navi.voice', 'assistant.voice'),
  ('navi.checker', 'approvals.checker');
UPDATE OR IGNORE prompt_versions SET ref = (SELECT new_id FROM prompt_renames WHERE ref LIKE old_id || '@%') || substr(ref, instr(ref, '@'))
  WHERE EXISTS (SELECT 1 FROM prompt_renames WHERE ref LIKE old_id || '@%');
DELETE FROM prompt_versions WHERE EXISTS (SELECT 1 FROM prompt_renames WHERE ref LIKE old_id || '@%');
UPDATE session_prompts SET refs = replace(replace(replace(refs,
    '"navi.start', '"assistant.start'), '"navi.voice', '"assistant.voice'), '"navi.checker', '"approvals.checker')
  WHERE refs LIKE '%"navi.%';
