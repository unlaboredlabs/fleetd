-- Try it is gone: its tables and the preview settings go, with the rows that no longer decode. A `preview.state`
-- event has no type any more, and an approval of a proposed preview setting holds nothing an approval may hold now;
-- the chat line of an open one is denied, so it offers no Approve. The agents' suggestions stay as plain chat lines.
DROP TABLE previews;
DROP TABLE preview_suggestions;
ALTER TABLE project_settings DROP COLUMN preview;
ALTER TABLE repos DROP COLUMN preview;
DELETE FROM events WHERE type = 'preview.state';
DELETE FROM requests WHERE json_valid(data) AND json_extract(data, '$.previewConfig') IS NOT NULL;
UPDATE chat_messages
  SET data = json_set(json_remove(data, '$.item.previewConfig'), '$.item.state',
    CASE json_extract(data, '$.item.state') WHEN 'open' THEN 'denied' ELSE json_extract(data, '$.item.state') END)
  WHERE json_valid(data) AND json_extract(data, '$.item.previewConfig') IS NOT NULL;
