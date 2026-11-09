-- Phone notifications (D218): each person's phones, with the push token and the X25519 key the hub seals to, and the
-- hub's push relay. A token is one phone's, so it is unique; the key that registered it is kept so a signed-out
-- device stops getting them.
CREATE TABLE push_devices (
    device_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, key_id TEXT NOT NULL, platform TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, name TEXT NOT NULL, created_ms INTEGER NOT NULL,
    last_sent_ms INTEGER
  );
  CREATE INDEX push_devices_by_person ON push_devices (person_id);
  CREATE TABLE push_relay (id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL);
