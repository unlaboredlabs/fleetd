-- D67: a finished task whose PR lookup has not settled, so a hub restart runs it again.
ALTER TABLE tasks ADD COLUMN pr_lookup INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX tasks_pr_lookup ON tasks (n) WHERE pr_lookup = 1;
