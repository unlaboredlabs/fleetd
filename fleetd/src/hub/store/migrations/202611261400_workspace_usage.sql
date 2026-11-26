-- Settings › Workspace › Usage: one row per thing it counts, folded from the tables that keep it (workspace_usage/), so
-- a period reads an index on time rather than every row's JSON. A message a person wrote to a lead, an order, an agent
-- started, an agent failed, an order stopped, an approval or secret request answered: when, on which bot, and the person
-- it counts for (none: the order's starter's, through `workstream_id`). Counts only: nothing of what was said.
CREATE TABLE usage_facts (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workstream_id TEXT,
  person_id TEXT,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;
-- Covering what a period's read takes, so it never visits the rows.
CREATE INDEX usage_facts_by_time ON usage_facts (at_ms, kind, machine_id, project_id, workstream_id, person_id);
CREATE INDEX usage_facts_by_order ON usage_facts (workstream_id) WHERE workstream_id IS NOT NULL;

-- How far each source table has been folded: the last row (`n`) read.
CREATE TABLE usage_cursors (source TEXT PRIMARY KEY, n INTEGER NOT NULL);
