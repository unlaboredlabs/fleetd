-- W363: the live board lists tasks by state every second per app window; without this index each list walked the
-- whole tasks table.
CREATE INDEX tasks_by_state ON tasks (state, n);
