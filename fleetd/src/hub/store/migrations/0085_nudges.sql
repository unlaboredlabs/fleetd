-- Nudges (W96): the project's messages whose nudge still waits, the chat state reads on every read. Only those
-- are in it: a nudge seen, dismissed, replaced or expired leaves. `chat::nudges` asks with this same condition.
CREATE INDEX chat_nudges_waiting ON chat_messages (machine_id, project_id, seq)
    WHERE json_extract(data, '$.nudge') IS NOT NULL AND json_extract(data, '$.nudge.cleared') IS NULL;
