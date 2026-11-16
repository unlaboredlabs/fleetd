-- The team's own Revyl account (hub/revyl): one row at most. `sealed` is its API key sealed under the vault's root key
-- as a vault item is (never shown, logged or given to an agent); `check_json` its last check; `route_ios` and
-- `route_android` each phone kind's route (ours_first, ours_only, revyl_only), NULL for the default.
CREATE TABLE revyl_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sealed BLOB,
  check_json TEXT,
  route_ios TEXT,
  route_android TEXT
);
