-- Navi's factory bridge (W97): each `project_message` (`n` is its `N<n>` handle, never reused) from a Navi's
-- project to another, and the orders that project's lead opened for it.
CREATE TABLE navi_asks (
    n INTEGER PRIMARY KEY AUTOINCREMENT, from_machine_id TEXT NOT NULL, from_project_id TEXT NOT NULL,
    to_machine_id TEXT NOT NULL, to_project_id TEXT NOT NULL, text TEXT NOT NULL, at_ms INTEGER NOT NULL
  );
  CREATE INDEX navi_asks_by_from ON navi_asks (from_machine_id, from_project_id, n DESC);
  CREATE TABLE navi_ask_orders (workstream_id TEXT PRIMARY KEY, n INTEGER NOT NULL);
