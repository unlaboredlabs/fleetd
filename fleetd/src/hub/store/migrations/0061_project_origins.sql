-- Each project's checkout origin, as its node reported it, so the host sweep reads every project's repo and not
-- only the train's; and where a read of a repo's merged PRs that its page cap cut short goes on from.
CREATE TABLE metric_project_repos (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, repo TEXT NOT NULL, checked_ms INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id)
  );
  CREATE INDEX metric_project_repos_by_repo ON metric_project_repos (repo);
  ALTER TABLE metric_repos ADD COLUMN merged_resume TEXT;
  ALTER TABLE metric_repos ADD COLUMN merged_resume_floor INTEGER;
