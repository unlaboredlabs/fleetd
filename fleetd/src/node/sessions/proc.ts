// What sessions of a node that went away left running: a recorded claude
// with its tool children, and the browsers and servers of sessions' scratch dirs. A process is known by pid plus
// start time, so a pid the kernel has since reused is never signalled.
import { join, sep } from "node:path";
import { SESSION_MARKER } from "../runner/claude.ts";
import { argsAndEnv, dedupe, descendants, gone, signal, statOf, table, type Proc } from "../runner/procs.ts";

/** After SIGTERM, how long a leftover gets to go before SIGKILL. */
const ORPHAN_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for the swept processes to be gone. */
const KILL_WAIT_MS = 2_000;

/** Where a process of a screen or a session lives under the node's home: the sessions' scratch dirs (an agent's own
 * headless Chrome keeps its profile there) and the browser pool's profiles. */
export const orphanRoots = (home: string): [string, string] => [join(home, "tmp"), join(home, "browser", "profiles")];

const under = (dir: string, roots: string[]) => roots.some((root) => dir.startsWith(`${root}${sep}`) && dir.length > root.length + 1);

/** Whether a process (its command line and environment) is a session's or a screen's: a browser whose profile
 * (`--user-data-dir`) is under `roots`, or a process whose TMPDIR is a session's scratch dir (`roots[0]`). One that
 * merely names such a path (a person's `less` or `tail -f` of a file there) is not. */
export function orphaned(args: string[], env: string[], roots: string[]): boolean {
  let profile: string | undefined;
  for (let i = 0; i < args.length && profile === undefined; i++) {
    if (args[i]!.startsWith("--user-data-dir=")) profile = args[i]!.slice("--user-data-dir=".length);
    else if (args[i] === "--user-data-dir") profile = args[i + 1];
  }
  const tmpdir = env.find((v) => v.startsWith("TMPDIR="))?.slice("TMPDIR=".length);
  return (profile !== undefined && under(profile, roots)) || (tmpdir !== undefined && under(tmpdir, roots.slice(0, 1)));
}

/** Stops what sessions and screens of a node that went away left running, with everything they started: as the node
 * starts, before any session of its own runs, no live session owns them (the Oct 26 headless Chrome, its profile
 * under a session's scratch dir, ran on for days). SIGTERM first, SIGKILL to those still there after the grace. Never
 * one of `keep`: the processes of sessions the node re-adopted. How many it found. Linux only: elsewhere a process's
 * environment can't be read here. */
export async function killOrphans(home: string, keep: Set<number>, graceMs = ORPHAN_GRACE_MS): Promise<number> {
  if (process.platform !== "linux") return 0;
  const roots = orphanRoots(home);
  const procs = table();
  const found = procs.filter((p) => p.pid !== process.pid && !p.zombie && !keep.has(p.pid) && orphaned(...argsAndEnv(p.pid), roots));
  const count = found.length;
  const all = dedupe([...found, ...found.flatMap((p) => descendants(procs, p.pid))]).filter((p) => p.pid !== process.pid && !keep.has(p.pid));
  if (!all.length) return 0;
  signal(all, "SIGTERM");
  if (!(await gone(all, graceMs))) signal(all, "SIGKILL");
  return count;
}

/** The session id in a spawn's marker, `<session>.<node pid>.<nanos>.<n>` (../runner/host.ts `marker`). Session ids
 * may hold dots themselves, so it is everything before the last three fields. */
export function markerSession(marker: string): string | undefined {
  const fields = marker.split(".");
  return fields.length > 3 ? fields.slice(0, -3).join(".") : undefined;
}

/** The live processes whose marker names `session`. */
function spawnedFor(procs: Proc[], session: string): Proc[] {
  const prefix = `${SESSION_MARKER}=`;
  return procs.filter((p) => {
    if (p.pid === process.pid || p.zombie) return false;
    const marker = argsAndEnv(p.pid)[1].find((v) => v.startsWith(prefix));
    return marker !== undefined && markerSession(marker.slice(prefix.length)) === session;
  });
}

/** What session `session` left: claude's descendants while claude (`root`) is still the recorded process, and every
 * process carrying a marker of any of the session's spawns, which also finds tool children orphaned when claude died. */
function sweep(root: number | undefined, session: string): Proc[] {
  const procs = table();
  return dedupe([...(root ? descendants(procs, root) : []), ...spawnedFor(procs, session).filter((p) => p.pid !== root)]);
}

/** Stops what session `session` left running when the node went away: SIGTERM to claude's process group (claude
 * kills its tool children on SIGTERM), SIGKILL after `graceMs`, then SIGKILL to every swept process and group. The
 * sweep comes before each signal, because once claude is gone its children can no longer be found by ppid. claude
 * itself is signalled only while `pid` still has the recorded start time. */
export async function killRecorded(pid: number, started: string, session: string, graceMs: number): Promise<void> {
  if (process.platform !== "linux") return;
  const alive = () => {
    const p = statOf(pid);
    return p !== undefined && !p.zombie && String(p.start) === started;
  };
  const root = pid > 1 && alive() ? pid : undefined;
  let swept = sweep(root, session);
  if (root === undefined && !swept.length) return;
  console.warn(`${new Date().toISOString()} WARN stopping claude processes left from before the node restarted {"pid":${pid},"sessionId":"${session}","leftover":${swept.length}}`);
  if (root !== undefined) {
    const kill = (sig: NodeJS.Signals) => {
      try {
        process.kill(-root, sig);
      } catch {}
    };
    kill("SIGTERM");
    const until = Date.now() + graceMs;
    while (alive() && Date.now() < until) await Bun.sleep(100);
    swept = dedupe([...swept, ...sweep(alive() ? root : undefined, session)]);
    if (alive()) kill("SIGKILL");
  }
  signal(swept, "SIGKILL");
  await gone(swept, KILL_WAIT_MS);
}
