-- The agents' Mac's 6-digit setup codes (Add machine › A Mac for agents, D309) are pairing codes too: a row with
-- `machine_id` set is one, traded at POST /pair/mac for an enroll token of that machine, never for a key.
ALTER TABLE pair_codes ADD COLUMN machine_id TEXT;
