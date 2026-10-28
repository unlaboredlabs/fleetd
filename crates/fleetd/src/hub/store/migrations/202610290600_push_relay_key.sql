-- The push relay's key (W158): sent as a bearer token to a relay that takes one, kept sealed to the hub's box key
-- (standard base64), never in the clear.
ALTER TABLE push_relay ADD COLUMN key_sealed TEXT;
