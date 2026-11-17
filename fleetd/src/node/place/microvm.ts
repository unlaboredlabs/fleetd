// The `microvm` place: each agent's session runs in a Cloud Hypervisor VM of its own (design sandbox-per-agent-design
// §2, §3, §5), the default wherever the machine can run one (../../sandbox/host/capable.ts). A box is:
// - a launcher (bash, in a scope of its own at the agents' OOM score, like a session host) that leads the box's process
//   group and starts passt (the network: in a network namespace of its own where this machine's own addresses lead
//   nowhere, ./net.ts), virtiofsd (the files: ./view.ts, served from a user and mount namespace of its own) and the
//   VMM, and ends with the VMM. It carries the box's marker (box_record.ts BOX_MARKER), so a box nothing records is
//   still found at the node's next start;
// - in the guest, `fleetd sandbox-guest` (the node's own binary over the share), reached through the VMM's hybrid vsock
//   socket (`CONNECT <port>`), over which the node holds one link (../sandbox/box.ts) for the session host's lines, the
//   session's node.sock calls, its TCP forwards and its relay to Claude (./endpoint.ts), which is checked from inside the
//   box before the agent starts there.
// A box boots for a session's setup commands (`run`) or its start, whichever comes first, and its start reuses it when
// it shows every path the session needs. It goes with its session host (the guest powers off once it ended,
// `fleetd.once`), at `stop` and `end`, and by the session row's recorded pid, which is the launcher's. A session that
// can't have a box (`status`) runs as a plain process, for the reason the heartbeat reports, and so does every new
// session for FAILED_MS after a box that couldn't boot or reach Claude (`failed`): a broken VM network costs one start
// a fallback, never the machine's agents.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { ConfinedRun, RunOutcome } from "../cmd/index.ts";
import type { LeadSocketHooks } from "../lead/index.ts";
import { leadSocketPath } from "../lead/index.ts";
import { agentScoreLine } from "../oom.ts";
import { HostLink, LaunchError, prepare, readRegistration, stop as stopHost, startOf, type Launch, type Registration } from "../runner/host.ts";
import { table } from "../runner/procs.ts";
import { hostScope, spawnScoped, type Scope } from "../runner/scope.ts";
import { Box } from "../sandbox/box.ts";
import { canRunVms, type VmCheck } from "../../sandbox/host/capable.ts";
import { ensureTools, findTools, vmDir, type VmTools } from "../../sandbox/host/tools.ts";
import { fleetdDir } from "../../shared/home.ts";
import type { NodeLoad } from "../../shared/node_link.ts";
import type { SessionRole } from "../../shared/sessions.ts";
import { readConfig } from "../config.ts";
import { homeDir, nowIso } from "../util.ts";
import { SLOT_SOCK_VAR, slotSock } from "../build_slots.ts";
import { BOX_MARKER, boxAlive, boxFile, destroyBox, liveProc, readBox, type BoxProc, type BoxRecord } from "./box_record.ts";
import type { Place } from "./index.ts";
import { blockLines, blockScript, hostAddrs, netTools, setBlocks, type NetTools } from "./net.ts";
import { claudeEndpoint, reach, reachOf, type Reach } from "./endpoint.ts";
import { processPlace } from "./process.ts";
import { covers, mountScript, needs, viewOf, type Share, type View } from "./view.ts";

/** A box's guest memory and CPUs (design §7: 4 GiB, 2 vCPUs, as today's 2 build jobs an agent). */
export const GUEST_MEM_BYTES = 4 * 2 ** 30;
export const GUEST_CPUS = 2;
/** What a box takes of the machine's memory, for its cap: the guest plus the VMM, virtiofsd and passt (~30 MB
 * measured), rounded up to 4.1 GiB (design §7's cap table). */
export const MEM_PER_AGENT_BYTES = Math.round(4.1 * 2 ** 30);
/** The vsock port sandbox-guest listens on in every box (each VM has its own vsock space). */
export const GUEST_PORT = 5000;
const GUEST_ADDR = "10.0.2.15";
const GUEST_GW = "10.0.2.2";
const BOOT_MS = 60_000;
const DIAL_EVERY_MS = 100;
const CHECK_EVERY_MS = 60_000;
/** How often the node looks at this machine's addresses while boxes run, to keep each box off new ones. */
export const ADDRS_EVERY_MS = 2_000;
/** How long after a box that failed new sessions run as plain processes. */
export const FAILED_MS = 10 * 60_000;

export type PlaceFor = { sessionId: string; dir: string; role: SessionRole };

/** Where this machine's agents run, and why when it's a plain process: `fix` the command that fixes it, `expected` when
 * it's by choice or the machine's design (turned off, macOS, the VM files on their way), nothing to fix. */
export type VmStatus = { kind: "microvm" } | { kind: "process"; why: string; fix?: string; expected?: true };

/** What a box needs started: its dir, its view, its port, the fleetd binary the guest runs, the tools, the check, and
 * this machine's addresses its network keeps out. */
export type BootPlan = {
  dir: string;
  sessionId: string;
  view: View;
  port: number;
  exe: string;
  tools: VmTools;
  check: Extract<VmCheck, { ok: true }>;
  blocked: string[];
  scope?: Scope;
};
/** What a box's boot leaves: its launcher, its VMM and helpers once they run, and the shell holding its network
 * namespace. */
export type Booted = { leader: BoxProc; helpers: BoxProc[]; net?: BoxProc };

export type MicroVmOptions = {
  /** The node's home. */
  home: string;
  /** The node's fleetd (its pinned binary): the guest runs it. */
  fleetd: string[];
  /** The node's serveLeadSocket hooks, for the box's node.sock calls. */
  lead: () => LeadSocketHooks | undefined;
  /** This machine's scope (runner/scope.ts current), when systemd answers. */
  scope?: () => Promise<Scope | undefined>;
  /** Stand-ins for the tests: the machine's check, its tools, the boot and the dial. */
  check?: () => VmCheck;
  tools?: () => VmTools | undefined;
  fetch?: () => Promise<unknown>;
  boot?: (b: BootPlan) => Promise<Booted>;
  dial?: (dir: string, port: number) => Promise<Duplex>;
  /** This machine's addresses, and how a box's routes are set to keep them out. */
  addrs?: () => string[];
  setBlocks?: (holder: number, want: string[]) => void;
  /** How a box is pointed at Claude and checked (endpoint.ts reach). */
  reach?: (box: Box, r: Reach) => Promise<void>;
  /** fleetd's folders hidden from a box: the fleetd dir, `~/.fleetd` and the node's home by default. */
  hidden?: string[];
  /** The person's home, shared whole. */
  userHome?: string;
  goneMs?: number;
};

/** A box the node holds a link to; `view` is what it shows, absent for a record from before it was kept. */
type Held = { box: Box; view: View | undefined; record: BoxRecord };

export class MicroVm {
  #boxes = new Map<string, Promise<Held>>();
  #checked: { at: number; status: VmStatus } | undefined;
  #fetching: Promise<unknown> | undefined;
  #net: NetTools | undefined;
  #watch: ReturnType<typeof setInterval>;
  #warned = new Set<string>();
  #failed: { until: number; why: string } | undefined;

  constructor(readonly o: MicroVmOptions) {
    this.#watch = setInterval(() => void this.keepOff(), ADDRS_EVERY_MS);
    this.#watch.unref?.();
  }

  #addrs(): string[] {
    return (this.o.addrs ?? hostAddrs)();
  }

  /** Sets each running box's routes to this machine's addresses as they are now, where they changed since: a new DHCP
   * lease, IPv6's rotating addresses or a VPN coming up is out of a box's reach within ADDRS_EVERY_MS. */
  async keepOff(): Promise<void> {
    if (!this.#boxes.size) return;
    const want = this.#addrs();
    for (const [dir, going] of [...this.#boxes]) {
      // A box still booting is set from the addresses as they are when it boots; the next look sees it.
      const held = Bun.peek(going) as Held | Error | Promise<Held>;
      const r = held instanceof Promise || held instanceof Error ? undefined : held.record;
      if (!r?.net || same(r.blocked, want) || !liveProc(r.net)) continue;
      try {
        if (this.o.setBlocks) this.o.setBlocks(r.net.pid, want);
        else {
          this.#net ??= toolsOrThrow();
          setBlocks(this.#net.nsenter, this.#net.ip, r.net.pid, want);
        }
        r.blocked = want;
        if (this.#boxes.get(dir) === going) writeFileSync(boxFile(dir), JSON.stringify(r));
        this.#warned.delete(dir);
      } catch (error) {
        if (!this.#warned.has(dir)) console.warn(`${nowIso()} WARN couldn't keep a VM off this machine's new addresses; trying again {"dir":${JSON.stringify(dir)},"error":${JSON.stringify((error as Error).message)}}`);
        this.#warned.add(dir);
      }
    }
  }

  /** Whether `s` runs in a box when the machine can: a task's agent. A lead or a person's own thread stays a process. */
  wants(s: PlaceFor): boolean {
    return s.role === "worker";
  }

  /** Where this machine's agents run now, and why when not in a VM. Cached a minute; fetches the VM files the first
   * time, while agents run as plain processes. */
  status(now = Date.now()): VmStatus {
    if (this.#checked && now - this.#checked.at < CHECK_EVERY_MS) return this.#checked.status;
    const status = this.#status(now);
    this.#checked = { at: now, status };
    return status;
  }

  #status(now: number): VmStatus {
    let off: unknown;
    try {
      off = readConfig(this.o.home)?.sandbox;
    } catch {}
    if (off === "process") return { kind: "process", why: `turned off on this machine (node.json "sandbox": "process")`, expected: true };
    if (this.#failed && now < this.#failed.until) {
      const at = new Date(this.#failed.until).toISOString().slice(11, 16);
      return { kind: "process", why: `the last VM didn't start: ${this.#failed.why}; the node tries VMs again after ${at} UTC` };
    }
    if (this.o.fleetd.length !== 1) return { kind: "process", why: "this node runs fleetd from source, and a VM runs only its built binary", expected: true };
    if (/\s/u.test(this.o.fleetd[0]!)) return { kind: "process", why: `the fleetd binary's path has a space in it (${this.o.fleetd[0]})` };
    const check = (this.o.check ?? (() => canRunVms(this.o.home)))();
    if (!check.ok) return { kind: "process", why: check.why, ...(check.fix ? { fix: check.fix } : {}), ...(check.expected ? { expected: true } : {}) };
    if (!this.#tools()) {
      this.#fetchTools();
      return { kind: "process", why: "fetching the VM files (Cloud Hypervisor, the guest kernel and root image) for the first time", expected: true };
    }
    return { kind: "microvm" };
  }

  /** A box couldn't boot or reach Claude: new sessions run as plain processes for FAILED_MS, and say why. */
  failed(why: string, now = Date.now()): void {
    this.#failed = { until: now + FAILED_MS, why };
    this.#checked = undefined;
  }

  #tools(): VmTools | undefined {
    return this.o.tools ? this.o.tools() : findTools({ dir: vmDir(this.o.home) });
  }

  #fetchTools(): void {
    if (this.#fetching) return;
    const fetch = this.o.fetch ?? (() => ensureTools({ dir: vmDir(this.o.home) }));
    this.#fetching = fetch()
      .then(() => console.log(`${nowIso()} INFO fetched the VM files: new agents run in VMs of their own`))
      .catch((error) => console.warn(`${nowIso()} WARN couldn't fetch the VM files: ${(error as Error).message}`))
      .finally(() => {
        this.#fetching = undefined;
        this.#checked = undefined;
      });
  }

  /** The place of session `s`: its setup commands boot its box, its start reuses it. */
  bound(s: PlaceFor): Place {
    return {
      kind: "microvm",
      start: (l) => this.start(s, l),
      adopt: (dir) => this.adopt(dir),
      stop: (dir) => this.stop(dir),
      end: (dir) => this.end(dir),
      run: (r) => this.run(s, r),
      read: processPlace.read,
    };
  }

  /** What every command of session `s` sees besides what it names: its session's files, the update hold, the binary. */
  #base(s: PlaceFor): string[] {
    const update = join(this.o.home, "update");
    mkdirSync(update, { recursive: true });
    return [join(this.o.home, "sessions", s.sessionId), update, this.o.fleetd[0]!];
  }

  /** A command's environment in a box: git's GitHub helper, and its builds' turns asked of the node over the box's
   * link (the machine's build slots, not ones of the box's own). */
  #inBox<E extends Record<string, string | undefined>>(env: E): E & Record<string, string> {
    return { ...gitInBox(env), [SLOT_SOCK_VAR]: slotSock(this.o.home) } as E & Record<string, string>;
  }

  #hidden(): string[] {
    return this.o.hidden ?? [fleetdDir(), join(homeDir(), ".fleetd"), this.o.home];
  }

  async run(s: PlaceFor, r: ConfinedRun): Promise<RunOutcome> {
    if (this.status().kind !== "microvm") return processPlace.run(r);
    let held: Held;
    try {
      held = await this.#box(s, needs({ cwd: r.cwd, env: r.env ?? {}, argv: r.argv, ro: this.#base(s) }));
    } catch (error) {
      console.warn(`${nowIso()} WARN no VM for a setup command: it runs as a plain process {"sessionId":"${s.sessionId}","error":${JSON.stringify((error as Error).message)}}`);
      return processPlace.run(r);
    }
    return held.box.run(r.env ? { ...r, env: this.#inBox(r.env) } : r);
  }

  async start(s: PlaceFor, l: Launch): Promise<HostLink> {
    const status = this.status();
    if (status.kind !== "microvm") {
      await this.#drop(l.dir);
      return processPlace.start(l);
    }
    const addDirs = l.args.flatMap((a, i) => (l.args[i - 1] === "--add-dir" ? [a] : []));
    const need = needs({ cwd: l.cwd, env: l.env, argv: [l.program, ...l.args], rw: addDirs, ro: this.#base(s) });
    let held: Held;
    try {
      held = await this.#box(s, need, l.scope);
    } catch (error) {
      console.warn(`${nowIso()} WARN no VM for the session: it runs as a plain process {"sessionId":"${s.sessionId}","error":${JSON.stringify((error as Error).message)}}`);
      this.failed((error as Error).message);
      await this.#drop(l.dir);
      return processPlace.start(l);
    }
    // Claude, whatever its endpoint, through the node, checked from inside the box: a box that can't reach it runs
    // nothing, and the agent runs as a plain process instead of stalling on every call.
    const endpoint = claudeEndpoint(l);
    try {
      const r = reachOf(endpoint.url);
      await (this.o.reach ?? reach)(held.box, r);
      held.record.relays = held.box.relays;
      writeFileSync(boxFile(l.dir), JSON.stringify(held.record));
      this.#failed = undefined;
    } catch (error) {
      const why = `${(error as Error).message} (the endpoint from ${endpoint.source})`;
      console.warn(`${nowIso()} WARN a VM couldn't reach Claude: the session runs as a plain process {"sessionId":"${s.sessionId}","error":${JSON.stringify(why)}}`);
      this.failed(why);
      await this.#drop(l.dir);
      return processPlace.start(l);
    }
    const ports = forwards(l.env);
    try {
      for (const port of ports) await held.box.forward(port);
      if (ports.length) {
        held.record.tcp = [...new Set([...held.record.tcp, ...ports])];
        writeFileSync(boxFile(l.dir), JSON.stringify(held.record));
      }
      // The guest runs as root over files the host's user owns, which claude refuses to skip its prompts for unless it
      // knows it's in a sandbox.
      const info = await held.box.start({ sessionId: l.sessionId, program: l.program, args: l.args, cwd: l.cwd, env: { ...this.#inBox(l.env), IS_SANDBOX: "1" } });
      const leader = held.record.leader;
      const registration: Registration = { protocol: info.protocol, hostPid: leader.pid, hostStart: leader.start, pid: leader.pid, start: leader.start, marker: "", refused: info.refused ?? null };
      writeFileSync(join(l.dir, "host.json"), JSON.stringify(registration));
      if (info.refused) throw new LaunchError(info.refused.message, info.refused);
      return await HostLink.connect(l.dir, { dial: (h) => held.box.dialHost(h), registration });
    } catch (error) {
      await this.stop(l.dir);
      if (error instanceof LaunchError) throw error;
      throw new LaunchError(`no host came up in the VM: ${(error as Error).message}`);
    }
  }

  /** The session's box: the one booted for it when it shows `need` and runs no host yet, else a new one. */
  #box(s: PlaceFor, need: Share[], scope?: Scope): Promise<Held> {
    const going = this.#boxes.get(s.dir);
    const next = (async () => {
      const held = await going?.catch(() => undefined);
      if (held?.view && covers(held.view, need) && boxAlive(held.record) && !readRegistration(s.dir)) return held;
      // A new box shows what the last one did and what this needs; fleetd's own folders stay hidden either way.
      const view = viewOf(this.o.userHome ?? homeDir(), this.#hidden(), [...(held?.view?.shares ?? []), ...need]);
      held?.box.close();
      return this.#boot(s, view, scope ?? (await this.o.scope?.()));
    })();
    this.#boxes.set(s.dir, next);
    next.catch(() => this.#boxes.get(s.dir) === next && this.#boxes.delete(s.dir));
    return next;
  }

  async #boot(s: PlaceFor, view: View, scope: Scope | undefined): Promise<Held> {
    const tools = this.#tools();
    const check = (this.o.check ?? (() => canRunVms(this.o.home)))();
    if (!tools || !check.ok) throw new Error(check.ok ? "the VM files aren't there" : check.why);
    await prepare(s.dir);
    const at = Date.now();
    this.#net = check.net;
    const blocked = this.#addrs();
    const plan: BootPlan = { dir: s.dir, sessionId: s.sessionId, view, port: GUEST_PORT, exe: this.o.fleetd[0]!, tools, check, blocked, ...(scope ? { scope } : {}) };
    const booted = await (this.o.boot ?? bootCloudHypervisor)(plan);
    const record: BoxRecord = { kind: "microvm", leader: booted.leader, helpers: booted.helpers, tcp: [], port: GUEST_PORT, view, ...(booted.net ? { net: booted.net, blocked } : {}) };
    writeFileSync(boxFile(s.dir), JSON.stringify(record));
    try {
      const box = await this.#open(s.dir, s.sessionId, record, at + BOOT_MS);
      console.log(`${nowIso()} INFO a VM is up for the session {"sessionId":"${s.sessionId}","ms":${Date.now() - at},"pid":${record.leader.pid}}`);
      return { box, view, record };
    } catch (error) {
      await destroyBox(s.dir);
      const tail = consoleTail(s.dir);
      throw new Error(`${(error as Error).message}${tail ? `; the VM's console ended: ${tail}` : ""}`);
    }
  }

  /** Dials the box's guest until it answers, the box ends, or `until`. */
  async #open(dir: string, session: string, record: BoxRecord, until: number): Promise<Box> {
    const lead = this.o.lead;
    const dial = this.o.dial ?? vsockDial;
    let last = "it didn't answer";
    for (;;) {
      if (!boxAlive(record)) throw new Error(`the VM ended before its guest answered (${last})`);
      try {
        return await Box.open({
          session,
          dial: () => dial(dir, record.port),
          nodeSock: leadSocketPath(this.o.home),
          slots: { sock: slotSock(this.o.home), home: this.o.home },
          tcp: record.tcp,
          ...(record.relays ? { relays: record.relays } : {}),
          lead: lazyHooks(lead),
          ...(this.o.goneMs !== undefined ? { goneMs: this.o.goneMs } : {}),
        });
      } catch (error) {
        last = (error as Error).message;
      }
      if (Date.now() >= until) throw new Error(`the VM's guest didn't answer within ${BOOT_MS / 1000} s: ${last}`);
      await Bun.sleep(DIAL_EVERY_MS);
    }
  }

  /** After a node restart: dials the box `dir` recorded again and links to the session host in it. */
  async adopt(dir: string): Promise<HostLink | undefined> {
    const record = readBox(dir);
    const registration = readRegistration(dir);
    const session = dir.split("/").at(-1)!;
    if (!record || !registration || !boxAlive(record)) return undefined;
    let box: Box;
    try {
      box = await this.#open(dir, session, record, Date.now() + 5_000);
    } catch {
      return undefined;
    }
    try {
      const link = await HostLink.connect(dir, { dial: (h) => box.dialHost(h), registration });
      this.#boxes.set(dir, Promise.resolve({ box, view: record.view, record }));
      return link;
    } catch {
      box.close();
      return undefined;
    }
  }

  /** Lets go of the box's link and destroys it, with whatever ran in it. */
  async #drop(dir: string): Promise<number> {
    const held = await this.#boxes.get(dir)?.catch(() => undefined);
    this.#boxes.delete(dir);
    const ended = await destroyBox(dir);
    held?.box.close();
    return ended;
  }

  async stop(dir: string): Promise<void> {
    await this.#drop(dir);
    await stopHost(dir);
  }

  /** The task ended: its box goes, with everything its turns left running in it. */
  async end(dir: string): Promise<number> {
    const ended = await this.#drop(dir);
    return ended + (await processPlace.end(dir));
  }

  /** Lets go of every box's link (the node's shutdown): the boxes and their sessions go on for the next node. */
  close(): void {
    clearInterval(this.#watch);
    for (const held of this.#boxes.values()) void held.then((h) => h.box.close(), () => {});
    this.#boxes.clear();
  }
}

const same = (a: string[] | undefined, b: string[]) => a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

function toolsOrThrow(): NetTools {
  const net = netTools();
  if ("missing" in net) throw new Error(`this machine has no ${net.missing}`);
  return net;
}

/** A heartbeat's word on where this machine's agents run: in VMs, sized at MEM_PER_AGENT_BYTES each for the hub's cap,
 * or as plain processes and why. */
export function reportVm(load: Pick<NodeLoad, "sandbox" | "memPerAgentBytes">, status: VmStatus): void {
  load.sandbox = status;
  if (status.kind === "microvm") load.memPerAgentBytes = MEM_PER_AGENT_BYTES;
}

/**
 * `env` with git's GitHub credentials from the box's own `gh`, by name: the person's ~/.gitconfig, shared into the box,
 * names the host's gh by its path (`gh auth setup-git` writes `!/usr/bin/gh auth git-credential`), which the box's
 * system dirs don't have. Added as the command's own config (GIT_CONFIG_*, after any it has), which git reads last: an
 * empty helper drops the ones before it, then gh answers with GH_TOKEN or the person's gh login.
 */
export function gitInBox<E extends Record<string, string | undefined>>(env: E): E & Record<string, string> {
  const n = Math.max(0, Number(env.GIT_CONFIG_COUNT) || 0);
  const key = "credential.https://github.com.helper";
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: key,
    [`GIT_CONFIG_VALUE_${n}`]: "",
    [`GIT_CONFIG_KEY_${n + 1}`]: key,
    [`GIT_CONFIG_VALUE_${n + 1}`]: "!gh auth git-credential",
  };
}

/** The port a URL names on this machine's loopback, if it does. */
function loopbackPort(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return undefined;
    const port = Number(u.port || (u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** The node's ports a session's environment names on this machine's loopback, which its box reaches at the same
 * numbers: the browser's CDP proxy and adb. Only these: any other port of this machine (the hub's) stays out of a box's
 * reach. Claude, wherever it is, is the box's relay (./endpoint.ts). */
export function forwards(env: Record<string, string | undefined>): number[] {
  const ports = new Set<number>();
  const cdp = loopbackPort(env.AGENT_BROWSER_CDP);
  if (cdp !== undefined) ports.add(cdp);
  const adb = Number(env.ANDROID_ADB_SERVER_PORT);
  if (Number.isInteger(adb) && adb > 0 && adb < 65536) ports.add(adb);
  return [...ports];
}

/** The node's hooks, looked up at each call: a box adopted at the node's start comes before its node.sock hooks. */
function lazyHooks(get: () => LeadSocketHooks | undefined): LeadSocketHooks {
  const hooks = () => {
    const h = get();
    if (!h) throw new Error("the node isn't serving calls yet");
    return h;
  };
  return {
    get relay() {
      return hooks().relay;
    },
    identify: (pid) => hooks().identify(pid),
    maskFor: (session) => hooks().maskFor(session),
    get browser() {
      return get()?.browser;
    },
    get mac() {
      return get()?.mac;
    },
  };
}

/** The box's sockets, in its host dir. The launcher's tools are given them relative to that dir (their cwd), so no
 * address outgrows a socket's 108 bytes however deep the node's home is. */
export const SOCKS = { api: "api.sock", fs: "fs.sock", net: "net.sock", vsock: "vsock.sock" } as const;

/** Where to connect to the socket `name` in `dir`: its path, or on Linux, when that is too long for a socket address,
 * the same socket through an open fd of the dir (`done` closes it once connected), as the session host's dial does. */
export function socketAt(dir: string, name: string): { path: string; done: () => void } {
  const path = join(dir, name);
  if (path.length < 100 || process.platform !== "linux") return { path, done: () => {} };
  const fd = openSync(dir, "r");
  let open = true;
  return { path: `/proc/self/fd/${fd}/${name}`, done: () => open && ((open = false), closeSync(fd)) };
}

/** A stream to the guest helper: the VMM's hybrid vsock socket, after `CONNECT <port>` and its `OK`. */
export function vsockDial(dir: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const at = socketAt(dir, SOCKS.vsock);
    const s = connect(at.path);
    s.once("connect", at.done).once("close", at.done);
    let head = Buffer.alloc(0);
    const fail = (why: string) => {
      s.destroy();
      reject(new Error(why));
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(10);
      if (nl < 0) return head.length > 256 ? fail("the VMM's vsock answered no line") : undefined;
      // Held until its reader is on: what came after the answer is the guest's, and goes first.
      s.pause();
      s.off("data", onData);
      s.off("close", onClose);
      s.off("error", onError);
      const line = head.subarray(0, nl).toString();
      if (!line.startsWith("OK ")) return fail(`the VMM's vsock said ${JSON.stringify(line)}`);
      const rest = head.subarray(nl + 1);
      if (rest.length) s.unshift(rest);
      resolve(s);
      setImmediate(() => s.resume());
    };
    const onClose = () => reject(new Error("the guest isn't listening yet"));
    const onError = (e: Error) => reject(e);
    s.on("data", onData).once("close", onClose).once("error", onError);
    s.once("connect", () => s.write(`CONNECT ${port}\n`));
  });
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The last lines of the VM's console, for why it didn't come up. */
function consoleTail(dir: string): string {
  try {
    const text = readFileSync(join(dir, "console.log"), "utf8").trim();
    return text.split("\n").slice(-4).join(" | ").slice(-600);
  } catch {
    return "";
  }
}

/** The kernel's command line: the read-only root, fleetd's init and what it reads (sandbox/image/init.sh). */
export function kernelCmdline(p: { exe: string; port: number; dns: string[]; now: number }): string {
  return [
    "console=ttyS0",
    "root=/dev/vda",
    "ro",
    "rootfstype=ext4",
    "init=/sbin/fleetd-init",
    "i8042.noaux",
    "i8042.nomux",
    "i8042.nopnp",
    "i8042.dumbkbd",
    `fleetd.exe=${p.exe}`,
    `fleetd.port=${p.port}`,
    `fleetd.now=${Math.floor(p.now / 1000)}`,
    `fleetd.net=${GUEST_ADDR}/24,${GUEST_GW}`,
    ...(p.dns.length ? [`fleetd.dns=${p.dns.join(",")}`] : []),
    "fleetd.once=1",
  ].join(" ");
}

/** The flags pasta (passt's binary under that name) links a box's network namespace to this machine's network with:
 * no ports in either way (`-t`/`-u` into it, `-T`/`-U` out of it to this machine's loopback), and no gateway address
 * that means this machine. */
export const PASTA_FLAGS = ["-q", "-f", "--config-net", "-t", "none", "-u", "none", "-T", "none", "-U", "none", "--no-map-gw"];

/** The launcher's script, run in the box's host dir: passt and virtiofsd in the background, then the VMM once both
 * listen, each with the box's sockets by name in that dir (SOCKS); it ends with the VMM, and its helpers with it. passt runs in a network namespace of its own, which pasta links to this machine's network,
 * behind a shell that first routes this machine's own addresses (`blocks`, ./net.ts) nowhere. Their pids go to `pids`
 * as `<vmm> <pasta> <virtiofsd>`. */
export function launcherScript(b: BootPlan, now: number): string {
  const { dir, tools, check, view } = b;
  const viewDir = join(dir, "view");
  const virtiofsd = [tools.virtiofsd, `--socket-path=${SOCKS.fs}`, `--shared-dir=${viewDir}`, "--sandbox=namespace", "--announce-submounts", "--cache=auto", "--log-level=error"];
  const passt = [tools.passt, "--vhost-user", "--socket", SOCKS.net, "--foreground", "--one-off", "--quiet", "--no-map-gw", "-a", GUEST_ADDR, "-n", "24", "-g", GUEST_GW, "-t", "none", "-u", "none"];
  // The shell stays, holding the namespace for the node's later route changes (nsenter), and ends with passt.
  const inNamespace = [`cd ${q(dir)} || exit 1`, blockScript(check.net.ip, join(dir, "blocks")), `${passt.map(q).join(" ")} &`, "wait $!"].join("\n");
  const pasta = `(exec -a pasta ${[tools.passt, ...PASTA_FLAGS, "--", "/bin/sh", "-c", inNamespace].map(q).join(" ")})`;
  const vmm = [
    tools.cloudHypervisor,
    "--api-socket",
    `path=${SOCKS.api}`,
    "--kernel",
    tools.kernel,
    "--cmdline",
    kernelCmdline({ exe: b.exe, port: b.port, dns: check.dns, now }),
    "--disk",
    `path=${tools.root},readonly=on,image_type=raw`,
    "--cpus",
    `boot=${GUEST_CPUS}`,
    "--memory",
    `size=${GUEST_MEM_BYTES / 2 ** 20}M,shared=on`,
    "--fs",
    `tag=view,socket=${SOCKS.fs}`,
    "--net",
    `vhost_user=true,socket=${SOCKS.net},num_queues=2`,
    "--vsock",
    `cid=3,socket=${SOCKS.vsock}`,
    "--serial",
    `file=${join(dir, "console.log")}`,
    "--console",
    "off",
  ];
  const vmmLine = check.kvm === "sg" ? `sg kvm -c ${q(`exec ${vmm.map(q).join(" ")}`)}` : vmm.map(q).join(" ");
  const views = mountScript(view, viewDir, virtiofsd);
  return [
    agentScoreLine(),
    `cd ${q(dir)} || exit 1`,
    `${pasta} 2>>box.log &`,
    "p=$!",
    `unshare --user --map-root-user --mount --propagation private -- /bin/sh -c ${q(views)} 2>>box.log &`,
    "v=$!",
    "i=0",
    'until [ -S net.sock ] && [ -S fs.sock ]; do i=$((i+1)); if [ $i -gt 1000 ] || ! kill -0 $p $v 2>/dev/null; then echo "passt or virtiofsd didn\'t start" >>box.log; kill $p $v 2>/dev/null; exit 1; fi; sleep 0.01; done',
    `${vmmLine} 2>>box.log &`,
    "c=$!",
    'echo "$c $p $v" > pids',
    "wait $c",
    "s=$?",
    "kill $p $v 2>/dev/null",
    "exit $s",
  ].join("\n");
}

/** Starts a box's launcher, in a scope of its own that outlives the node, and waits for its VMM to run. */
export async function bootCloudHypervisor(b: BootPlan): Promise<Booted> {
  mkdirSync(join(b.dir, "view"), { recursive: true });
  writeFileSync(join(b.dir, "blocks"), blockLines(b.blocked));
  const log = openSync(join(b.dir, "box.log"), "a");
  let child;
  try {
    const started = await spawnScoped(b.scope && hostScope(b.scope), "/bin/bash", ["-c", launcherScript(b, Date.now())], b.sessionId, (program, argv, scope) =>
      spawn(program, argv, {
        cwd: b.dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homeDir(), LANG: "C.UTF-8", [BOX_MARKER]: b.dir, ...scope?.env },
        stdio: ["ignore", "ignore", log],
        // A group of its own, which it leads: the box's processes, killed as one.
        detached: true,
      }),
    );
    child = started.child;
  } finally {
    closeSync(log);
  }
  child.unref();
  const pid = child.pid;
  const start = pid ? startOf(pid) : undefined;
  if (!pid || start === undefined) throw new Error(`the VM's launcher didn't start: ${boxLog(b.dir)}`);
  const leader = { pid, start };
  const until = Date.now() + 15_000;
  for (;;) {
    const pids = readPids(b.dir);
    if (pids) {
      // pasta's child: the shell holding the box's network namespace.
      const pasta = pids[1];
      const holder = pasta && table().find((p) => p.ppid === pasta.pid && p.start !== undefined && !p.zombie);
      const net = holder ? { pid: holder.pid, start: holder.start! } : undefined;
      return { leader, helpers: net ? [...pids, net] : pids, ...(net ? { net } : {}) };
    }
    if (startOf(pid) !== start || child.exitCode !== null) throw new Error(`the VM didn't start: ${boxLog(b.dir)}`);
    if (Date.now() >= until) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      throw new Error(`the VM's helpers didn't start within 15 s: ${boxLog(b.dir)}`);
    }
    await Bun.sleep(10);
  }
}

function readPids(dir: string): BoxProc[] | undefined {
  try {
    const text = readFileSync(join(dir, "pids"), "utf8");
    if (!text.endsWith("\n")) return undefined;
    return text
      .trim()
      .split(/\s+/u)
      .map(Number)
      .flatMap((pid) => {
        const start = startOf(pid);
        return start === undefined ? [] : [{ pid, start }];
      });
  } catch {
    return undefined;
  }
}

function boxLog(dir: string): string {
  try {
    return readFileSync(join(dir, "box.log"), "utf8").trim().split("\n").slice(-3).join(" | ").slice(-500) || "no output";
  } catch {
    return "no output";
  }
}
