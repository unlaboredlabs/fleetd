// What agents do on the agents' Mac right now, for the person at it:
// the simulators lent to agents and the jobs they run (`mac run`, builds most of all). Only this node knows either, as
// the hub passes the steps sealed. The node rewrites `<home>/mac-activity.json` whenever it changes, and the app's menu
// bar on the Mac reads it (app/desktop/src/main/macSetup.ts), as setup reads mac-health.json. It names agents by their
// folder (the task's id, else the session's) and projects by id: the app, signed in to the hub, puts names on them.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The most of a job's command line the file carries: the menu bar shows its start. */
export const COMMAND_MAX = 200;

export type SimActivity = { agent: string; projectId: string; device: string; sinceMs: number };
export type JobActivity = { agent: string; projectId: string; job: number; command: string; startedMs: number };
/** The simulators agents hold and the jobs running, each oldest first. */
export type Activity = { simulators: SimActivity[]; jobs: JobActivity[] };

export const activityFile = (home: string) => join(home, "mac-activity.json");

/** The first COMMAND_MAX characters of `command`, with an ellipsis when it was longer. */
export function clipCommand(command: string): string {
  const chars = [...command];
  return chars.length > COMMAND_MAX ? `${chars.slice(0, COMMAND_MAX).join("")}…` : command;
}

/** Writes `activity` whole (a reader polls it), unless it is `last`, what was written before; returns what is on disk. */
export function writeActivity(home: string, activity: Activity, last: Activity | undefined): Activity | undefined {
  const json = JSON.stringify(activity);
  if (last && JSON.stringify(last) === json) return last;
  const tmp = join(home, "mac-activity.json.tmp");
  try {
    writeFileSync(tmp, json);
    renameSync(tmp, activityFile(home));
    return activity;
  } catch {
    return last;
  }
}
