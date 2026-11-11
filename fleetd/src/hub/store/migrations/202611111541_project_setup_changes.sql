-- What a lead's setup call changed (`repo_add`, `repo_remove`, `project_setup`; W614), kept so a person's Undo on its
-- chat line puts back what was there: `before` is JSON by the change's kind (projects/calls.ts `Before`), `picture`
-- the project's picture before a change of its look. A row goes when its change is undone, and with its project.
CREATE TABLE project_setup_changes (
  message_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  before TEXT NOT NULL,
  picture BLOB,
  at_ms INTEGER NOT NULL
);
CREATE INDEX project_setup_changes_project ON project_setup_changes (machine_id, project_id);

-- A clone a lead's `repo_add` started and whose end the hub still owes the lead a wake for. One left at the hub's
-- start was cut off by a restart: the lead is told to call repo_add again.
CREATE TABLE project_setup_clones (
  add_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL
);
