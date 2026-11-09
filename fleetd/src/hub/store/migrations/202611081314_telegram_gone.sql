-- Telegram was removed from fleetd (D339): its bridges and approval cards go, with what it left in the chats. A
-- message written there becomes one with no client and no key name. One forwarded there, someone else's words,
-- becomes one from the share sheet, which is no go-ahead either, with its sender at the start of its text. The
-- "Telegram paired with" and "Telegram unpaired:" lines go, as do the settings events of an unpair or remove; the
-- chat events of what stays change as the messages do, and those of the lines that went go too.
DROP TABLE telegram_bridges;
DROP TABLE telegram_cards;
UPDATE chat_messages
  SET data = json_set(json_remove(data, '$.forwardedFrom', '$.by'), '$.client', 'share', '$.text',
    'Forwarded from ' || json_extract(data, '$.forwardedFrom') || ': ' || json_extract(data, '$.text'))
  WHERE json_valid(data) AND json_extract(data, '$.forwardedFrom') IS NOT NULL;
UPDATE chat_messages SET data = json_remove(data, '$.client', '$.by')
  WHERE json_valid(data) AND json_extract(data, '$.client') = 'telegram';
DELETE FROM chat_messages WHERE json_valid(data) AND json_extract(data, '$.author') = 'system'
  AND (json_extract(data, '$.text') LIKE 'Telegram paired with %'
    OR json_extract(data, '$.text') LIKE 'Telegram unpaired: %');
DELETE FROM events WHERE type = 'chat.message' AND json_valid(data)
  AND json_extract(data, '$.message.author') = 'system'
  AND (json_extract(data, '$.message.text') LIKE 'Telegram paired with %'
    OR json_extract(data, '$.message.text') LIKE 'Telegram unpaired: %');
UPDATE events
  SET data = json_set(json_remove(data, '$.message.forwardedFrom', '$.message.by'), '$.message.client', 'share',
    '$.message.text', 'Forwarded from ' || json_extract(data, '$.message.forwardedFrom') || ': '
      || json_extract(data, '$.message.text'))
  WHERE type = 'chat.message' AND json_valid(data) AND json_extract(data, '$.message.forwardedFrom') IS NOT NULL;
UPDATE events SET data = json_remove(data, '$.message.client', '$.message.by')
  WHERE type = 'chat.message' AND json_valid(data) AND json_extract(data, '$.message.client') = 'telegram';
DELETE FROM events WHERE type = 'project.settings' AND json_valid(data)
  AND json_extract(data, '$.telegram') IS NOT NULL;
