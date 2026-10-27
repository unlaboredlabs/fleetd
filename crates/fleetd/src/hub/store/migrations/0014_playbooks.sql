-- M9 playbooks: the text of every playbook version a workstream pinned, so its brief is checked against that version
-- after the file changes.
CREATE TABLE playbook_versions (ref TEXT PRIMARY KEY, text TEXT NOT NULL);
