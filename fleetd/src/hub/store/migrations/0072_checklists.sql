-- Each project's checklist, the lead's to-do list for the human: its items in order, and the next item id.
CREATE TABLE checklists (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, next_id INTEGER NOT NULL, items TEXT NOT NULL,
    updated_ms INTEGER NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
