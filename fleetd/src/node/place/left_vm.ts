// What a local VM left on this machine. Agents ran in VMs of their own from 2026-11-17 until fleetd removed them (D594):
// they run on the machine itself again, as plain processes. A node updated from a build that had them may still find
// a session's box running, recorded in its host dir (`box.json`), and the VM's files under `<node home>/vm`. Nothing
// adopts a box any more: the session's stop (../runner/host.ts) ends it, its transcript comes back to the machine's
// Claude dir first, so the session's next turn resumes as a plain process where it left off, and `sweepVm` clears the
// rest once the node's sessions are settled.
//
// A box nothing records (its host dir gone, or a node that crashed between its boot and its record) is found by the
// marker its launcher's environment carried, which the VMM and helpers inherited: `FLEETD_BOX=<host dir>`, under this
// node's own `hosts` dir. Never by a process's name: another fleet's boxes on this machine carry another home's dir,
// and stay untouched (reapLeaked). Light on purpose: `fleetd session-host stop-all` (machine remove) reads it through
// ../runner/host.ts, which imports only the host's modules.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dedupe, descendants, gone, signal, statOf, table, type Proc } from "../runner/procs.ts";

/** One process of a box. */
type BoxProc = { pid: number; start: number };

/** What a box's record holds that its end needs. */
type BoxRecord = {
  kind: "microvm";
  /** The box's launcher: it led the box's process group, and its children were the VMM and its helpers. */
  leader: BoxProc;
  helpers: BoxProc[];
  /** The shell that held the box's network namespace. */
  net?: BoxProc;
  /** The session's transcript here and in the box: the box's copy is the newer while it ran. */
  transcript?: { here: string; box: string };
};

export const boxFile = (dir: string) => join(dir, "box.json");

function readBox(dir: string): BoxRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(boxFile(dir), "utf8")) as BoxRecord;
    return r.kind === "microvm" && Number.isInteger(r.leader?.pid) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** The process still running at `p`, not a pid reused since. */
function liveProc(p: BoxProc): Proc | undefined {
  if (p.pid <= 1) return undefined;
  const now = statOf(p.pid);
  return now && !now.zombie && now.start === p.start ? now : undefined;
}

const STOP_WAIT_MS = 8_000;

/** Copies `from` over `to` when `from` is there and `to` isn't, or is older. */
function newer(from: string, to: string): void {
  let a;
  try {
    a = statSync(from);
  } catch {
    return;
  }
  try {
    if (statSync(to).mtimeMs >= a.mtimeMs) return;
  } catch {}
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const tmp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

/** SIGKILLs everything the box in `dir` recorded (its launcher's group and tree, the VMM and helpers, each by pid and
 * start time), brings its transcript back here where the box's is newer, and forgets the record. Idempotent; how many
 * processes it ended. */
export async function destroyBox(dir: string): Promise<number> {
  const r = readBox(dir);
  if (!r) return 0;
  const roots = [r.leader, ...r.helpers, ...(r.net ? [r.net] : [])].flatMap((p) => liveProc(p) ?? []);
  const procs = roots.length ? table() : [];
  // The launcher leads the box's group: while it runs, its group is the box's (a pid reused since leads none of it).
  const group = roots.some((p) => p.pid === r.leader.pid) ? procs.filter((p) => p.pgid === r.leader.pid && p.pid !== process.pid) : [];
  const found = dedupe([...roots, ...roots.flatMap((p) => descendants(procs, p.pid)), ...group]);
  signal(found, "SIGKILL");
  await gone(found, STOP_WAIT_MS);
  if (r.transcript) newer(r.transcript.box, r.transcript.here);
  rmSync(boxFile(dir), { force: true });
  return found.length;
}

/** The variable in a box launcher's environment (and so in its VMM's and helpers'): its host dir. */
const BOX_MARKER = "FLEETD_BOX";

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
 * SIGKILLs every process left of a box under `hosts` (a node's `<home>/hosts`): each one whose marker names a dir
 * there, with its group and tree. Run at the node's start once its sessions' stops ended the boxes they recorded.
 * Linux only; how many processes it ended.
 */
export async function reapLeaked(hosts: string): Promise<number> {
  if (process.platform !== "linux") return 0;
  const root = resolve(hosts);
  const procs = table();
  const leaked: Proc[] = [];
  for (const p of procs) {
    if (p.pid <= 1 || p.pid === process.pid || p.zombie) continue;
    const dir = markedDir(p.pid);
    if (dir && dirname(resolve(dir)) === root) leaked.push(p);
  }
  if (!leaked.length) return 0;
  const own = statOf(process.pid)?.pgid;
  // A leaked box's group is its dead or living launcher's, which only the box's processes are in.
  const groups = new Set(leaked.map((p) => p.pgid).filter((g) => g > 1 && g !== own));
  const found = dedupe([...leaked, ...leaked.flatMap((p) => descendants(procs, p.pid)), ...procs.filter((p) => groups.has(p.pgid) && p.pid !== process.pid)]);
  signal(found, "SIGKILL");
  await gone(found, STOP_WAIT_MS);
  return found.length;
}

/** The folder the VMs' files were in. Its `images` and `disks` hold the hosted boxes' images too (./image.ts). */
const vmDir = (home: string) => join(home, "vm");

/**
 * What the VMs left under `<home>/vm`, gone: their tools, root image, homes, caches and claude copy, and their own disks
 * and image files. The hosted boxes' images (a provider's snapshot, recorded as `where: "boat"`) stay. Run at the
 * node's start, once its sessions' stops brought the boxes' transcripts back. How many entries it removed.
 */
export function sweepVm(home: string): number {
  const dir = vmDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  const drop = (path: string) => (rmSync(path, { recursive: true, force: true }), removed++);
  const vmJson = (path: string, field: "where" | "ready") => {
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as { where?: string; ready?: { where?: string } };
      return (field === "where" ? j.where : j.ready?.where) === "vm";
    } catch {
      return true;
    }
  };
  for (const name of names) {
    const at = join(dir, name);
    if (name !== "images" && name !== "disks") {
      drop(at);
      continue;
    }
    let files: string[] = [];
    try {
      files = readdirSync(at);
    } catch {}
    for (const f of files) {
      const path = join(at, f);
      // An image's record (images/<bot>.json) or a session's choice (disks/<session>.image.json) of a VM's image, a
      // VM's image or disk file, or a VM image build's dir.
      if (name === "images" ? !f.endsWith(".json") || vmJson(path, "ready") : !f.endsWith(".image.json") || vmJson(path, "where")) drop(path);
    }
  }
  return removed;
}
