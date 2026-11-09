// The session host pinned where `fleetd update` can't replace it (crates/fleetd/src/node/self_exe.rs): the binary the
// node's sessions are hosted by and start `fleetd agent-mcp` and the hold hook with (./runner/helper.ts). An update
// writes a new binary beside the installed one and renames it over, so the installed path then names the new file;
// on macOS that's the file a later start opens, which may not speak the running node's socket. At start the node
// hard-links the helper to `<node home>/bin/fleetd-agent-<pid>` (copying it on macOS, or when the home is on another
// filesystem), and its sessions use that for as long as the node runs. The next start removes the pins of nodes that
// are gone, but not one a running process was started from (a re-adopted session's host, a Rust node's pin among
// them): those sessions keep starting their fleetd tools from it.
//
// The Bun build pins itself the same way, as `fleetd-bun-<pid>`: agents' `mac` and the forwarding agent-device run it
// (mac_tool/shim.ts), so an update between its rename and the node's restart can't put a new binary on the old node's
// socket. Run from source, the node has nothing of its own to pin, and they run Bun with its entry.
import { constants, copyFileSync, existsSync, linkSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "./config.ts";

const DIR = "bin";
/** The session host's pins. */
const PREFIX = "fleetd-agent-";
/** The Bun build's own. */
const SELF_PREFIX = "fleetd-bun-";

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

/** The pinned `exe` for this node's sessions, or `exe` itself (logged) when it can't be pinned; undefined stays so. */
export function pin(home: string, exe: string | undefined): string | undefined {
  if (!exe) return exe;
  try {
    return pinFrom(exe, home, process.pid);
  } catch (e) {
    console.warn(
      `${new Date().toISOString()} WARN the session host was not pinned for agents' fleetd tools; a self-update may leave new sessions without them {"error":${JSON.stringify(String(e))}}`,
    );
    return exe;
  }
}

/** This node's own command line for agents' commands: its pinned binary when it is a compiled build, else Bun with
 * its entry (run from source); the running binary itself when it can't be pinned. */
export function pinSelf(home: string, main: string = Bun.main, exe: string = process.execPath): string[] {
  if (!main.startsWith("/$bunfs/")) return [exe, main];
  // Linux names a binary replaced under a running process `<path> (deleted)`; /proc still opens it.
  const running = exe.replace(/ \(deleted\)$/, "");
  const source = existsSync(running) || process.platform !== "linux" ? running : "/proc/self/exe";
  try {
    return [pinFrom(source, home, process.pid, process.platform, SELF_PREFIX)];
  } catch (e) {
    console.warn(`${new Date().toISOString()} WARN the node's binary was not pinned for agents' mac command {"error":${JSON.stringify(String(e))}}`);
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
