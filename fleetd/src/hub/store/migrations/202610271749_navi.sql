-- Navis (W97): the projects that are assistants (`kind: assistant`), with the key that created each (its id and name,
-- for per-person Navis later) and when it was archived (NULL: in use); and the sites each may fetch and open without
-- asking, which a person allowed at its first visit.
CREATE TABLE assistants (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, created_ms INTEGER NOT NULL, created_by_key TEXT NOT NULL,
    created_by_name TEXT NOT NULL, archived_ms INTEGER, PRIMARY KEY (machine_id, project_id)
  );
CREATE TABLE navi_sites (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, site TEXT NOT NULL, allowed_ms INTEGER NOT NULL,
    allowed_by TEXT NOT NULL, PRIMARY KEY (machine_id, project_id, site)
  );
