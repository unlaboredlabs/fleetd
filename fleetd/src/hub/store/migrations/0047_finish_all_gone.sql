-- Finish-all went: children forget their parent, an idle finish-all (nothing left to do) is done, and the
-- finish-all playbook's pins go.
UPDATE workstreams SET data = json_remove(data, '$.parent') WHERE json_valid(data);
  UPDATE workstreams SET state = 'done', data = json_set(data, '$.state', 'done') WHERE state = 'idle' AND json_valid(data);
  UPDATE workstreams SET data = json_remove(data, '$.playbook')
    WHERE json_valid(data) AND json_extract(data, '$.playbook') LIKE 'finish-all@%';
  DELETE FROM playbook_versions WHERE ref LIKE 'finish-all@%';
