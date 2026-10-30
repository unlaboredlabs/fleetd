-- W221: a task's wait_ci, kept until the GitHub Actions run or the PR's head checks it names finish, then the task is
-- woken with the outcome. One row per task and URL.
CREATE TABLE ci_waits (
  task_id TEXT NOT NULL,
  url TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (task_id, url)
);
