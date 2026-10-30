-- W198: the picture a project's or Navi's chat shows in place of its letters, as the hub keeps it: the crop, at most
-- 512 px square, re-encoded as JPEG without the original's metadata. `avatar` is its id (its sha256's first 16 hex).
CREATE TABLE project_avatars (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, avatar TEXT NOT NULL, jpeg BLOB NOT NULL, set_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, project_id)
);
