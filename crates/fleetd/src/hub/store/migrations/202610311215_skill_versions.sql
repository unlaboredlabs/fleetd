-- W238: every write of a hub-kept skill's SKILL.md kept as a version (a Navi's skill_save, a person's edit or revert,
-- an install): who, when, why and the whole text. A global skill's rows have empty machine_id and project_id.
CREATE TABLE skill_versions (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
  author TEXT NOT NULL, by_name TEXT NOT NULL, why TEXT, text TEXT NOT NULL, at_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, project_id, name, version)
);
-- A skill as one project's sessions get it: turned off there (skill_off), and when one of them last ran it.
CREATE TABLE skill_uses (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, off INTEGER NOT NULL DEFAULT 0,
  last_used_ms INTEGER, PRIMARY KEY (machine_id, project_id, name)
);
