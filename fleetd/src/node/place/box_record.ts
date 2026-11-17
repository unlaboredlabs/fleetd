// What a session's box left on this machine, by pid and start time: `<host dir>/box.json`, written by the microvm
// place (./microvm.ts) once its VMM runs. Light on purpose: `fleetd session-host stop-all` (machine remove) and the
// process place's own stop read it through ../runner/host.ts, and they import only the host's modules.
//
// A box nothing records (its host dir gone, or a node that crashed between its boot and its record) is found by the
// marker the node puts in its launcher's environment, which the VMM and helpers inherit: `FLEETD_BOX=<host dir>`,
// under this node's own `hosts` dir. Never by a process's name: another fleet's boxes on this machine carry another
// home's dir, and stay untouched (reapLeaked).
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dedupe, descendants, gone, signal, statOf, table, type Proc } from "../runner/procs.ts";
import type { Relay } from "../sandbox/box.ts";
import type { View } from "./view.ts";

/** One process of a box. */
export type BoxProc = { pid: number; start: number };

export type BoxRecord = {
  kind: "microvm";
  /** The box's launcher: it leads the box's process group, its children are the VMM and its helpers, and it ends with
   * the VMM. Its pid is the session's recorded pid. */
  leader: BoxProc;
  /** The VMM, virtiofsd and passt (pasta, and the shell holding the box's network namespace). */
  helpers: BoxProc[];
  /** The shell holding the box's network namespace, where its routes keep this machine's addresses out (./net.ts);
   * absent for a box from before the namespace. */
  net?: BoxProc;
  /** This machine's addresses the box's routes keep out, as last set. */
  blocked?: string[];
  /** This machine's TCP ports the box reaches at the same numbers (the browser proxy's, adb's). */
  tcp: number[];
  /** Where the box reaches what this machine reaches (its Claude endpoint), through the node. */
  relays?: Relay[];
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

/** The variable in a box launcher's environment (and so in its VMM's and helpers'): its host dir. */
export const BOX_MARKER = "FLEETD_BOX";

/** The host dir `pid`'s marker names, if it has one. */
function markedDir(pid: number): string | undefined {
  try {
    const want = `${BOX_MARKER}=`;
    return readFileSync(`/proc/${pid}/environ`, "latin1")
      .split("\0")
      .find((v) => v.startsWith(want))
      ?.slice(want.length);
  } catch {
    return undefined;
  }
}

/**
 * SIGKILLs the boxes under `hosts` (a node's `<home>/hosts`) that nothing records: every process whose marker names a
 * dir there, unless that dir's box.json records a box still running and the process is of it (the launcher's group or
 * tree, or a recorded helper), with each one's group and tree. Run at the node's start, once the boxes it adopts are
 * adopted and the dirs no session runs in are swept. Linux only; how many processes it ended.
 */
export async function reapLeaked(hosts: string): Promise<number> {
  if (process.platform !== "linux") return 0;
  const root = resolve(hosts);
  const procs = table();
  const marked: { p: Proc; dir: string }[] = [];
  for (const p of procs) {
    if (p.pid <= 1 || p.pid === process.pid || p.zombie) continue;
    const dir = markedDir(p.pid);
    if (dir && dirname(resolve(dir)) === root) marked.push({ p, dir: resolve(dir) });
  }
  if (!marked.length) return 0;
  const owned = new Set<number>();
  for (const dir of new Set(marked.map((m) => m.dir))) {
    const r = readBox(dir);
    if (!r || !boxAlive(r)) continue;
    owned.add(r.leader.pid);
    for (const p of descendants(procs, r.leader.pid)) owned.add(p.pid);
    for (const p of procs) if (p.pgid === r.leader.pid) owned.add(p.pid);
    for (const h of [...r.helpers, ...(r.net ? [r.net] : [])]) if (liveProc(h)) owned.add(h.pid);
  }
  const leaked = marked.map((m) => m.p).filter((p) => !owned.has(p.pid));
  if (!leaked.length) return 0;
  const own = statOf(process.pid)?.pgid;
  // A leaked box's group is its dead or living launcher's, which only the box's processes are in.
  const groups = new Set(leaked.map((p) => p.pgid).filter((g) => g > 1 && g !== own));
  const found = dedupe([
    ...leaked,
    ...leaked.flatMap((p) => descendants(procs, p.pid)),
    ...procs.filter((p) => groups.has(p.pgid) && p.pid !== process.pid),
  ]).filter((p) => !owned.has(p.pid));
  signal(found, "SIGKILL");
  await gone(found, STOP_WAIT_MS);
  return found.length;
}
