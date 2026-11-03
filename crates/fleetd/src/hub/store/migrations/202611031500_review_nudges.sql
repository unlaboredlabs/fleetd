-- W385: a reviewer that ended without a verdict is asked once, in its own thread, to finish and report before a new
-- reviewer starts; `nudged` records that it was.
ALTER TABLE review_tasks ADD COLUMN nudged INTEGER NOT NULL DEFAULT 0;
