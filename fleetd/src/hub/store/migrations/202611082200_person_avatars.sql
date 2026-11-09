-- W523: a person's own picture, shown in place of their initials, kept as a project's is (project_avatars): the crop,
-- at most 512 px square, re-encoded as JPEG without the original's metadata. `avatar` is its id (its sha256's first 16
-- hex).
CREATE TABLE person_avatars (
  person_id TEXT PRIMARY KEY, avatar TEXT NOT NULL, jpeg BLOB NOT NULL, set_ms INTEGER NOT NULL
);
