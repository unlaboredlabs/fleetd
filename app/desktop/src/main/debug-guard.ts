// The first module main evaluates (index.ts imports it before anything else). Electron starts Chromium's DevTools
// server only after main's top-level code has run, so exiting here means the port or pipe is never opened. Node's
// --inspect listens before any app code, so packaged builds also turn it off with the electronFuses in
// electron-builder.yml; this refusal covers the rest and says why.
//
// Keyed on the build, never on runtime state: anyone who can add a switch can also set a variable or rename the
// binary (app.isPackaged is just the executable's name).
import { app } from "electron";
import { RELEASE_BUILD } from "./build";
import { DEBUG_REFUSED_EXIT, debugSwitches } from "./debug-switches";

if (RELEASE_BUILD) {
  const found = debugSwitches(process.argv, process.env, (name) => app.commandLine.hasSwitch(name));
  if (found.length > 0) {
    console.error(
      `fleetd: refusing to start with ${found.map((s) => `--${s}`).join(", ")}. A debugging switch would let any local program use your hub key.`,
    );
    process.exit(DEBUG_REFUSED_EXIT);
  }
}
