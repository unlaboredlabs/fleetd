// The app's own update and the hub machine's: what follows them in this window, and the commands that reach them; and
// the quiet indicator, self-contained for whatever names the hub: its state (useQuiet), its word, what its note's
// button does (useUpdateAct), and the main area's line for a restart that runs long.
export { UpdatesHost } from "./UpdatesHost";
export { useQuiet, useUpdateAct } from "./hooks";
export { UpdateWord } from "./UpdateWord";
export { RestartLine } from "./RestartLine";
export type { Act } from "./model";
export type { Note, Quiet } from "./quiet";
