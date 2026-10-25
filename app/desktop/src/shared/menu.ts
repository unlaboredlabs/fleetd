// The app menu items that run palette commands. Their menu item ids are the command ids, and the renderer reports
// which are enabled now (app:menuState), so an item greys out where its command does nothing, as in the GPUI app.
export const MENU_COMMANDS = [
  "settings.open",
  "app.checkForUpdates",
  "go:projects.add",
  "composer.focus",
  "status.toggle",
  "factory.open",
  "go:time",
  "palette.toggle",
  "shortcuts.show",
  "sidebar.toggle",
  "panel.toggle",
  "project.previous",
  "project.next",
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];
