-- Share links (hub/share_links): a port on one machine, opened at `https://<name>.<preview address>` by the
-- workspace's signed-in members only. `name` is random (12 of a-z0-9); `secret` signs that link's preview cookies;
-- who made it is kept by name as then (`actor_kind` person or agent, the person behind it, the agent's session when an
-- agent made it). A link ends at `expires_ms`, or at `revoked_ms` when someone stops it; ended rows go after a week.
CREATE TABLE share_links (
    name TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    port INTEGER NOT NULL,
    label TEXT,
    secret TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    person_id TEXT,
    project_id TEXT,
    thread_id TEXT,
    created_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL,
    revoked_ms INTEGER
  );
CREATE INDEX share_links_by_machine ON share_links (machine_id, port);
-- The workspace's switch (`enabled`, on unless '0') and its preview address (`preview_url`, an origin).
CREATE TABLE share_link_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
