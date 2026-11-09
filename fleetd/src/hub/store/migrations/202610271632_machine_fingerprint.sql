-- A machine's fingerprint (a hash of its OS's machine id), from its node's hello: an enroll under that machine id
-- from another computer is refused (hub/link/server.rs). Removing the machine forgets it with its key.
ALTER TABLE node_keys ADD COLUMN fingerprint TEXT;
