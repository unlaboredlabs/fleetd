// The machine's processes as the node sees them (`descendants`,
// `signal`): what the orphan sweeps (../sessions/proc.ts) and a task's end (./host.ts `endLeft`) look through. Each
// process is known by pid and start time, so a pid the kernel has reused since is never signalled.
import { readdirSync, readFileSync } from "node:fs";

export type Proc = {
  pid: number;
  ppid: number;
  pgid: number;
  /** Linux: its session id (`/proc/<pid>/stat` field 6). */
  sid?: number;
  /** Linux: start time in clock ticks since boot (`/proc/<pid>/stat` field 22). Undefined on macOS. */
  start?: number;
  zombie: boolean;
};

/** One `/proc/<pid>/stat` line. The command name sits in parentheses and may itself contain spaces and `)`. */
export function parseStat(pid: number, stat: string): Proc | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const f = stat.slice(close + 1).trim().split(/\s+/);
  const [ppid, pgid] = [Number(f[1]), Number(f[2])];
  if (f[0] === undefined || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return undefined;
  const [sid, start] = [Number(f[3]), Number(f[19])];
  return { pid, ppid, pgid, zombie: f[0] === "Z", ...(Number.isInteger(sid) ? { sid } : {}), ...(Number.isInteger(start) ? { start } : {}) };
}

export function statOf(pid: number): Proc | undefined {
  try {
    return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every process on the machine, as far as this user can see: /proc on Linux, `ps` elsewhere. */
export function table(): Proc[] {
  if (process.platform === "linux") {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return [];
    }
    return names.flatMap((n) => (/^\d+$/.test(n) ? (statOf(Number(n)) ?? []) : []));
  }
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat="], { env: {}, stderr: "ignore" });
  return out.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
      const p = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: !!stat?.startsWith("Z") };
      return Number.isInteger(p.pid) && Number.isInteger(p.ppid) && Number.isInteger(p.pgid) ? [p] : [];
    });
}

/** Every descendant of `root` in `procs`, not `root` itself. None for pid 0 or 1: theirs are the whole machine. */
export function descendants(procs: Proc[], root: number): Proc[] {
  if (root <= 1) return [];
  const children = new Map<number, Proc[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const seen = new Set([root]);
  const next = [root];
  while (next.length) {
    for (const child of children.get(next.pop()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      next.push(child.pid);
    }
  }
  return out;
}

export const dedupe = (procs: Proc[]): Proc[] => [...new Map(procs.map((p) => [p.pid, p])).values()];

/** Still the process that was found (its pid not reused since). */
export function same(p: Proc): boolean {
  if (p.start === undefined) {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const now = statOf(p.pid);
  return now !== undefined && !now.zombie && now.start === p.start;
}

/** Signals every process found: first each group one of them leads (catching members forked since), then each pid.
 * Never the node's own group or pid; errors (already gone, not ours) are ignored. */
export function signal(procs: Proc[], sig: NodeJS.Signals): void {
  const own = statOf(process.pid);
  const kill = (pid: number) => {
    try {
      process.kill(pid, sig);
    } catch {}
  };
  for (const leader of procs) if (leader.pgid === leader.pid && leader.pgid > 1 && leader.pgid !== own?.pgid && same(leader)) kill(-leader.pgid);
  for (const p of procs) if (p.pid > 1 && p.pid !== process.pid && same(p)) kill(p.pid);
}

/** Waits up to `ms` for every process of `procs` to be gone; whether they all went. */
export async function gone(procs: Proc[], ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (!procs.some(same)) return true;
    if (Date.now() >= until) return false;
    await Bun.sleep(20);
  }
}

/** A process's command line and environment, each split at NUL; empty when they can't be read (another user's, or
 * off Linux). */
export function argsAndEnv(pid: number): [string[], string[]] {
  const read = (what: string) => {
    try {
      return readFileSync(`/proc/${pid}/${what}`, "utf8").split("\0").filter(Boolean);
    } catch {
      return [];
    }
  };
  return [read("cmdline"), read("environ")];
}
