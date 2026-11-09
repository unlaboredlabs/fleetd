// The session host pinned where `fleetd update` can't replace it (crates/fleetd/src/node/self_exe.rs): the binary the
// node's sessions are hosted by and start `fleetd agent-mcp` and the hold hook with (./runner/helper.ts). An update
// writes a new binary beside the installed one and renames it over, so the installed path then names the new file;
// on macOS that's the file a later start opens, which may not speak the running node's socket. At start the node
// hard-links the helper to `<node home>/bin/fleetd-agent-<pid>` (copying it on macOS, or when the home is on another
// filesystem), and its sessions use that for as long as the node runs. The next start removes the pins of nodes that
// are gone, but not one a running process was started from (a re-adopted session's host, a Rust node's pin among
// them): those sessions keep starting their fleetd tools from it.
import { copyFileSync, linkSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "./config.ts";

const DIR = "bin";
const PREFIX = "fleetd-agent-";

/** Links (on macOS, or across filesystems, copies) `exe` to `<home>/bin/fleetd-agent-<pid>`, and removes the pins of
 * processes that are gone. */
export function pinFrom(exe: string, home: string, pid: number, platform: NodeJS.Platform = process.platform): string {
  const dir = join(home, DIR);
  mkdirPrivate(dir);
  sweep(dir, pid);
  // The file itself, not a symlink to it (an installed `fleetd` is often one), which the update would retarget.
  let source = exe;
  try {
    source = realpathSync(exe);
  } catch {}
  const target = join(dir, `${PREFIX}${pid}`);
  const tmp = join(dir, `.${PREFIX}${pid}.tmp`);
  rmSync(tmp, { force: true });
  let linked = false;
  if (platform !== "darwin") {
    try {
      linkSync(source, tmp);
      linked = true;
    } catch {}
  }
  if (!linked) copyFileSync(source, tmp);
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

/** Removes the pins of processes that no longer run, unless a running process was started from one; never `pid`'s. */
function sweep(dir: string, pid: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const running = runningExes();
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const other = Number(name.slice(PREFIX.length));
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
