// The palette's public surface. Screens import from "../palette", never from the files inside.
export { PaletteHost } from "./PaletteHost";
export {
  GROUPS,
  GROUP_LABELS,
  commandFor,
  registerCommands,
  registerSource,
  registerTextAction,
  runCommand,
  useCommands,
  useSource,
  type Command,
  type Group,
  type Source,
  type TextAction,
} from "./registry";
export { openPalette, openShortcuts, closeOverlay } from "./state";
