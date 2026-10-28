-- Task profiles become rows (W146): any number, each with a unique name, a one-line note the lead picks by, a model,
-- an effort and fast mode; exactly one is the hub's default. `high` (the default) and `medium` come over with the
-- model and effort the fleet's settings ran them on, the runner's own (claude-opus-5-5 at high, at medium) where none
-- did or claude refused the one set. A project's overrides go (store/db.rs logs each): a project wanting another
-- model gets a profile of its own. `project_profiles` is what each project allows besides the default, which every
-- project does: medium, for each project whose switch was on (on by default), and the switch goes.
CREATE TABLE profiles (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, note TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
    fast INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0, refused TEXT, set_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX profiles_one_default ON profiles (is_default) WHERE is_default = 1;
  CREATE INDEX profiles_by_model ON profiles (model);
  INSERT INTO profiles (id, name, note, model, effort, is_default, set_at)
    SELECT 1, 'high', 'The default: design, architecture and anything subtle. When in doubt, this one.',
      COALESCE((SELECT model FROM profile_settings
                WHERE machine_id = '' AND project_id = '' AND profile = 'high' AND refused IS NULL), 'claude-opus-5-5'),
      COALESCE((SELECT effort FROM profile_settings
                WHERE machine_id = '' AND project_id = '' AND profile = 'high'), 'high'),
      1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  INSERT INTO profiles (id, name, note, model, effort, is_default, set_at)
    SELECT 2, 'medium', 'Only for mechanical work: dead-code deletions, renames, test removals, doc fixes, moving files, '
      || 'plain wiring, screenshot recaptures, cleanup. Never for design, architecture or anything subtle (concurrency, '
      || 'the runner, auth and secrets, approvals, the merge train, status math).',
      COALESCE((SELECT model FROM profile_settings
                WHERE machine_id = '' AND project_id = '' AND profile = 'medium' AND refused IS NULL), 'claude-opus-5-5'),
      COALESCE((SELECT effort FROM profile_settings
                WHERE machine_id = '' AND project_id = '' AND profile = 'medium'), 'medium'),
      0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  CREATE TABLE project_profiles (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, profile_id INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id, profile_id)
  );
  INSERT INTO project_profiles (machine_id, project_id, profile_id)
    SELECT p.machine_id, p.project_id, 2 FROM projects p
    WHERE NOT EXISTS (SELECT 1 FROM project_settings s
                      WHERE s.machine_id = p.machine_id AND s.project_id = p.project_id AND s.medium_allowed = 0);
  ALTER TABLE project_settings DROP COLUMN medium_allowed;
  DROP TABLE profile_settings;
