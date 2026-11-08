-- W520: wait_ci's `merged` on a PR: the wait ends only when the PR merges (or it can't), not when its checks finish.
-- NULL for a CI wait; for a merge wait, the failure on the train its task was last woken for ('' none), so the same
-- failure doesn't wake it twice.
ALTER TABLE ci_waits ADD COLUMN merged TEXT;
