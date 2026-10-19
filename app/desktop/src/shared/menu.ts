// The app menu items that run palette commands. Their menu item ids are the command ids, and the renderer reports
// which are enabled now (app:menuState), so an item greys out where its command does nothing, as in the GPUI app.
import { z } from "zod";

export const MENU_COMMANDS = [
  "settings.open",
  "order.new",
  "go:projects.add",
  "composer.focus",
  "status.toggle",
  "board.open",
  "inbox.toggle",
  "board.toggleGrouping",
  "palette.toggle",
  "shortcuts.show",
  "sidebar.toggle",
  "order.previous",
  "order.next",
  "order.stop",
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

/** The enabled commands; any menu command left out is disabled. */
export const MenuState = z.array(z.enum(MENU_COMMANDS)).max(MENU_COMMANDS.length);
