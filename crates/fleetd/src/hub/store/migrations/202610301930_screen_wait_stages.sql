-- A person's screen on its way keeps its row until it is theirs (D239): `stage` says where it is (waiting in line,
-- starting, installing a PR's build, failed), `thread_id` the screen's thread once it starts, `error` why it failed.
ALTER TABLE screen_waits ADD COLUMN stage TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE screen_waits ADD COLUMN thread_id TEXT;
ALTER TABLE screen_waits ADD COLUMN error TEXT;
