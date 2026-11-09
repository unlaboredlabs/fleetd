-- Area leases went: writers share a repo. Their events go too, as no reader decodes them.
DROP TABLE IF EXISTS leases;
  DELETE FROM events WHERE type IN ('lease.stale', 'task.out_of_area');
