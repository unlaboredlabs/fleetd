-- "Keep finished worktrees" is gone: a reader's worktree goes when its task finishes, a writer's once its PR merges.
ALTER TABLE project_settings DROP COLUMN keep_worktrees;
