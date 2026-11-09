-- The retro went: its runs and proposals, its events and its incident class. A playbook change still waiting on a
-- person is denied, since nothing would apply it.
DROP TABLE retro_runs;
  DROP TABLE retro_proposals;
  DELETE FROM events WHERE type IN ('retro.ran', 'playbook.changed', 'playbook.reverted', 'playbook.kept');
  DELETE FROM incidents WHERE class = 'playbook_reverted';
  UPDATE requests SET state = 'denied', data = json_set(data, '$.state', 'denied')
    WHERE state = 'open' AND json_valid(data) AND json_extract(data, '$.playbook') IS NOT NULL;
