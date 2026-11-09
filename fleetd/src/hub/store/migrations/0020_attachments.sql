-- Files a person attached to an order or a note: the bytes live under <home>/attachments/<sha256>.
-- `workstream_id` is set once delivered; rows still without one after 24 h are deleted.
CREATE TABLE attachments (
    n INTEGER PRIMARY KEY AUTOINCREMENT, sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    bytes INTEGER NOT NULL, by TEXT NOT NULL, created_ms INTEGER NOT NULL, workstream_id TEXT
  );
