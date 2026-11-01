-- W264: a YOLO Navi's auto-runs post nothing in its chat (hub/navi/checker). The lines already posted go, but only
-- those with a later message that stays: a chat's newest seq never goes back, since a new message takes the highest
-- seq plus one and readers (Telegram, memory refresh) keep a "seen up to seq" mark. Their log entries stay, without
-- the link to a deleted line.
DELETE FROM chat_messages WHERE json_valid(data) AND json_extract(data, '$.author') = 'system'
    AND json_extract(data, '$.text') LIKE 'Ran without asking you (YOLO):%'
    AND EXISTS (SELECT 1 FROM chat_messages later
        WHERE later.machine_id = chat_messages.machine_id AND later.project_id = chat_messages.project_id
          AND later.seq > chat_messages.seq
          AND NOT (json_valid(later.data) AND json_extract(later.data, '$.author') = 'system'
            AND json_extract(later.data, '$.text') LIKE 'Ran without asking you (YOLO):%'));
UPDATE navi_auto_approved SET data = json_remove(data, '$.messageId')
    WHERE json_valid(data) AND json_extract(data, '$.by') = 'yolo'
      AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE 'm' || m.n = json_extract(navi_auto_approved.data, '$.messageId'));
