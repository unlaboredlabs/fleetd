-- W736: a note to the whole bot (`agent_message` to: ["bot"]) is an agent message with `to_bot` set and no
-- `agent_message_to` rows. Its bot's agents read the newest at the top of `agents` while its sender's task is live,
-- 24 h at most; the person reads it in the log with the rest.
ALTER TABLE agent_messages ADD COLUMN to_bot INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX agent_messages_notes ON agent_messages (machine_id, project_id, sent_ms) WHERE to_bot = 1;
