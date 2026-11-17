-- The tagged chat no longer folds a closed order's messages into one line (W687): the fold the hub kept on a chat
-- message goes, from the messages and from the chat events that carried them.
UPDATE chat_messages SET data = json_remove(data, '$.fold')
  WHERE json_valid(data) AND json_extract(data, '$.fold') IS NOT NULL;
UPDATE events SET data = json_remove(data, '$.message.fold')
  WHERE type = 'chat.message' AND json_valid(data) AND json_extract(data, '$.message.fold') IS NOT NULL;
