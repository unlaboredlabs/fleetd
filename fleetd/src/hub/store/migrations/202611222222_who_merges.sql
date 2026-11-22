-- Who merges a bot's PRs (`project_settings_set` merges): 'fleetd', its merge train, or NULL, people, the default for
-- a bot made from now on, whose PRs the train reviews and keeps up to date, and merges only as its risk rules allow.
-- Every bot this hub has already keeps the train merging, so nothing changes under anyone. `merge_rules` holds a
-- bot's risk rules as JSON ({"itself": [...], "person": [...]}); NULL is the defaults (hub/train/merge_rules.ts).
ALTER TABLE project_settings ADD COLUMN merges TEXT;
ALTER TABLE project_settings ADD COLUMN merge_rules TEXT;
INSERT INTO project_settings (machine_id, project_id) SELECT machine_id, project_id FROM projects WHERE true
  ON CONFLICT (machine_id, project_id) DO NOTHING;
UPDATE project_settings SET merges = 'fleetd';
