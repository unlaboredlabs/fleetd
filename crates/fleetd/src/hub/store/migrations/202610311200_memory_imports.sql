-- W229: the sessions Import memory ran (hub/memory/import), each a tool-less turn on a person's own Claude that read
-- their pasted export: owned by the hub, so the sweep never reports one as a session nobody owns.
CREATE TABLE memory_imports (
  machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL, person_id TEXT,
  started_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, thread_id)
);
