-- A bot's pick of its agents' computer (hub/project_lead/store.ts computerOf): JSON {"kind","cpu","memGb"}, `kind`
-- 'vm' (its machine's own VM) or a hosted provider, at that exact size. NULL: none, placed and sized by default.
ALTER TABLE project_settings ADD COLUMN computer TEXT;
