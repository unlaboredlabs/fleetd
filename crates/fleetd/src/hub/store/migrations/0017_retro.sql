-- M12 retro: each run (`turned` when it spent a claude turn, which the daily budget counts) and each proposal it
-- kept. A change that applied keeps the override file it replaced (`had_override` 0: none, the bundled one was in
-- use; NULL: not applied) so a revert can restore it.
CREATE TABLE retro_runs (
    n INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, trigger TEXT NOT NULL, threshold_class TEXT,
    turned INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
  );
  CREATE TABLE retro_proposals (
    n INTEGER PRIMARY KEY AUTOINCREMENT, run_n INTEGER NOT NULL, playbook TEXT NOT NULL, state TEXT NOT NULL,
    ask_id TEXT, due_ms INTEGER, machines TEXT NOT NULL, had_override INTEGER, previous_override TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX retro_proposals_by_state ON retro_proposals (state, due_ms);
