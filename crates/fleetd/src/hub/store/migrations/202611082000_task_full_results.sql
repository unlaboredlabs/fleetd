-- A task's whole final result, when the result its row keeps (`data`'s result.tail, at most 2000 units) cuts it: the
-- lead reads it with `agents` and a taskId (hub/tasks/tools.rs). At most 32 KB; NULL when the tail holds it all.
ALTER TABLE tasks ADD COLUMN full_result TEXT;
