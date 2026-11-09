-- The model and effort behind each task profile (W88): the fleet's (empty machine and project) and a project's
-- override, either field unset to fall through. `refused` is what claude said when it refused the model, set by
-- the hub for a setting made before (`set_at`) the session it refused.
CREATE TABLE profile_settings (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, profile TEXT NOT NULL, model TEXT, effort TEXT, refused TEXT,
    set_at TEXT NOT NULL, PRIMARY KEY (machine_id, project_id, profile)
  );
  CREATE INDEX profile_settings_by_model ON profile_settings (model);
