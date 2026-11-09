-- W533: agents write to each other (`agent_message`), kept for the person to read and audit (`agent_messages`).
-- `agent_messages` is one message, `n` its M<n> id; `agent_message_to` one row per recipient, in the order the sender
-- named them (`pos`): the steer that delivers it (`steer_n`, none when refused) and where it stands (`outcome`
-- delivered|held|woke|refused, since `at_ms`, with `detail`).
CREATE TABLE agent_messages (n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    from_task TEXT NOT NULL, from_title TEXT NOT NULL, text TEXT NOT NULL, sent_ms INTEGER NOT NULL);
  CREATE INDEX agent_messages_by_project ON agent_messages (machine_id, project_id, n);
  CREATE INDEX agent_messages_by_sender ON agent_messages (from_task, sent_ms);
CREATE TABLE agent_message_to (message_n INTEGER NOT NULL, pos INTEGER NOT NULL, task_id TEXT NOT NULL, title TEXT,
    steer_n INTEGER, outcome TEXT NOT NULL, at_ms INTEGER, detail TEXT, PRIMARY KEY (message_n, pos));
  CREATE INDEX agent_message_to_by_task ON agent_message_to (task_id, message_n);
  CREATE INDEX agent_message_to_by_steer ON agent_message_to (steer_n) WHERE steer_n IS NOT NULL;
