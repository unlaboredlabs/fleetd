-- Revyl was removed from fleetd (D576): the team's sealed Revyl key and its routes go, and screens no longer say they
-- ran there. A hub that had a key connected keeps one line saying so (`providers_removed`, hub/sandbox/removed.ts),
-- which Settings › Hub › Machines' Providers shows for 30 days from `at_ms`.
CREATE TABLE providers_removed (
  provider TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL
);
INSERT INTO providers_removed (provider, at_ms)
  SELECT 'revyl', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM revyl_account WHERE sealed IS NOT NULL;
DROP TABLE revyl_account;
UPDATE browser_sessions SET data = json_remove(data, '$.source')
  WHERE json_valid(data) AND json_extract(data, '$.source') IS NOT NULL;
