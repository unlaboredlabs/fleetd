-- W210: the built-in icon a person picked for a project or Navi (project_icon_set): a glass being's face on a field of
-- a color, each by its name. A project without a row wears one derived from its id.
CREATE TABLE project_icons (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, face TEXT NOT NULL, color TEXT NOT NULL, set_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, project_id)
);
