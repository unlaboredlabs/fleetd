-- The role a pairing code grants, fixed by `fleetd pair --role` when it is minted. Codes minted before this
-- keep the operate they were made with.
ALTER TABLE pair_codes ADD COLUMN role TEXT NOT NULL DEFAULT 'operate';
