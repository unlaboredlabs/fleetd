-- The nightly worktree sweep (W87): what it knows of an ended task's worktree, and its failed tries at removing it.
-- NULL: maybe still on its machine; 'removed'; 'flagged': kept for work only there, and the person told; 'given_up':
-- its tries ran out, and the person told. A task that runs again goes back to NULL and no tries.
ALTER TABLE tasks ADD COLUMN worktree TEXT;
  ALTER TABLE tasks ADD COLUMN worktree_tries INTEGER NOT NULL DEFAULT 0;
