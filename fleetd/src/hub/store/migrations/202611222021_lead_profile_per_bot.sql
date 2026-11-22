-- A bot's own lead profile (W825, `project_set` leadProfile): the id of the profile its lead starts on. NULL, or an id
-- no profile has, is the hub's lead profile, so every bot's lead starts as before until a person picks one. Deleting
-- a profile clears the picks of it (profiles.ts `delete`): a later profile can take the freed id.
ALTER TABLE project_settings ADD COLUMN lead_profile INTEGER;
