// A shared dev server outlives the agent that shared it (decision product.share-link-outlives-agent). The workspace's
// `share_kept` lists every open link an agent made on this machine, each time one of them changes and as the machine
// links. For each, the node finds the process group listening on the port, only when its listener is the agent's own
// session's (it carries the session's marker on Linux, it is under the session's host on macOS), and writes it to the
// session's `<host dir>.kept`, which every sweep of a session's processes spares (../runner/kept.ts). A port the list
// no longer names, or whose link's end passed, is let go: while the session still runs, its own end takes the server as
// before; once it has ended, the node stops the group (SIGTERM, then SIGKILL). A machine that shuts down stops it with
// everything else. A session in a hosted box has no process here: whoever drives the box keeps its server.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keptFile, keptText, readKept, type KeptGroup, type KeptLink, type KeptPort } from "../../shared/share_kept.ts";
import { nowIso } from "../util.ts";
import { hostAlive, readRegistration } from "../runner/host.ts";
import { groupAlive, keptSources, listeners, neverKept, sessionOf, type KeptSource } from "../runner/kept.ts";
import { descendants, statOf, table } from "../runner/procs.ts";

/** How often the ports are looked at: ended links' servers stop, groups not found yet are looked for. */
export const TICK_MS = 5_000;
/** How long a group that isn't found is left before it is looked for again. */
const FIND_AGAIN_MS = 30_000;
/** After SIGTERM, how long a stopped server has before SIGKILL. */
const STOP_GRACE_MS = 5_000;

const linux = process.platform === "linux";

export type KeeperDeps = {
  now: () => number;
  /** Whether the session runs in a hosted box, whose processes aren't this machine's. */
  boxed: (session: string) => boolean;
};

export class Keeper {
  /** When each session's port was last looked for, by `<session> <port>`. */
  readonly #tried = new Map<string, number>();
  /** Stops under way, by group, so a tick and a sync never stop one twice. */
  readonly #stopping = new Map<number, Promise<void>>();

  constructor(
    readonly hosts: string,
    private readonly deps: KeeperDeps,
  ) {}

  /** The workspace's list of the machine's open agent links: each named port kept, every other let go. */
  async sync(links: KeptLink[]): Promise<void> {
    const want = new Map<string, KeptLink[]>();
    for (const l of links) want.set(l.thread, [...(want.get(l.thread) ?? []), l]);
    const sources = keptSources(this.hosts);
    for (const s of sources) {
      const had = this.#read(s);
      const now = (want.get(s.session) ?? []).map((l): KeptPort => {
        const old = had.find((p) => p.port === l.port);
        return { port: l.port, untilMs: l.untilMs, ...(old?.group ? { group: old.group } : {}) };
      });
      for (const p of had) if (!now.some((n) => n.port === p.port)) await this.#letGo(s, p);
      this.#write(s, now);
      want.delete(s.session);
    }
    for (const [session, ls] of want) {
      const dir = join(this.hosts, session);
      this.#write({ session, dir, file: keptFile(dir) }, ls.map((l) => ({ port: l.port, untilMs: l.untilMs })));
    }
    await this.tick();
  }

  /** Lets go of the ports whose link ended, and looks for the groups of the rest not found yet. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    for (const s of keptSources(this.hosts)) {
      const ports = this.#read(s);
      const open = ports.filter((p) => p.untilMs > now);
      for (const p of ports) if (p.untilMs <= now) await this.#letGo(s, p);
      let changed = open.length !== ports.length;
      for (const p of open) {
        if (p.group && groupAlive(p.group)) continue;
        // The server that listened went (it restarted, or the agent stopped it): the port's new one is looked for.
        if (p.group) {
          delete p.group;
          changed = true;
        }
        const key = `${s.session} ${p.port}`;
        if (now - (this.#tried.get(key) ?? -Infinity) < FIND_AGAIN_MS || this.deps.boxed(s.session)) continue;
        this.#tried.set(key, now);
        const group = findGroup(s, p.port);
        if (group) {
          p.group = group;
          changed = true;
          console.log(`${nowIso()} INFO a shared port's dev server is kept past its session {"sessionId":"${s.session}","port":${p.port},"pgid":${group.pgid}}`);
        }
      }
      if (changed) this.#write(s, open);
    }
  }

  /** `p` is no longer kept: its server stops once its session has ended; while the session runs, its end takes it. */
  async #letGo(s: KeptSource, p: KeptPort): Promise<void> {
    this.#tried.delete(`${s.session} ${p.port}`);
    const r = readRegistration(s.dir);
    if (r && hostAlive(r)) return;
    const g = p.group && groupAlive(p.group) ? p.group : this.deps.boxed(s.session) ? undefined : findGroup(s, p.port);
    if (!g) return;
    const under = this.#stopping.get(g.pgid);
    if (under) return under;
    const run = stopGroup(s.session, g).finally(() => this.#stopping.delete(g.pgid));
    this.#stopping.set(g.pgid, run);
    await run;
  }

  #read(s: KeptSource): KeptPort[] {
    try {
      return readKept(readFileSync(s.file, "utf8"));
    } catch {
      return [];
    }
  }

  #write(s: KeptSource, ports: KeptPort[]): void {
    if (!ports.length) {
      rmSync(s.file, { force: true });
      return;
    }
    if (!existsSync(this.hosts)) return;
    writeFileSync(s.file, keptText(ports), { mode: 0o600 });
  }
}

/** The group listening on `port` that session `s` started, if one does: on Linux a listener carrying the session's
 * marker, on macOS (no environment to read) one under the session's host while it runs. Never claude's or the host's own. */
export function findGroup(s: KeptSource, port: number): KeptGroup | undefined {
  const procs = table();
  let own: number[];
  if (linux) own = procs.filter((p) => !p.zombie && sessionOf(p.pid) === s.session).map((p) => p.pid);
  else {
    const r = readRegistration(s.dir);
    own = r && hostAlive(r) ? descendants(procs, r.hostPid).map((p) => p.pid) : [];
  }
  if (!own.length) return undefined;
  const never = neverKept(s.dir);
  for (const pid of listeners(port, linux ? own : undefined)) {
    if (!own.includes(pid)) continue;
    const st = statOf(pid);
    if (!st || st.zombie || never.has(st.pgid)) continue;
    return { pid, pgid: st.pgid, ...(st.start !== undefined ? { start: st.start } : {}) };
  }
  return undefined;
}

/** Stops the kept group `g` of `session`: SIGTERM to the group, SIGKILL after the grace to what is left of it. Only
 * while it is still that group: its listener alive as found, or (Linux) a member carrying the session's marker. */
export async function stopGroup(session: string, g: KeptGroup, graceMs = STOP_GRACE_MS): Promise<void> {
  const ours = () => groupAlive(g) || (linux && table().some((p) => p.pgid === g.pgid && !p.zombie && sessionOf(p.pid) === session));
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-g.pgid, sig);
    } catch {}
  };
  if (!ours()) return;
  console.log(`${nowIso()} INFO stopping a shared port's dev server: its link ended {"sessionId":"${session}","pgid":${g.pgid}}`);
  kill("SIGTERM");
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    await Bun.sleep(100);
    if (!ours()) return;
  }
  if (ours()) kill("SIGKILL");
}
