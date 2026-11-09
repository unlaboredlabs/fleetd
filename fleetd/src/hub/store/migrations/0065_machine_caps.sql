-- Each machine's cap: what it fits as last measured (kept while it is offline) and a person's setting, if any.
CREATE TABLE slot_machine_caps (
    machine_id TEXT PRIMARY KEY, name TEXT NOT NULL, auto INTEGER NOT NULL, why TEXT NOT NULL, max_agents INTEGER
  );
