-- W367: artifacts, the reports a lead, task or Navi publishes in its project's chat (artifact_publish). Each publish
-- of a name keeps a version: its title, format (md or html), who published it, when, and the whole content.
CREATE TABLE artifact_versions (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
  title TEXT NOT NULL, format TEXT NOT NULL, by_name TEXT NOT NULL, content TEXT NOT NULL, at_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, project_id, name, version)
);
