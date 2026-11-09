-- A lead closes its work and says why: fleetd runs no done-when checks. Done-when becomes plain lines, a
-- workstream left verifying is running again, and the claims, their events and spans and plan items' check links
-- go.
UPDATE workstreams SET data = json_set(data, '$.brief.doneWhen', (
    SELECT json_group_array(substr(CASE WHEN c.type <> 'object' THEN c.value
      ELSE CASE json_extract(c.value, '$.type')
        WHEN 'pr_merged' THEN 'PR ' || coalesce('#' || json_extract(c.value, '$.pr') || ' ', '') || 'merged in '
          || json_extract(c.value, '$.repo')
        WHEN 'ci_green' THEN 'CI green on ' || json_extract(c.value, '$.repo')
          || coalesce('@' || json_extract(c.value, '$.ref'), '')
        WHEN 'http' THEN 'GET ' || json_extract(c.value, '$.url') || ' answers ' || json_extract(c.value, '$.status')
          || coalesce(' containing "' || json_extract(c.value, '$.contains') || '"', '')
        WHEN 'cmd' THEN 'on ' || json_extract(c.value, '$.machineId') || ': `'
          || (SELECT group_concat(a.value, ' ') FROM json_each(c.value, '$.argv') a) || '` exits '
          || json_extract(c.value, '$.expectExit')
        WHEN 'test' THEN 'test ' || json_extract(c.value, '$.testId') || ' passes in ' || json_extract(c.value, '$.repo')
        WHEN 'judge' THEN json_extract(c.value, '$.criteria')
        WHEN 'human' THEN json_extract(c.value, '$.question')
        ELSE c.value END END, 1, 2000))
    FROM json_each(data, '$.brief.doneWhen') c))
    WHERE json_valid(data) AND json_type(data, '$.brief.doneWhen') = 'array';
  UPDATE workstreams SET state = 'running', data = json_set(data, '$.state', 'running')
    WHERE state = 'verifying' AND json_valid(data);
  UPDATE plan_items SET data = json_remove(data, '$.links.checks') WHERE json_valid(data);
  DROP TABLE claims;
  DELETE FROM events WHERE type IN ('claim.passed', 'claim.failed');
  DELETE FROM time_spans WHERE kind = 18;
  DELETE FROM time_rollups WHERE kind = 18;
