-- Cloud machines (hub/cloud): a pool enroll token, minted by the hub for one of its cloud machine slots, may enroll
-- that machine id from a new computer (a recreated VM); a machine enrolled with one is a pool machine. The outbox
-- keeps what a sleeping pool machine missed (a secret to forget) until its next hello: names and ids, never a value.
ALTER TABLE enroll_tokens ADD COLUMN pool INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node_keys ADD COLUMN pool INTEGER NOT NULL DEFAULT 0;
CREATE TABLE cloud_outbox (
  id INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL,
  item TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  UNIQUE (machine_id, item)
);
