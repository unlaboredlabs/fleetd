-- People (W99): who is behind each human key, with a hub role ('owner', 'admin' or 'member'). Every human key
-- belongs to a person; the hub's first start after this makes the owner and binds an older hub's keys to them
-- (`People::ensure_owner`). An invite is a pairing code bound to a person (`invite_id` set), valid for 7 days;
-- `fleetd pair`'s codes have no person and pair for the owner.
CREATE TABLE people (
    person_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_ms INTEGER NOT NULL, removed_ms INTEGER
  );
  ALTER TABLE agent_keys ADD COLUMN person_id TEXT;
  CREATE INDEX agent_keys_by_person ON agent_keys (person_id);
  ALTER TABLE pair_codes ADD COLUMN person_id TEXT;
  ALTER TABLE pair_codes ADD COLUMN invite_id TEXT;
  ALTER TABLE pair_codes ADD COLUMN created_ms INTEGER;
  ALTER TABLE pair_codes ADD COLUMN created_by TEXT;
  ALTER TABLE pair_codes ADD COLUMN revoked_ms INTEGER;
  CREATE UNIQUE INDEX pair_codes_by_invite ON pair_codes (invite_id);
