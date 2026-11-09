-- Playbooks went: a workstream pins none, and the pinned texts go.
DROP TABLE playbook_versions;
  UPDATE workstreams SET data = json_remove(data, '$.playbook') WHERE json_valid(data);
