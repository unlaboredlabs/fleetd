-- Teams step 8 (D200): which Claude account each agent runs on. `claude_accounts`: one row per account (`hub`, or a
-- person's id), `data` as the tools show it (the hub's endpoint, or a subscription) with each node's fingerprint, never
-- the key or token. `claude_choices`: what each person picked. `claude_settings`: hub-wide switches, no row meaning
-- the default. `thread_accounts`: the account each session was launched on, which its usage pauses follow.
CREATE TABLE claude_accounts (account TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE claude_choices (person_id TEXT PRIMARY KEY, choice TEXT NOT NULL);
CREATE TABLE claude_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE thread_accounts (
  machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, account TEXT NOT NULL,
  PRIMARY KEY (machine_id, thread_id)
);
