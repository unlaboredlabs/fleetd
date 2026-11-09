-- A hosted session's relay: the SHA-256 of the token its agent's node connects with (`/relay/<token>`).
ALTER TABLE session_places ADD COLUMN relay_hash TEXT;
  CREATE INDEX session_places_by_relay ON session_places (relay_hash);
