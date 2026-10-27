-- A file sent in pieces (attachment_part) until attachment_put stores it: the pieces so far live under
-- <home>/attachments/uploads/<id>. And the memory caps a hub admin set; a cap without a row has its default.
CREATE TABLE attachment_uploads (
    id TEXT PRIMARY KEY, by TEXT NOT NULL, bytes INTEGER NOT NULL, touched_ms INTEGER NOT NULL
  );
  CREATE TABLE memory_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
