-- W791: chat search reads a message as the chat shows it (a block by its words, a link by its label), not its stored
-- text with a block's JSON and a link's target. The index's rows are filled again from the newest down while the hub
-- runs (hub/chat/find.ts fill), with those words; until a row is redone, a search still finds it by its stored text.
UPDATE chat_find_built SET below = (SELECT COALESCE(MAX(n), 0) + 1 FROM chat_messages);
