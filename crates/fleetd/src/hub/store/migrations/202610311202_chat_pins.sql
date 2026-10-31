-- W232: each person's own pinned chats, as chat_pins_get shows them (a JSON array of project refs, in their order).
-- One row per person; none until they first pin or send up their phone's pins.
CREATE TABLE chat_pins (person_id TEXT PRIMARY KEY, refs TEXT NOT NULL);
