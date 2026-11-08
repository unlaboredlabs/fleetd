-- One project's events, newest first (EventLog::project_page, a project's History): without it a project with few
-- events read the whole log, under the hub's one connection.
CREATE INDEX events_by_project ON events (machine_id, json_extract(data, '$.projectId'), seq);
