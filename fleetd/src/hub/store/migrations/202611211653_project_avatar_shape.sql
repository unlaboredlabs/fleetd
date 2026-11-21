-- The body a person picked for a project's bot (`project_settings_set` avatarShape), or the one a new bot got from its
-- id: one of the shapes' names (app/desktop/src/shared/bot.ts BOT_BODIES). NULL is pebble, the default, so every
-- project keeps its look until changed.
ALTER TABLE project_settings ADD COLUMN avatar_shape TEXT;
