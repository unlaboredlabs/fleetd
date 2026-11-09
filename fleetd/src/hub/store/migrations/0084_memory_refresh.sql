-- The nightly memory refresh (hub/memory/refresh): whether a project has it (on unless a person turned it off),
-- and per project the chat it last read, the night it last ran for, and the refresh running now with what it
-- changed so far (`RememberedItem`s as JSON); and per "Memory refreshed" line every change it stands for, which
-- Undo all takes back past the ones the line lists.
ALTER TABLE project_settings ADD COLUMN memory_refresh INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE memory_refreshes (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, watermark INTEGER NOT NULL DEFAULT 0, night_ms INTEGER,
    thread_id TEXT, started_ms INTEGER, read_to INTEGER, items TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (machine_id, project_id)
  );
  CREATE INDEX memory_refreshes_by_thread ON memory_refreshes (machine_id, thread_id);
  CREATE TABLE memory_refresh_lines (
    message_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, items TEXT NOT NULL
  );
