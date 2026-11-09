-- Reviews: the patches whose reviewers kept ending without a verdict, so the lead is told of each once, across
-- restarts.
CREATE TABLE review_stalls (change_id TEXT NOT NULL, patch_id TEXT NOT NULL, PRIMARY KEY (change_id, patch_id));
