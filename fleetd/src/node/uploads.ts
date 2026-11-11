// The recordings a node still owes the hub: the heartbeat's `busy.uploads`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { UPLOAD_BUSY_SECS } from "../shared/node_link.ts";

/** Where each kind of screen keeps its recordings until the hub has them. */
const recordingRoots = (home: string) => [
  join(home, "browser", "recordings"),
  join(home, "device", "recordings"),
  join(home, "device", "ios", "recordings"),
  join(home, "desktop", "recordings"),
];

/** Recordings that ended within UPLOAD_BUSY_SECS and haven't reached the hub yet (the heartbeat's `busy.uploads`). */
export function uploads(home: string, now = Date.now()): number {
  const within = UPLOAD_BUSY_SECS * 1000;
  let n = 0;
  for (const root of recordingRoots(home)) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, name);
      try {
        if (!(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { endedAt?: string }).endedAt) continue;
      } catch {
        continue;
      }
      const changed = [dir, join(dir, "session.json")].some((p) => {
        try {
          return now - statSync(p).mtimeMs < within;
        } catch {
          return false;
        }
      });
      if (changed) n++;
    }
  }
  return n;
}
