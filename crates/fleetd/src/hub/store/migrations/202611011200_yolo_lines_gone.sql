-- W264: a YOLO Navi's auto-runs post nothing in its chat (hub/navi/checker). The lines already posted go, and their
-- log entries, which stay, no longer link to them.
DELETE FROM chat_messages WHERE json_valid(data) AND json_extract(data, '$.author') = 'system'
    AND json_extract(data, '$.text') LIKE 'Ran without asking you (YOLO):%';
UPDATE navi_auto_approved SET data = json_remove(data, '$.messageId')
    WHERE json_valid(data) AND json_extract(data, '$.by') = 'yolo';
