-- The questions tool went: a lead asks in chat. What a chat can't carry safely stays a request (Q<n>): a secret, or
-- an approval of a command or a tool prompt. Open secret and approve asks carry on as open requests under the same
-- number; every ask is kept as it was in `legacy_asks`, which the chat's history renders; batches, their items and
-- ask incident markers go, and so do the ask events no reader decodes any more.
CREATE TABLE requests (n INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, created_ms INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX requests_by_project ON requests (project_key, n);
  CREATE INDEX requests_unsettled ON requests (state) WHERE state IN ('open', 'approved');
  INSERT INTO requests (n, project_key, kind, state, created_ms, data)
    SELECT n, project_key,
      CASE json_extract(data, '$.kind') WHEN 'secret' THEN 'secret' ELSE 'approval' END, 'open', created_ms,
      json_object(
        'requestId', 'Q' || n,
        'projectRef', json(json_extract(data, '$.projectRef')),
        'workstreamId', json_extract(data, '$.workstreamId'),
        'kind', CASE json_extract(data, '$.kind') WHEN 'secret' THEN 'secret' ELSE 'approval' END,
        'text', json_extract(data, '$.text'),
        'state', 'open',
        'secret', CASE json_extract(data, '$.kind') WHEN 'secret' THEN json_object(
          'key', json_extract(data, '$.key'), 'sink', json_extract(data, '$.sink'),
          'envName', json_extract(data, '$.envName')) END,
        'gated', json(json_extract(data, '$.gated')),
        'permission', json(json_extract(data, '$.permission')),
        'evidence', CASE WHEN state = 'open' THEN json_extract(data, '$.evidence')
          ELSE 'not run: the hub was updated before it ran; approve again to run it' END,
        'createdAt', json_extract(data, '$.createdAt'))
    FROM asks
    WHERE json_valid(data) AND json_extract(data, '$.projectRef') IS NOT NULL AND (
      (state = 'open' AND json_extract(data, '$.kind') IN ('secret', 'approve'))
      -- approved, but its command never ran (or its result never came back): back to the human, never run late
      OR (state = 'answered' AND json_extract(data, '$.kind') = 'approve' AND json_extract(data, '$.gated') IS NOT NULL
        AND json_extract(data, '$.answer.value') = 'go'
        AND coalesce(json_extract(data, '$.evidence'), '') NOT GLOB 'exit *'
        AND coalesce(json_extract(data, '$.evidence'), '') NOT GLOB 'killed after *'
        AND coalesce(json_extract(data, '$.evidence'), '') NOT GLOB 'not run on *'));
  ALTER TABLE asks RENAME TO legacy_asks;
  DROP INDEX IF EXISTS asks_open_by_key;
  DROP INDEX IF EXISTS asks_by_batch;
  DROP TABLE batch_items;
  DROP TABLE batches;
  DROP TABLE ask_incidents;
  DELETE FROM events WHERE type IN ('ask.created', 'ask.auto', 'ask.closed', 'ask.answered', 'ask.undone',
    'ask.delivered', 'batch.ready', 'ask.secret_saved', 'gated.ran');
  CREATE TABLE intake_routes_new (client_request_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  INSERT INTO intake_routes_new SELECT client_request_id, data FROM intake_routes;
  DROP TABLE intake_routes;
  ALTER TABLE intake_routes_new RENAME TO intake_routes;
  -- A gate change that was asked is pending again, settled by its playbook.* decision.
  UPDATE retro_proposals SET state = 'pending',
    data = CASE WHEN json_valid(data) THEN json_remove(json_set(data, '$.state', 'pending'), '$.askId') ELSE data END
    WHERE state = 'asked';
  UPDATE retro_proposals SET data = json_remove(data, '$.askId') WHERE json_valid(data);
  ALTER TABLE retro_proposals DROP COLUMN ask_id;
  -- The ask batching and info spans: nothing records them any more, and their kinds no longer exist.
  DELETE FROM time_spans WHERE kind IN (42, 43);
