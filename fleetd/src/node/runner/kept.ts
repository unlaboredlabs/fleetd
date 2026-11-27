// What every sweep of a session's processes spares (./procs.ts `spareGroups`): the process group listening on a port
// an agent's open share link keeps (decision product.share-link-outlives-agent, ../../shared/share_kept.ts), until the
// link's end. The host's kill ladder as claude exits, the task's end (./host.ts `endLeft`, `killTree`) and a dead
// node's orphans (../sessions/proc.ts) all go through it, so a dev server outlives the agent that shared it, and
// only what its own session started. The node (../share/keep.ts) reads every session's `<host dir>.kept`; a host reads
// its own session's, in a box too, where whoever drives the box writes it.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { keptFile, readKept, type KeptGroup } from "../../shared/share_kept.ts";
import { markerSession } from "../sessions/proc.ts";
import { SESSION_MARKER } from "./host/reaper.ts";
import { readRegistration } from "./host.ts";
import { argsAndEnv, spareGroups, statOf, table } from "./procs.ts";

const linux = process.platform === "linux";

/** A kept file and the session it is of. */
export type KeptSource = { session: string; file: string; dir: string };

/** The kept files under the node's `hosts` dir, one a session. */
export function keptSources(hosts: string): KeptSource[] {
  let names: string[] = [];
  try {
    names = readdirSync(hosts);
  } catch {}
  return names.filter((n) => n.endsWith(".kept")).map((n) => {
    const session = n.slice(0, -".kept".length);
    return { session, dir: join(hosts, session), file: join(hosts, n) };
  });
}

/** Still the group found listening: its listener alive with the same start time, in the same group. */
export function groupAlive(g: KeptGroup): boolean {
  const now = statOf(g.pid);
  return now !== undefined && !now.zombie && now.pgid === g.pgid && (g.start === undefined || now.start === g.start);
}

/** The session a process's marker names (Linux): a node's spawn's `<session>.<node pid>.<nanos>.<n>`, or the session id
 * alone, which the cloud's box spawns carry (its claude's marker, as the in-box host then gives every process). Undefined
 * for one with none, or another user's. */
export function sessionOf(pid: number): string | undefined {
  const prefix = `${SESSION_MARKER}=`;
  const marker = argsAndEnv(pid)[1].find((v) => v.startsWith(prefix))?.slice(prefix.length);
  return marker ? (markerSession(marker) ?? marker) : undefined;
}

/** The sockets listening on TCP `port`, by inode, from /proc/net/tcp and tcp6. */
function listeningInodes(port: number): Set<string> {
  const out = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      // local_address is hex `addr:port`, st 0A is LISTEN, the inode the 10th field.
      if (f[3] === "0A" && Number.parseInt(f[1]?.split(":")[1] ?? "", 16) === port && f[9]) out.add(f[9]);
    }
  }
  return out;
}

/** The pids listening on TCP `port` on this machine, as far as this user can see; on Linux among `among` when given
 * (each pid's open sockets are read, so the fewer the better), else every process. */
export function listeners(port: number, among?: number[]): number[] {
  if (!linux) {
    const out = Bun.spawnSync(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { env: {}, stderr: "ignore" });
    return out.stdout.toString().split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 1);
  }
  const inodes = listeningInodes(port);
  if (!inodes.size) return [];
  let pids = among;
  if (!pids) {
    try {
      pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
    } catch {
      return [];
    }
  }
  return pids.filter((pid) => {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      return false;
    }
    return fds.some((fd) => {
      try {
        const to = readlinkSync(`/proc/${pid}/fd/${fd}`);
        return to.startsWith("socket:[") && inodes.has(to.slice(8, -1));
      } catch {
        return false;
      }
    });
  });
}

/** The groups never kept for `dir`'s session: its claude's and its host's, whose sparing would keep the agent itself. */
export function neverKept(dir: string): Set<number> {
  const r = readRegistration(dir);
  const own = statOf(process.pid)?.pgid;
  return new Set([r?.pid, r?.hostPid, own, 0, 1].filter((n): n is number => n !== undefined));
}

/** The groups to spare now: each kept port's group while its link is open, the one found listening (`group`) while
 * its listener lives, else (Linux) the one a process carrying the session's marker listens with now. */
export function keptGroups(sources: KeptSource[], now = Date.now()): Set<number> {
  const out = new Set<number>();
  for (const s of sources) {
    let text: string;
    try {
      text = readFileSync(s.file, "utf8");
    } catch {
      continue;
    }
    const ports = readKept(text).filter((p) => p.untilMs > now);
    if (!ports.length) continue;
    const never = neverKept(s.dir);
    let own: number[] | undefined;
    for (const p of ports) {
      if (p.group) {
        if (groupAlive(p.group) && !never.has(p.group.pgid)) out.add(p.group.pgid);
        continue;
      }
      if (!linux) continue;
      own ??= table().filter((q) => !q.zombie && sessionOf(q.pid) === s.session).map((q) => q.pid);
      for (const pid of listeners(p.port, own)) {
        const pgid = statOf(pid)?.pgid;
        if (pgid !== undefined && !never.has(pgid)) out.add(pgid);
      }
    }
  }
  return out;
}

/** Whether an open link keeps a dev server of the session whose host dir is `dir`: its worktree and scratch dir, which
 * the server runs from, stay until the link ends. */
export function keepsOpen(dir: string, now = Date.now()): boolean {
  try {
    return readKept(readFileSync(keptFile(dir), "utf8")).some((p) => p.untilMs > now);
  } catch {
    return false;
  }
}

/** The node: every sweep it runs spares what any session's kept file keeps. */
export const keepIn = (hosts: string) => spareGroups(() => keptGroups(keptSources(hosts)));

/** A session host: its sweeps spare what its own session's kept file keeps. */
export const keepFor = (dir: string, session: string) => spareGroups(() => keptGroups([{ session, dir, file: keptFile(dir) }]));
