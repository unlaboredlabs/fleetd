-- A workstream is open, done or stopped: a draft is an open one with no brief. Its stored JSON keeps the older
-- name, which reads back through the enum's aliases. The playbook-change approvals the retro left, and their chat
-- items, go.
UPDATE workstreams SET state = CASE WHEN state = 'failed' THEN 'stopped' ELSE 'open' END
    WHERE state NOT IN ('done', 'stopped');
  DELETE FROM chat_messages WHERE json_valid(data) AND json_type(data, '$.item.playbook') IS NOT NULL;
  DELETE FROM requests WHERE json_valid(data) AND json_type(data, '$.playbook') IS NOT NULL;
