-- One-time pairing codes from `fleetd pair`, redeemed at POST /pair for a human key. `name` is `--name`, if given.
CREATE TABLE pair_codes (hash TEXT PRIMARY KEY, name TEXT, expires_ms INTEGER NOT NULL, used_ms INTEGER);
