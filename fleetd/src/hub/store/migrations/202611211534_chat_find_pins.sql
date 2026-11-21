-- W773: a person's chat search and the chat's pinned messages.
--
-- `chat_find` is the chats' search index (hub/chat/find.ts), one row per message by chat_messages' n: its text, and
-- `tags`, the words its filters match (its bot, who wrote it, what it holds, its day and month). A plain FTS5 table,
-- which every SQLite a hub runs on has (macOS 12's 3.37 among them): it keeps a copy of the text. The chat keeps it
-- current as messages are written, and fills it for the messages already there in small steps from the newest down
-- while the hub runs: those below `chat_find_built.below` are still to do.
CREATE VIRTUAL TABLE chat_find USING fts5(text, tags, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
CREATE TABLE chat_find_built (below INTEGER NOT NULL);
INSERT INTO chat_find_built (below) SELECT COALESCE(MAX(n), 0) + 1 FROM chat_messages;
-- A date filter with one end reads the chat's first or last moment by time.
CREATE INDEX chat_by_time ON chat_messages (machine_id, project_id, created_ms);
--
-- The messages pinned in a bot's chat, the same for everyone in it (chat_message_pins), with who pinned each and
-- when. A message is `m<n>` by chat_messages' n; a pin whose message is gone is left out of the list and dropped on
-- the chat's next pin write.
CREATE TABLE chat_message_pins (
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  message_n INTEGER NOT NULL,
  pinned_ms INTEGER NOT NULL,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  PRIMARY KEY (machine_id, project_id, message_n)
);
