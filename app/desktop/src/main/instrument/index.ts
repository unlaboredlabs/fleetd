// Scripted-run hooks, each inert unless its variable is set: FLEETD_PERF (perf/run.ts), FLEETD_RECORD (the app
// records its own window) and FLEETD_DEMO_TYPE (it types an order into the composer).
import type { BrowserWindow } from "electron";
import { demoType } from "./demoType";
import { reportLaunch } from "./perf";
import { startRecording, type Recording } from "./record";
import { parseRecord } from "./recordConfig";

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

let instrumented = false;

/** Call right after a window is created, before it is shown; only the first window is recorded and typed into. */
export const instrument = (win: BrowserWindow): void => {
  if (instrumented) return;
  instrumented = true;
  if (env("FLEETD_PERF") !== undefined) reportLaunch(win);
  const record = env("FLEETD_RECORD");
  const order = env("FLEETD_DEMO_TYPE");
  if (record === undefined && order === undefined) return;
  win.once("ready-to-show", () => {
    void (async () => {
      let recording: Recording | undefined;
      if (record !== undefined) {
        const parsed = parseRecord(record);
        if (parsed.ok) recording = await startRecording(win, parsed.value);
        else console.error(`FLEETD_RECORD error=${parsed.error}`);
      }
      if (order !== undefined) {
        await demoType(win, order, () => recording?.clipStart()).catch((error: unknown) => console.error(`FLEETD_DEMO error=${String(error)}`));
      }
    })();
  });
};
