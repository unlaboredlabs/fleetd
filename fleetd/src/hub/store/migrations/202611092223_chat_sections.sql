-- W580: each person's own sections of chats, as chat_sections_get shows them (a JSON array of { id, name, chats }, the
-- chats project refs, in their order). One row per person; none until they make a section.
CREATE TABLE chat_sections (person_id TEXT PRIMARY KEY, sections TEXT NOT NULL);
