-- M8 devices: one-time pairing tokens from `fleetd hub device add`, and each human key's Web Push subscriptions.
CREATE TABLE pair_tokens (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires_ms INTEGER NOT NULL, used_ms INTEGER);
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device_name TEXT NOT NULL, key_id TEXT NOT NULL,
    created_ms INTEGER NOT NULL
  );
