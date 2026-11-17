// What a session's box left on this machine, by pid and start time: `<host dir>/box.json`, written by the microvm
// place (./microvm.ts) once its VMM runs. Light on purpose: `fleetd session-host stop-all` (machine remove) and the
// process place's own stop read it through ../runner/host.ts, and they import only the host's modules.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dedupe, descendants, gone, signal, statOf, table, type Proc } from "../runner/procs.ts";
import type { View } from "./view.ts";

/** One process of a box. */
export type BoxProc = { pid: number; start: number };

export type BoxRecord = {
  kind: "microvm";
  /** The box's launcher: it leads the box's process group, its children are the VMM and its helpers, and it ends with
   * the VMM. Its pid is the session's recorded pid. */
  leader: BoxProc;
  /** The VMM, virtiofsd and passt. */
  helpers: BoxProc[];
  /** This machine's TCP ports the box reaches at the same numbers (the browser proxy's, adb's). */
  tcp: number[];
  /** The vsock port the guest helper listens on, behind the VMM's hybrid vsock socket (`vsock.sock`). */
  port: number;
  /** What the box shows of this machine, as it booted: a next node that adopts it starts from this, never from less. */
  view?: View;
};

export const boxFile = (dir: string) => join(dir, "box.json");

export function readBox(dir: string): BoxRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(boxFile(dir), "utf8")) as BoxRecord;
    return r.kind === "microvm" && Number.isInteger(r.leader?.pid) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** The process still running at `p`, not a pid reused since. */
export function liveProc(p: BoxProc): Proc | undefined {
  if (p.pid <= 1) return undefined;
  const now = statOf(p.pid);
  return now && !now.zombie && now.start === p.start ? now : undefined;
}

/** Whether the box still runs. */
export const boxAlive = (r: BoxRecord) => liveProc(r.leader) !== undefined;

const STOP_WAIT_MS = 8_000;

/** SIGKILLs everything the box in `dir` recorded: its launcher's group and tree, and the VMM and helpers, each by pid and start
 * time, and forgets the record. Idempotent; how many processes it ended. */
export async function destroyBox(dir: string): Promise<number> {
  const r = readBox(dir);
  if (!r) return 0;
  const roots = [r.leader, ...r.helpers].flatMap((p) => liveProc(p) ?? []);
  const procs = roots.length ? table() : [];
  // The launcher leads the box's group: while it runs, its group is the box's (a pid reused since leads none of it).
  const group = roots.some((p) => p.pid === r.leader.pid) ? procs.filter((p) => p.pgid === r.leader.pid && p.pid !== process.pid) : [];
  const found = dedupe([...roots, ...roots.flatMap((p) => descendants(procs, p.pid)), ...group]);
  signal(found, "SIGKILL");
  await gone(found, STOP_WAIT_MS);
  rmSync(boxFile(dir), { force: true });
  return found.length;
}
