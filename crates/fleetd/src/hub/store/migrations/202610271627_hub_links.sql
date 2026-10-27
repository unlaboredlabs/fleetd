-- Hub links (W104, D194). `hub_links_issued`: links minted here, each acting as the device (`key_id`) that minted it,
-- limited to `projects` (JSON `ProjectRef`s; NULL: all), with only the key's SHA-256 kept. `hub_links`: links this
-- hub keeps for a Navi, the key sealed to the hub's own box key, with the other hub's feed cursor and how its last
-- call went. On `navi_asks`, `via_link` marks an ask that came in through a link minted here (its from columns
-- empty), and `to_hub` and `remote` one this hub's Navi sent through a kept link, with its handle there.
CREATE TABLE hub_links_issued (
  link_id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, label TEXT NOT NULL, projects TEXT,
  key_id TEXT NOT NULL, device TEXT NOT NULL, person TEXT, created_ms INTEGER NOT NULL, last_used_ms INTEGER,
  revoked_ms INTEGER
);
CREATE TABLE hub_links (
  link_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, label TEXT NOT NULL COLLATE NOCASE,
  url TEXT NOT NULL, sealed BLOB NOT NULL, cursor INTEGER NOT NULL, state TEXT NOT NULL, error TEXT,
  checked_ms INTEGER, created_ms INTEGER NOT NULL, UNIQUE (machine_id, project_id, label)
);
ALTER TABLE navi_asks ADD COLUMN via_link TEXT;
ALTER TABLE navi_asks ADD COLUMN to_hub TEXT;
ALTER TABLE navi_asks ADD COLUMN remote TEXT;
CREATE INDEX navi_asks_by_remote ON navi_asks (to_hub, remote);
