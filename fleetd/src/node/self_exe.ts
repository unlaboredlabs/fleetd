// The node's binary pinned where `fleetd update` can't replace it (crates/fleetd/src/node/self_exe.rs): the binary
// its sessions' hosts run from, and their `fleetd agent-mcp`, hold hook, `mac` and forwarding agent-device. An update
// writes a new binary beside the installed one and renames it over, so the installed path then names the new file; on
// macOS that's the file a later start opens, which may not speak the running node's socket. At start the node
// hard-links itself to `<node home>/bin/fleetd-bun-<pid>` (copying it on macOS, or when the home is on another
// filesystem), and its sessions use that for as long as the node runs. The next start removes the pins of nodes that
// are gone, but not one a running process was started from (a re-adopted session's host among them): those sessions
// keep starting their fleetd tools from it. Run from source, the node has nothing of its own to pin, and they run Bun
// with its entry.
//
// Nodes before the TypeScript session host pinned the Rust build that hosted their sessions as `fleetd-agent-<pid>`;
// those pins go the same way once nothing runs from them.
import { constants, copyFileSync, existsSync, linkSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "./config.ts";

const DIR = "bin";
/** The Rust session host's pins, from nodes before the TypeScript one. */
const RUST_PREFIX = "fleetd-agent-";
/** The node's own. */
const PREFIX = "fleetd-bun-";

/** Links (on macOS, or across filesystems, copies) `exe` to `<home>/bin/<prefix><pid>`, and removes the pins of
 * processes that are gone. */
export function pinFrom(exe: string, home: string, pid: number, platform: NodeJS.Platform = process.platform, prefix = PREFIX): string {
  const dir = join(home, DIR);
  mkdirPrivate(dir);
  sweep(dir, pid, prefix);
  // The file itself, not a symlink to it (an installed `fleetd` is often one), which the update would retarget.
  let source = exe;
  try {
    source = realpathSync(exe);
  } catch {}
  const target = join(dir, `${prefix}${pid}`);
  const tmp = join(dir, `.${prefix}${pid}.tmp`);
  rmSync(tmp, { force: true });
  let linked = false;
  if (platform !== "darwin") {
    try {
      linkSync(source, tmp);
      linked = true;
    } catch {}
  }
  // A clone where the filesystem makes one (APFS), as cheap as a link; else a copy.
  if (!linked) copyFileSync(source, tmp, constants.COPYFILE_FICLONE);
  renameSync(tmp, target);
  return target;
}

/** This node's own command line for its sessions' hosts and agents' commands: its pinned binary when it is a compiled
 * build, else Bun with its entry (run from source); the running binary itself when it can't be pinned. */
export function pinSelf(home: string, main: string = Bun.main, exe: string = process.execPath): string[] {
  if (!main.startsWith("/$bunfs/")) return [exe, main];
  // Linux names a binary replaced under a running process `<path> (deleted)`; /proc still opens it.
  const running = exe.replace(/ \(deleted\)$/, "");
  const source = existsSync(running) || process.platform !== "linux" ? running : "/proc/self/exe";
  try {
    const pinned = pinFrom(source, home, process.pid, process.platform);
    sweep(join(home, DIR), process.pid, RUST_PREFIX);
    return [pinned];
  } catch (e) {
    console.warn(`${new Date().toISOString()} WARN the node's binary was not pinned for its sessions; a self-update may leave new sessions without fleetd {"error":${JSON.stringify(String(e))}}`);
    return [running];
  }
}

/** Removes the pins of processes that no longer run, unless a running process was started from one; never `pid`'s. */
function sweep(dir: string, pid: number, prefix: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const running = runningExes();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const other = Number(name.slice(prefix.length));
    if (!Number.isInteger(other) || other <= 0) continue;
    const path = join(dir, name);
    if (other === pid || alive(other) || running.has(path)) continue;
    rmSync(path, { force: true });
  }
}

/** The binaries this machine's processes run: `/proc/<pid>/exe` on Linux, `ps`'s command paths on macOS. */
export function runningExes(): Set<string> {
  const out = new Set<string>();
  if (process.platform === "linux") {
    let pids: string[] = [];
    try {
      pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    } catch {}
    for (const p of pids) {
      try {
        out.add(readlinkSync(`/proc/${p}/exe`).replace(/ \(deleted\)$/, ""));
      } catch {}
    }
  } else if (process.platform === "darwin") {
    const ps = Bun.spawnSync(["ps", "-axo", "comm="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    if (ps.success) for (const line of ps.stdout.toString().split("\n")) if (line.trim()) out.add(line.trim());
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Someone else's process: it runs.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
