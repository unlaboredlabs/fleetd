-- People open screens themselves (D239): a session the hub placed for a person rather than an agent names them
-- (`person_id`), and a person's request for a full machine waits in `screen_waits` for its next free slot, ahead of
-- every agent's start, until it is taken, given up or past its time.
ALTER TABLE session_places ADD COLUMN person_id TEXT;
  CREATE TABLE screen_waits (
    wait_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, device TEXT NOT NULL, machine_id TEXT NOT NULL,
    project_id TEXT NOT NULL, runner_id TEXT NOT NULL, kind TEXT NOT NULL, since_ms INTEGER NOT NULL
  );
  CREATE INDEX screen_waits_by_runner ON screen_waits (runner_id, since_ms);
