// A host's hold on its session's processes (crates/fleetd/src/node/runner/process.rs `sweep`, `reap`,
// `adopt_orphans`, `record_left_in`): the sweeps that find everything a spawn started (its descendants, and on Linux
// every process carrying the spawn's marker), the reaping of what they killed, and the subreaper that keeps a
// session's orphans under the host, recorded beside its dir for the task's end (../host.ts `endLeft`).
import { dlopen, FFIType } from "bun:ffi";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "../../util.ts";
import { dedupe, descendants, parseStat, statOf, table, type Proc } from "../procs.ts";

/** The variable every process of a spawn carries: the spawn's marker (../host.ts `marker`). */
export const SESSION_MARKER = "FLEETD_RUNNER_SESSION";

const linux = process.platform === "linux";
const warn = (message: string) => process.stderr.write(`${nowIso()} WARN ${message}\n`);

type Libc = {
  prctl: (option: number, a: number, b: number, c: number, d: number) => number;
  waitpid: (pid: number, status: null, options: number) => number;
  getpgrp: () => number;
  getsid: (pid: number) => number;
};
let libc: Libc | undefined;
/** libc's process calls, through Bun's FFI; Linux only. */
function lib(): Libc {
  if (libc) return libc;
  const { symbols } = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    getpgrp: { args: [], returns: FFIType.i32 },
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  libc = symbols as unknown as Libc;
  return libc;
}
const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;

/** `pid`'s marker. Undefined when it has none, belongs to another user, or is a zombie (no environ). */
function markerOf(pid: number): string | undefined {
  let env: string;
  try {
    env = readFileSync(`/proc/${pid}/environ`, "latin1");
  } catch {
    return undefined;
  }
  const prefix = `${SESSION_MARKER}=`;
  const found = env.split("\0").find((v) => v.startsWith(prefix));
  return found === undefined ? undefined : Buffer.from(found.slice(prefix.length), "latin1").toString("utf8");
}

/** The live processes in `procs` whose environment carries `marker`. Never this process. Nothing off Linux, where
 * only the walk from the root finds a session's processes. */
export function marked(procs: Proc[], marker: string): Proc[] {
  if (!linux || !marker) return [];
  return procs.filter((p) => p.pid !== process.pid && !p.zombie && markerOf(p.pid) === marker);
}

/** What a sweep of the spawn rooted at `root` and marked `marker` finds right now. */
export function sweep(root: number, marker: string): Proc[] {
  const procs = table();
  return dedupe([...descendants(procs, root), ...marked(procs, marker).filter((p) => p.pid !== root)]);
}

/** What a sweep by `marker` alone finds right now, for a spawn whose root is gone and whose pid may be reused. */
export const sweepMarked = (marker: string): Proc[] => marked(linux ? table() : [], marker);

/** Still the process that was swept (its pid not reused since), zombie or not. */
function same(p: Proc): boolean {
  if (p.start === undefined) return true;
  return statOf(p.pid)?.start === p.start;
}

/** Reaps the swept processes that became this process's children (adopted as subreaper), waiting up to `ms` for the
 * ones still dying. Pids that are not its children are left to their parents. */
export async function reap(procs: Proc[], ms: number): Promise<void> {
  if (!linux) return;
  let dying = procs.filter((p) => same(p) && !tracked.has(p.pid) && lib().waitpid(p.pid, null, WNOHANG) === 0).map((p) => p.pid);
  const until = Date.now() + ms;
  while (dying.length && Date.now() < until) {
    await Bun.sleep(10);
    dying = dying.filter((pid) => lib().waitpid(pid, null, WNOHANG) === 0);
  }
}

/** The live claude processes this host spawned: Bun reaps those itself, so the reaper never touches them. */
const tracked = new Set<number>();
export const track = (pid: number) => void tracked.add(pid);
export const untrack = (pid: number) => void tracked.delete(pid);

/** A process across pid reuse. */
const key = (p: Proc) => `${p.pid} ${p.start ?? ""}`;
/** Live children seen carrying a runner marker: orphans this process adopted. */
const adoptedOrphans = new Set<string>();
let left: string | undefined;
const recorded = new Set<string>();

/** Whether a zombie child never identified alive is an adopted orphan, safe to reap. A host starts claude only, in a
 * session of its own; anything else of that shape that isn't tracked, or in a foreign group, can't be one Bun waits
 * for. */
export const adopted = (p: Proc, ownGroup: number, ownSession: number) => p.pgid !== ownGroup && (p.pgid !== p.pid || p.sid !== ownSession);

let adopting = false;
/** Makes this process child subreaper (Linux), so a session's orphans reparent to it, where a sweep still finds them by
 * ppid, instead of escaping to init. From then on `reapAdopted` runs every second, so an adopted orphan that exits on
 * its own never lingers as a zombie. Idempotent. Only a host calls it: Bun's own children elsewhere could be taken. */
export function adoptOrphans(): void {
  if (!linux || adopting) return;
  adopting = true;
  try {
    if (lib().prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
      warn("could not become child subreaper");
      return;
    }
  } catch (error) {
    warn(`could not become child subreaper: ${(error as Error).message}`);
    return;
  }
  setInterval(reapAdopted, 1000).unref();
}

/** Every live child that isn't its claude goes to `file` by pid and start time as `reapAdopted` finds it: it can only
 * be an orphan of the session's tree (a browser a script started, then exited), which may drop the marker and move to
 * a scope of its own, so neither finds it later; the record does, when the session's task ends. Set once. */
export function recordLeftIn(file: string): void {
  if (linux) left ??= file;
}

/** One pass over this process's children: remember live ones that carry a runner marker other than its own (an orphan
 * of a session's tree), and reap zombies that are known orphans or `adopted`. Never a tracked claude. */
export function reapAdopted(): void {
  if (!linux) return;
  const own = process.pid;
  const ownGroup = lib().getpgrp();
  const ownSession = lib().getsid(0);
  // A host that itself runs inside a session (a lab) passes that marker to every child it spawns.
  const ownMarker = process.env[SESSION_MARKER];
  const children = ownChildren(own);
  // The kernel's children lists can skip one while others exit: an orphan remembered but not seen is looked up.
  for (const k of adoptedOrphans) {
    const [pid, start] = k.split(" ");
    if (children.some((p) => String(p.pid) === pid)) continue;
    const p = statOf(Number(pid));
    if (p && p.ppid === own && String(p.start ?? "") === start) children.push(p);
  }
  for (const p of children) {
    if (tracked.has(p.pid)) adoptedOrphans.delete(key(p));
    else if (!p.zombie) {
      const m = markerOf(p.pid);
      if (m !== undefined && m !== ownMarker) adoptedOrphans.add(key(p));
    } else if (adoptedOrphans.delete(key(p)) || adopted(p, ownGroup, ownSession)) lib().waitpid(p.pid, null, WNOHANG);
  }
  if (left) recordLeft(left, children.filter((p) => !p.zombie && !tracked.has(p.pid)));
  // Forget orphans that are gone some other way (a sweep reaped them).
  for (const k of adoptedOrphans) if (!children.some((p) => key(p) === k)) adoptedOrphans.delete(k);
}

/** Appends to `file` the processes of `live` it doesn't list yet, one `<pid> <start>` line each. */
function recordLeft(file: string, live: Proc[]): void {
  const lines = live
    .filter((p) => p.start !== undefined && !recorded.has(key(p)))
    .map((p) => {
      recorded.add(key(p));
      return `${p.pid} ${p.start}\n`;
    })
    .join("");
  if (!lines) return;
  try {
    appendFileSync(file, lines);
  } catch (error) {
    warn(`orphans not recorded in ${file}: ${(error as Error).message}`);
  }
}

/** This process's own children: the pids each of its threads lists in `/proc/self/task/<tid>/children` (an orphan
 * reparents to whichever thread is alive), else the whole table's. */
function ownChildren(own: number): Proc[] {
  const pids = new Set<number>();
  let readAny = false;
  try {
    for (const task of readdirSync("/proc/self/task")) {
      let list: string;
      try {
        list = readFileSync(join("/proc/self/task", task, "children"), "utf8");
      } catch {
        continue;
      }
      readAny = true;
      for (const p of list.split(/\s+/)) if (/^\d+$/.test(p)) pids.add(Number(p));
    }
  } catch {}
  if (!readAny) return table().filter((p) => p.ppid === own);
  return [...pids].flatMap((pid) => {
    try {
      const p = parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
      return p && p.ppid === own ? [p] : [];
    } catch {
      return [];
    }
  });
}
