-- The color a person picked for a project's bot (`project_settings_set` avatarColor): one of the palette's names
-- (app/desktop/src/shared/bot.ts BOT_PAINT). NULL is slate, the default, so every project keeps its look until changed.
ALTER TABLE project_settings ADD COLUMN avatar_color TEXT;
