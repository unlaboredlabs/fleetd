-- E2B and Daytona were removed from fleetd (D576): their boxes can't run Android's emulator (shared/sandbox.ts REMOVED
-- says why). A hub that had one connected keeps one line saying so (`providers_removed`, hub/sandbox/removed.ts) and
-- loses its sealed key; a bot that picked one for its agents' computer goes back to the default; a Linux machine that
-- named one goes back to machines first. Agents place by what remains.
INSERT OR REPLACE INTO providers_removed (provider, at_ms)
  SELECT provider, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM sandbox_providers WHERE provider IN ('e2b', 'daytona');
DELETE FROM sandbox_providers WHERE provider IN ('e2b', 'daytona');
UPDATE project_settings SET computer = NULL
  WHERE computer IS NOT NULL AND json_valid(computer) AND json_extract(computer, '$.kind') IN ('e2b', 'daytona');
DELETE FROM sandbox_settings WHERE key = 'linux' AND value IN ('e2b', 'daytona');
