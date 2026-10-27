-- The lead chat (`hub/chat`): each project's messages in order (`seq` 1..n per project, `n` the m<n> id; `data`
-- the ChatMessage), deduped by a human's request and by the record a message was read from (`source`: a lead
-- message, or the history read from orders, steers and asks). `held`: a human message waiting for the project's
-- lead to start. `chat_projects` marks a project whose history was
-- read, and when. An attachment remembers the project it was given to, so the chat can show it.
CREATE TABLE chat_messages (n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL,
    project_id TEXT NOT NULL, seq INTEGER NOT NULL, created_ms INTEGER NOT NULL, request TEXT, source TEXT,
    held INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, UNIQUE (machine_id, project_id, seq));
  CREATE UNIQUE INDEX chat_by_request ON chat_messages (machine_id, project_id, request) WHERE request IS NOT NULL;
  CREATE UNIQUE INDEX chat_by_source ON chat_messages (machine_id, project_id, source) WHERE source IS NOT NULL;
  CREATE TABLE chat_projects (machine_id TEXT NOT NULL, project_id TEXT NOT NULL, history_ms INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id)) WITHOUT ROWID;
  ALTER TABLE attachments ADD COLUMN project TEXT;
