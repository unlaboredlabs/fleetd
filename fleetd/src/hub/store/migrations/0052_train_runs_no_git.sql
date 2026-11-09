-- The train runs no git of its own any more, so nothing can block its worktree: its event goes, as no reader decodes
-- it.
DELETE FROM events WHERE type = 'train.blocked';
