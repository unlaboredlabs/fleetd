-- Two task profiles, both claude-opus-5-5: high and medium. The lead always runs high, so its saved model and
-- effort go; a project keeps whether its tasks may run medium. A stored task on opus-5-5 at medium is medium and
-- every other one high. A task's or a lead's spans carry its profile, so time and usage split by it.
DROP TABLE lead_settings;
  CREATE TABLE project_settings (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, medium_allowed INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id)
  );
  UPDATE tasks SET data = json_set(json_remove(data, '$.model', '$.effort'), '$.profile',
    CASE WHEN json_extract(data, '$.model') = 'claude-opus-5-5' AND json_extract(data, '$.effort') = 'medium'
      THEN 'medium' ELSE 'high' END)
    WHERE json_valid(data);
  ALTER TABLE time_spans ADD COLUMN profile TEXT;
  UPDATE time_spans SET profile = 'high' WHERE role IS NOT NULL OR task_id IS NOT NULL;
  UPDATE time_spans SET profile = 'medium'
    WHERE task_id IN (SELECT 'T' || n FROM tasks WHERE json_extract(data, '$.profile') = 'medium');
