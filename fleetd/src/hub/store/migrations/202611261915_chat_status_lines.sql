-- A bot's status line (`checklist`'s `status`): the short line its lead last wrote on where things stand, which the sidebar and
-- the phone's chat list show under the bot's name in place of its newest message. One per bot; a person's message
-- after `at_ms` sets it aside (hub/chat/status_line.ts).
CREATE TABLE chat_status_lines (
    machine_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    line TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id)
);
