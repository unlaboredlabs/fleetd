-- W239: how a Navi's risky actions are approved (hub/navi/checker). A Navi with no row asks its checker; a NULL model
-- or effort is the hub's default. The sessions the checker ran, each a tool-less turn on the owner's own Claude, are
-- the hub's own, so the sweep never reports one as a session nobody owns. Every action that ran without asking the
-- person (the checker said go, or the Navi is in YOLO) is logged, with the chat line that told them.
CREATE TABLE navi_approvals (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL, model TEXT, effort TEXT,
  PRIMARY KEY (machine_id, project_id)
);
CREATE TABLE approval_checks (
  machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL, person_id TEXT,
  started_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, thread_id)
);
CREATE TABLE navi_auto_approved (
  n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, at_ms INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX navi_auto_approved_by_navi ON navi_auto_approved (machine_id, project_id, n);
