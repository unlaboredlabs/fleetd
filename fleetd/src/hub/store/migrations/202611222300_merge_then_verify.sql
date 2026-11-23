-- How the train merges a bot's PRs (`project_settings_set` mergeMode): NULL, "Test, then merge" (batches, as before),
-- or 'verify_after', "Merge, then verify": each PR merges on its own green CI, side by side, and a red base afterwards
-- is bisected and its culprit reverted. Every bot keeps its batches until a person picks the other.
ALTER TABLE project_settings ADD COLUMN merge_mode TEXT;
-- The revert PR the train opened for each culprit commit, so one culprit is reverted once, and its revert lands first.
CREATE TABLE train_reverts (
    repo TEXT NOT NULL, culprit_sha TEXT NOT NULL, check_name TEXT NOT NULL, red_sha TEXT NOT NULL,
    revert_pr INTEGER NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (repo, culprit_sha)
  );
