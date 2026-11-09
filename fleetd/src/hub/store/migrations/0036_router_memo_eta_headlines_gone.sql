-- The router's retry memo, the ETA anchor and the generated headlines: nothing reads or writes them, and nothing
-- emits these two event types any more.
DROP TABLE intake_routes;
  DROP TABLE status_eta;
  DROP TABLE status_headlines;
  DELETE FROM events WHERE type IN ('intake.routed', 'workstream.note');
