-- Prompts: every text a prompt ever had here (shipped defaults, overrides, instructions) by `<id>@<sha>`, and
-- what each session was told at its start: the exact first message and the ref of every prompt it may receive.
CREATE TABLE prompt_versions (ref TEXT PRIMARY KEY, text TEXT NOT NULL);
  CREATE TABLE session_prompts (
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT, started_at TEXT NOT NULL, refs TEXT NOT NULL,
    text_sha TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (machine_id, thread_id)
  );
