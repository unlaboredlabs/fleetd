-- W356: a Navi whose delete was asked for (project_remove, D287 navi.delete-erases), until the hub has erased it. Its
-- node may remove it without its answer reaching the hub; the hub then finishes the erase once its cache no longer
-- has the Navi (hub/navi/erase.rs).
CREATE TABLE navi_erases (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, asked_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, project_id)
);
