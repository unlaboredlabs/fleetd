-- The night a project's refresh was last skipped for a node too old to hold it to its memory tools, whose line went
-- in its chat: one line a night (hub/memory/refresh).
ALTER TABLE memory_refreshes ADD COLUMN skipped_ms INTEGER;
