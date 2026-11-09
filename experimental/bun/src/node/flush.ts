// `fleetd node flush` (crates/fleetd/src/node/flush.rs, busy.rs's uploads): a clean stop for a cloud machine, run as
// boat's pre-stop hook (`~/.boat/pre-stop`, which boat gives 60 s). It holds every agent tool call that hasn't started
// (./hold.ts; the hold lapses by itself in HOLD_LEASE_SECS if the stop never comes), so the stop lands between steps;
// waits, up to `waitMs`, for the recordings still on their way to the hub (uploads); then checkpoints the node's
// database and syncs the disk, so boat's snapshot holds them whole. Nothing is lost when time runs out: runs resume and
// recordings go at the next wake.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { UPLOAD_BUSY_SECS } from "../shared/node_link.ts";
import { hold } from "./hold.ts";

const POLL_MS = 500;

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

/** Folds the database's write-ahead log into it, waiting a while for the node's own writes. */
function checkpoint(db: string): boolean {
  if (!existsSync(db)) return true;
  try {
    const conn = new Database(db);
    try {
      conn.run("PRAGMA busy_timeout = 5000");
      conn.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      return true;
    } finally {
      conn.close();
    }
  } catch {
    return false;
  }
}

/** Writes every filesystem's buffers out, as sync(2): off the event loop, as a busy disk takes seconds. */
const syncDisk = () => Bun.spawn(["sync"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;

/** What a flush left, in one line. `sync` is the disk's (a test's own). */
export async function flush(home: string, waitMs: number, sync: () => unknown = syncDisk): Promise<string> {
  let held = "agents held between steps";
  try {
    hold(home);
  } catch {
    held = "agents not held";
  }
  const deadline = Date.now() + waitMs;
  let waiting = uploads(home);
  while (waiting > 0 && Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    waiting = uploads(home);
  }
  const checkpointed = checkpoint(join(home, "sessions.sqlite")) ? "database checkpointed" : "database not checkpointed";
  await sync();
  const left = waiting === 0 ? "no recording waits" : waiting === 1 ? "1 recording waits for the next wake" : `${waiting} recordings wait for the next wake`;
  return `flushed: ${held}, ${left}, ${checkpointed}, disk synced`;
}
