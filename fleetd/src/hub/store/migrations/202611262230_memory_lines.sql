-- Who taught each line of a bot's memory (hub/memory/lines.ts), shown beside it in the memory list: the person whose
-- message the lead's turn answered, or whose edit in the app wrote it; NULL person_id is the lead's own. One row per
-- line of a project's file, `topic` '' for MEMORY.md; a line goes with its row. A line from before this has no row
-- and shows no author. A line held for an admin's OK is not here: it waits in its chat line until one keeps it.
CREATE TABLE memory_lines (
    machine_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    text TEXT NOT NULL,
    person_id TEXT,
    at_ms INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id, topic, text)
  ) WITHOUT ROWID;
