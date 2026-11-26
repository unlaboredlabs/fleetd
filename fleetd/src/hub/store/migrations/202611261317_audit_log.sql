-- The workspace's audit log (hub/audit, `audit_list`): one row per thing a person or agent did that an admin may need
-- to answer for later, who did it and on which bot or item, by name as it was then. Never a value or chat content.
-- `kind` is area.verb (person.joined, bot.settings, vault.revealed, …); `actor_kind` person, agent, workspace or staff;
-- `outcome` ok, refused or failed; `data` a JSON object of ids that go with it. Rows stay a year, then go; erasing a
-- bot or removing a machine leaves its rows.
CREATE TABLE audit_log (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    person_id TEXT,
    actor_name TEXT NOT NULL,
    machine_id TEXT,
    project_id TEXT,
    bot_name TEXT,
    target TEXT,
    outcome TEXT NOT NULL,
    summary TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
  );
CREATE INDEX audit_log_by_time ON audit_log (at_ms);
CREATE INDEX audit_log_by_person ON audit_log (person_id, n);
CREATE INDEX audit_log_by_project ON audit_log (project_id, n);
CREATE INDEX audit_log_by_kind ON audit_log (kind, n);
