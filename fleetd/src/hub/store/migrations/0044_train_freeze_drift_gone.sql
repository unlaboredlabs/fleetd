-- Train freeze, drift and opt-in GitHub webhooks went. A merge outside the train is reported once by moving the
-- train's watch past it, so the watch starts now: merges already reported stay reported.
DROP TABLE train_bypasses;
  DROP TABLE github_hooks;
  ALTER TABLE trains DROP COLUMN frozen;
  UPDATE trains SET watch_since_ms = max(watch_since_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  DELETE FROM events WHERE type IN ('train.frozen', 'train.resumed', 'github.drift');
