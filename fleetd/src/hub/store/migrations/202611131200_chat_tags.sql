-- A project's chat tags trial (`project_settings_set` chatTags): the hub tags each chat message with its order. NULL is
-- off, the default, so every project's chat stays as it was until a person turns it on.
ALTER TABLE project_settings ADD COLUMN chat_tags INTEGER;
