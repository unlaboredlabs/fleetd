-- Machine roles: whether a machine runs agents, sessions or both, and its own session cap (NULL: auto); no row
-- means both, auto. And where each session an agent started was placed: on its agent's machine (hosted 0), or
-- on another machine whose node hosts it under `place_id` and reports it in the agent's name (hosted 1). And the
-- area's settings: `remote`, placing sessions on other machines than their agents'.
CREATE TABLE machine_roles (
    machine_id TEXT PRIMARY KEY, agents INTEGER NOT NULL, sessions INTEGER NOT NULL, max_sessions INTEGER
  );
  CREATE TABLE session_places (
    place_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, origin_machine TEXT NOT NULL, origin_thread TEXT NOT NULL,
    project_id TEXT NOT NULL, task_id TEXT, hosted INTEGER NOT NULL, session_id TEXT, started_ms INTEGER NOT NULL,
    ended_ms INTEGER
  );
  CREATE INDEX session_places_by_runner ON session_places (runner_id, ended_ms);
  CREATE INDEX session_places_by_origin ON session_places (origin_machine, origin_thread, ended_ms);
  CREATE INDEX session_places_by_session ON session_places (session_id);
  CREATE TABLE machine_roles_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
