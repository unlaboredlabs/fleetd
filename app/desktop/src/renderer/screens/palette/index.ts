// The palette's public surface. Screens import from "../palette", never from the files inside.
export { PaletteHost } from "./PaletteHost";
export {
  commandFor,
  registerCommands,
  registerSource,
  runCommand,
  useCommands,
  useSource,
  type Command,
  type Source,
} from "./registry";
export { openPalette, closeOverlay } from "./state";
