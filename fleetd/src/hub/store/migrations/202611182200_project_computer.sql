-- A bot's pick of its agents' computer (hub/project_lead/store.ts computerOf): JSON {"kind","cpu","memGb"}, `kind`
-- 'vm' (its machine's own VM) or a hosted provider, at that exact size. NULL: none, placed and sized by default.
ALTER TABLE project_settings ADD COLUMN computer TEXT;
-- The size a held slot's computer was started at (hub/slots/board.ts Claim.size): JSON {"cpu","memGb"}, its bot's pick
-- where the board placed it; NULL: the default there. A Local VM's counts its memory's worth of its machine's slots.
ALTER TABLE slot_claims ADD COLUMN size TEXT;
