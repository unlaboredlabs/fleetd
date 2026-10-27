-- The ledger: decisions with their FTS5 index, asks, batches and incident markers.
CREATE TABLE decisions (
    n INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
    project_key TEXT, state TEXT NOT NULL, source TEXT NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX decisions_active_by_key ON decisions (key, scope_kind, scope_id) WHERE state = 'active';
  CREATE INDEX decisions_by_project ON decisions (project_key, at_ms);
  CREATE VIRTUAL TABLE decisions_fts USING fts5 (key, value, why);
  CREATE TABLE asks (
    n INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, workstream_id TEXT, key TEXT NOT NULL,
    state TEXT NOT NULL, filed_by TEXT NOT NULL, batch_n INTEGER, created_ms INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX asks_open_by_key ON asks (project_key, key) WHERE state = 'open';
  CREATE INDEX asks_by_batch ON asks (batch_n);
  CREATE TABLE batches (
    n INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, created_ms INTEGER NOT NULL, last_add_ms INTEGER,
    published_ms INTEGER
  );
  CREATE TABLE batch_items (
    batch_n INTEGER NOT NULL, number INTEGER NOT NULL, ask_n INTEGER NOT NULL, PRIMARY KEY (batch_n, number)
  );
  CREATE TABLE ask_incidents (
    ask_n INTEGER NOT NULL, kind TEXT NOT NULL, project_key TEXT NOT NULL, at_ms INTEGER NOT NULL,
    PRIMARY KEY (ask_n, kind)
  );
