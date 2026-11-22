-- A landed change's time in the train and its CI runs (hub/metrics/pipeline.ts), folded once from the train's state
-- spans, the check runs it read and its PR's review verdicts, so it outlives their 30 days: its time in each stage,
-- the times it went back to its writer by why, its review rounds and their blocking findings, and its CI runs as JSON
-- (each head's first job start, wall time, wait for a runner, the changes that rode it, and its jobs). `known` is 0
-- when nothing of it was left to fold.
CREATE TABLE metric_pipeline (
  change_id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr_number INTEGER, merged_ms INTEGER NOT NULL, known INTEGER NOT NULL,
  review_ms INTEGER NOT NULL, back_ms INTEGER NOT NULL, queue_ms INTEGER NOT NULL, ci_ms INTEGER NOT NULL,
  merge_ms INTEGER NOT NULL, conflicts INTEGER NOT NULL, red_ci INTEGER NOT NULL, reviews INTEGER NOT NULL,
  blocking INTEGER NOT NULL, runs TEXT NOT NULL
);
CREATE INDEX metric_pipeline_by_day ON metric_pipeline (merged_ms);
