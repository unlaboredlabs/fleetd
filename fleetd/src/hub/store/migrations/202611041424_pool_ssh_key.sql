-- Cloud machines reach a private hub through its own tunnel (W407, D307): the hub SSHes into each awake boat machine
-- and holds a reverse forward that the machine's node dials the hub through. ssh_key is the hub's own ed25519 key for
-- that, its 32-byte seed sealed to the hub's box key; made by the hub the first time it needs it, never pasted or
-- shown (only its public half is). Null: not made yet.
ALTER TABLE pool_settings ADD COLUMN ssh_key BLOB;
