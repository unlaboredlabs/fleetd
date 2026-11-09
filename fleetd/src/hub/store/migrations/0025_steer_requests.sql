-- A steer's request (`steer:<sender>:<clientRequestId>`), so a resent request finds its steer at any stage, also
-- after its run id changed when it was bound to a task's next run.
ALTER TABLE steers ADD COLUMN request TEXT;
  CREATE UNIQUE INDEX steers_by_request ON steers (request) WHERE request IS NOT NULL;
