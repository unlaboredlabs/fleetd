-- Each person's own memory gets one tidy pass a night after the per-bot refreshes, and one at once when a write leaves
-- it past a cap (hub/memory/tidy): per person the chat it last read in each bot (`watermarks`, JSON of
-- "<machine>/<project>" to `seq`), the night it last ran for, when a write past a cap asked for one, the session running
-- now (on its host bot), what it changed so far, whether anything else wrote the person's memory while it ran, the
-- person's files as it found them, a hash of them as it left them, how its last run went, and its last line (with
-- `line` when only the person's Memory page shows it); and per "Memory refreshed" line the files before and after it,
-- which Undo all puts back exactly.
CREATE TABLE memory_tidies (
  person_id TEXT PRIMARY KEY, watermarks TEXT NOT NULL DEFAULT '{}', night_ms INTEGER, due_ms INTEGER,
  host_machine TEXT, host_project TEXT, thread_id TEXT, started_ms INTEGER, trigger TEXT, read_to TEXT,
  items TEXT NOT NULL DEFAULT '[]', outside INTEGER NOT NULL DEFAULT 0, before TEXT, seen TEXT, last_run TEXT, message_id TEXT,
  line TEXT
);
CREATE INDEX memory_tidies_by_thread ON memory_tidies (host_machine, thread_id);
ALTER TABLE memory_refresh_lines ADD COLUMN snapshot TEXT;
