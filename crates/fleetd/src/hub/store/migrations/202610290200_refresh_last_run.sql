-- How a project's last memory refresh went (a `MemoryRefreshRun` as JSON): when, done, failed or skipped and why, and
-- what it changed, for its row on the Automations page (hub/memory/refresh).
ALTER TABLE memory_refreshes ADD COLUMN last_run TEXT;
