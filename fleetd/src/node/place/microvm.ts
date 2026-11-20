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
// A box sees nothing of the person's home or this machine's config (D557): its share holds its worktree and git store,
// fleetd's own files for it (./view.ts), and what ./provision.ts gives it (its own home, the VM caches, its order's
// variables, claude and Claude's settings); its system is its image's. In the guest the agent runs at this machine's
// user's ids (../sandbox/system.ts); and the node watches the files each box's share holds open (`watchShares`), which
// the guest forgets before they reach virtiofsd's limit.
// A box boots for a session's setup commands (`run`) or its start, whichever comes first, and its start reuses it when
// it shows every path the session needs. It goes with its session host (the guest powers off once it ended,
// `fleetd.once`), at `stop` and `end`, and by the session row's recorded pid, which is the launcher's. A session that
// can't have a box (`status`) runs as a plain process, for the reason the heartbeat reports, and so does every new
// session for FAILED_MS after a box that couldn't boot or reach Claude (`failed`): a broken VM network costs one start
// a fallback, never the machine's agents.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import type { Duplex } from "node:stream";
import type { ConfinedRun, RunOutcome } from "../cmd/index.ts";
import type { LeadSocketHooks } from "../lead/index.ts";
import { leadSocketPath } from "../lead/index.ts";
import { agentScoreLine } from "../oom.ts";
import { HostLink, LaunchError, prepare, readRegistration, stop as stopHost, startOf, type Launch, type Registration } from "../runner/host.ts";
import { descendants, table } from "../runner/procs.ts";
import { hostScope, spawnScoped, type Scope } from "../runner/scope.ts";
import { Box } from "../sandbox/box.ts";
import { excludeInCheckout } from "../sessions/files.ts";
import { OOM_HOOK } from "../sandbox/system.ts";
import { canRunVms, type VmCheck } from "../../sandbox/host/capable.ts";
import { ensureTools, findTools, vmDir, type VmTools } from "../../sandbox/host/tools.ts";
import type { NodeLoad } from "../../shared/node_link.ts";
import type { SessionRole } from "../../shared/sessions.ts";
import type { Size } from "../../sandbox/providers/common.ts";
import { readConfig } from "../config.ts";
import { nowIso } from "../util.ts";
import { SLOT_SOCK_VAR, slotSock } from "../build_slots.ts";
import { heldDirOf } from "../hold.ts";
import { BOX_MARKER, boxAlive, boxFile, destroyBox, liveProc, readBox, type BoxProc, type BoxRecord } from "./box_record.ts";
import type { Place } from "./index.ts";
import { blockLines, blockScript, hostAddrs, netTools, setBlocks, type NetTools } from "./net.ts";
import { claudeEndpoint, fromProject, reach, reachOf, withPostToolHook, type Reach } from "./endpoint.ts";
import { BOX_HOME, forClaude, machineSignIn, NoClaudeLogin, provision, transcriptBack, unprovision, type Provisioned, type Transcript } from "./provision.ts";
import { imagesDir, newDisk, sessionDisk, sessionLayer, type Backend, type Built, type Job } from "./image.ts";
import { IMAGE } from "../../sandbox/image/recipe.ts";
import { how, SETUP_TIMEOUT_SEC, type Ran } from "../worktree/setup.ts";
import { processPlace } from "./process.ts";
import { covers, mountScript, needs, viewOf, type Share, type View } from "./view.ts";

/** What the guest's init leaves when a box stacked its bot's image (sandbox/image/init.sh). */
export const IMAGE_MARKER = "/run/fleetd/image";

/** A box's guest memory by default, GiB, and its CPUs. 4 GiB, as the cap counts it whole: fleetd's own check peaked at
 * 3 GB, but a real crate's tests didn't link in it (rustc killed at 3.5 GB). A machine that builds such sets its own in
 * node.json (`vmMemoryGiB`, 2 to 256), and an agent that runs out is told so. No compressed swap: the guest kernel has
 * no zram, and zswap needs a swap device the guest has nowhere to put. 4 vCPUs,
 * which cost no memory and match the 4 workers an agent's test runners get: with 2, fleetd's own test suite took
 * 317.7 s in a VM, and 238.8 s with 4 beside it. */
export const GUEST_MEM_GIB = 4;
export const GUEST_CPUS = 4;

/** This machine's VMs' memory, GiB: node.json's `vmMemoryGiB` when it's a whole number from 2 to 256, else the default. */
export function guestMemGiB(home: string): number {
  let n: unknown;
  try {
    n = readConfig(home)?.vmMemoryGiB;
  } catch {}
  return typeof n === "number" && Number.isInteger(n) && n >= 2 && n <= 256 ? n : GUEST_MEM_GIB;
}

/** What a box takes of the machine's memory, for its cap: all of its guest's (what a guest has touched isn't given
 * back), plus the VMM, virtiofsd and passt (~30 MB measured), rounded up by 0.1 GiB (design §7's cap table). */
export const memPerAgentBytes = (gib: number) => Math.round((gib + 0.1) * 2 ** 30);
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
/** What lets a machine signed in with `claude login` run all its agents in VMs: a token a VM can be given, which this
 * command prints (`SIGN_IN_HOW` says where it goes). */
export const SIGN_IN_FIX = "claude setup-token";
export const SIGN_IN_HOW =
  "put the token `claude setup-token` prints in ~/.fleetd/claude.env as CLAUDE_CODE_OAUTH_TOKEN=<token>, and they run in VMs within a minute";

/** How often the node counts the files each box's share holds open. */
export const SHARE_EVERY_MS = 1_000;

/** The session a place is picked for; `account`: it runs on a Claude account of its bot's (actions/accounts.ts), a
 * sign-in of its own a VM can be given wherever the machine's own can't be. */
export type PlaceFor = {
  sessionId: string;
  dir: string;
  role: SessionRole;
  account?: boolean;
  /** An image build's box: this disk is its own (the image it makes), over the bare root image. */
  disk?: string;
  /** Its bot's pick of a Local VM's size, exactly (shared/computer.ts); absent: this machine's default. */
  size?: Size;
};

/** The node's dirs of the tools it installs for agents (./view.ts fleetdOwn), shown to every box that has them. */
const TOOL_DIRS = ["browser/agent-browser", "device/agent-device", "build-slots/bin", "mac/bin"];

/** Where this machine's agents run, and why when it's a plain process (or, in VMs, which of them don't and why:
 * `why` and `fix` on `microvm`): `fix` the command that fixes it, `expected` when
 * it's by choice or the machine's design (turned off, macOS, the VM files on their way), nothing to fix. */
export type VmStatus = { kind: "microvm"; why?: string; fix?: string; accountsOnly?: true } | { kind: "process"; why: string; fix?: string; expected?: true; detail?: string };

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
  /** The guest's memory, GiB (GUEST_MEM_GIB when absent). */
  memGiB?: number;
  /** The guest's vCPUs (GUEST_CPUS when absent). */
  cpus?: number;
  /** The box's own home (./provision.ts), the agent's user's in its /etc/passwd. */
  home?: string;
  /** Its own writable disk (./image.ts), and the bot's image it stacks over, read-only. */
  disk?: string;
  layer?: string;
};
/** What a box's boot leaves: its launcher, its VMM and helpers once they run, virtiofsd among them, and the shell
 * holding its network namespace. */
export type Booted = { leader: BoxProc; helpers: BoxProc[]; fs?: BoxProc; net?: BoxProc };

/** The files a box's share (virtiofsd) holds open, and how many it may. */
export type ShareFds = { open: number; limit: number };

/**
 * The count at which a box's guest is told to forget its files (`Box.forget`), given the lowest count seen since it
 * last was: a quarter of the share's limit, or an eighth over what the agent's own open files keep, whichever is more.
 * virtiofsd keeps an fd for each file the guest's kernel has looked up until the kernel forgets it, which a guest with
 * memory to spare never does by itself: a `bun install` over a large cache took one to its limit in two minutes, and
 * every file open in the box failed after (ENFILE). Forgetting at a quarter leaves the other three for the seconds
 * before the next count, at any rate a guest looks files up.
 */
export const forgetAt = (limit: number, low: number) => Math.max(Math.floor(limit / 4), low + Math.floor(limit / 8));


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
  /** The environment this machine's claude runs with (the node's runner env): what says whether a VM can be given a
   * way to sign in to Claude (./provision.ts machineSignIn). Unset: not checked. */
  claudeEnv?: () => Record<string, string | undefined>;
  goneMs?: number;
  /** How a box's share's open files are counted, and how its guest is told to forget its files (the stand-ins'), and
   * how often. */
  shareFds?: (r: BoxRecord) => ShareFds | undefined;
  forget?: (box: Box) => Promise<void>;
  shareEveryMs?: number;
  /** Where a box says it stacked its bot's image (IMAGE_MARKER): the stand-ins'. */
  imageMarker?: string;
  /** How an image build's box seals its disk (`sealScript`, as root): the stand-ins'. */
  seal?: (box: Box, script: string, scrub: string[]) => Promise<RunOutcome>;
};

/** What the share watch knows of one box: its virtiofsd processes, and the lowest count since it last forgot (0
 * before it ever did). */
type ShareWatch = { procs?: BoxProc[]; low: number; full?: boolean };

/** A box the node holds a link to; `view` is what it shows, absent for a record from before it was kept. */
type Held = { box: Box; view: View | undefined; record: BoxRecord };

export class MicroVm {
  #boxes = new Map<string, Promise<Held>>();
  #checked: { at: number; status: VmStatus } | undefined;
  #fetching: Promise<unknown> | undefined;
  #net: NetTools | undefined;
  #watch: ReturnType<typeof setInterval>;
  #warned = new Set<string>();
  #failed: { until: number; why: string; detail?: string } | undefined;
  #shareWatch: ReturnType<typeof setInterval>;
  #shares = new Map<string, ShareWatch>();
  #counting = false;
  /** The host dirs of the image builds under way: the node's shutdown ends them (`close`). */
  #building = new Set<string>();
  /** Each box's copies of its order's variables, made again when the node renews them. */
  #refresh = new Map<string, () => void>();

  constructor(readonly o: MicroVmOptions) {
    this.#watch = setInterval(() => void this.keepOff(), ADDRS_EVERY_MS);
    this.#watch.unref?.();
    this.#shareWatch = setInterval(() => void this.watchShares(), o.shareEveryMs ?? SHARE_EVERY_MS);
    this.#shareWatch.unref?.();
  }

  /**
   * Counts the files each running box's share holds open, and has a box whose count reached `forgetAt` forget the
   * files it isn't using, so no agent ever meets the share's limit; says so in the node's log, and warns when what
   * the agent itself keeps open nears it.
   */
  async watchShares(): Promise<void> {
    if (this.#counting || !this.#boxes.size) return;
    this.#counting = true;
    try {
      for (const [dir, going] of [...this.#boxes]) {
        const held = Bun.peek(going) as Held | Error | Promise<Held>;
        if (held instanceof Promise || held instanceof Error) continue;
        const w = this.#shares.get(dir) ?? { low: 0 };
        this.#shares.set(dir, w);
        const count = () => (this.o.shareFds ?? ((r) => shareFds(r, w)))(held.record);
        const fds = count();
        if (!fds) continue;
        w.low = Math.min(w.low, fds.open);
        if (fds.open >= forgetAt(fds.limit, w.low)) await this.#forget(dir, held, w, fds, count);
      }
    } finally {
      this.#counting = false;
    }
  }

  async #forget(dir: string, held: Held, w: ShareWatch, before: ShareFds, count: () => ShareFds | undefined): Promise<void> {
    const session = dir.split("/").at(-1)!;
    try {
      await (this.o.forget ? this.o.forget(held.box) : held.box.forget());
    } catch (error) {
      console.warn(`${nowIso()} WARN a VM's file share holds ${before.open} open files of its ${before.limit}, and the VM couldn't forget the ones it isn't using {"sessionId":"${session}","error":${JSON.stringify((error as Error).message)}}`);
      return;
    }
    // virtiofsd closes them as the guest's word of each reaches it.
    await Bun.sleep(100);
    const after = count()?.open ?? before.open;
    w.low = after;
    console.log(`${nowIso()} INFO a VM's file share held ${before.open} open files of its ${before.limit}: the VM forgot the ones it wasn't using, ${after} now {"sessionId":"${session}"}`);
    const full = after >= before.limit / 2;
    if (full && !w.full) console.warn(`${nowIso()} WARN the agent in a VM keeps ${after} files open itself, of its file share's ${before.limit}: at ${before.limit} every file open in its VM fails {"sessionId":"${session}"}`);
    w.full = full;
  }

  #addrs(): string[] {
    return (this.o.addrs ?? hostAddrs)();
  }

  /** Sets each running box's routes to this machine's addresses as they are now, where they changed since: a new DHCP
   * lease, IPv6's rotating addresses or a VPN coming up is out of a box's reach within ADDRS_EVERY_MS. */
  async keepOff(): Promise<void> {
    if (!this.#boxes.size) return;
    for (const refresh of this.#refresh.values()) {
      try {
        refresh();
      } catch {}
    }
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

  /** This machine's VMs' memory, GiB. */
  memGiB(): number {
    return guestMemGiB(this.o.home);
  }

  /** Whether session `session` runs in a box of this node's now (one booting counts). */
  holds(session: string): boolean {
    for (const dir of this.#boxes.keys()) if (dir.split("/").at(-1) === session) return true;
    return false;
  }

  /** Session `session`'s box once it is up, and what of this machine it shows. */
  boxOf(session: string): { box: Box; view?: View } | undefined {
    for (const [dir, going] of this.#boxes) {
      if (dir.split("/").at(-1) !== session) continue;
      const held = Bun.peek(going) as Held | Error | Promise<Held>;
      return held instanceof Promise || held instanceof Error ? undefined : { box: held.box, ...(held.view ? { view: held.view } : {}) };
    }
    return undefined;
  }

  /** Whether `s` runs in a box when the machine can: a task's agent. A lead or a person's own thread stays a process. */
  wants(s: PlaceFor): boolean {
    // On a machine whose own Claude sign-in can't go into a VM, only a session on a Claude account of its bot's: one
    // that would run as a plain process runs its setup commands as one too, never its setup in a VM it doesn't run in.
    if (s.role !== "worker") return false;
    const st = this.status();
    return !(st.kind === "microvm" && st.accountsOnly) || !!s.account;
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
    } catch (error) {
      // Its off switch can't be read: off, rather than on against what it may say.
      return { kind: "process", why: `node.json can't be read (${(error as Error).message}), so VMs are off until it can` };
    }
    if (off === "process") return { kind: "process", why: `turned off on this machine (node.json "sandbox": "process")`, expected: true };
    if (off !== undefined && off !== "microvm")
      return { kind: "process", why: `node.json "sandbox" is ${JSON.stringify(off)}: "process" turns VMs off and "microvm" (or no key) on, so they're off until it says which` };
    if (this.#failed && now < this.#failed.until) {
      const at = new Date(this.#failed.until).toISOString().slice(11, 16);
      const { detail } = this.#failed;
      return { kind: "process", why: `the last VM didn't start: ${this.#failed.why}; the node tries VMs again after ${at} UTC`, ...(detail ? { detail } : {}) };
    }
    if (this.o.fleetd.length !== 1) return { kind: "process", why: "this node runs fleetd from source, and a VM runs only its built binary", expected: true };
    if (/\s/u.test(this.o.fleetd[0]!)) return { kind: "process", why: `the fleetd binary's path has a space in it (${this.o.fleetd[0]})` };
    const check = (this.o.check ?? (() => canRunVms(this.o.home)))();
    if (!check.ok) return { kind: "process", why: check.why, ...(check.fix ? { fix: check.fix } : {}), ...(check.expected ? { expected: true } : {}) };
    if (!this.#tools()) {
      this.#fetchTools();
      return { kind: "process", why: "fetching the VM files (Cloud Hypervisor, the guest kernel and root image) for the first time", expected: true };
    }
    // A machine whose agents sign in to Claude with its own login has nothing a VM can be given for them: an agent on a
    // Claude account of its bot's still runs in one (each start checks its own, provision.ts forClaude), and every other
    // runs as a plain process. The machine says so, with the fix.
    const noSignIn = this.o.claudeEnv ? machineSignIn(this.o.claudeEnv()) : undefined;
    if (noSignIn) return { kind: "microvm", why: `${noSignIn}, so agents whose bot has no Claude account run as plain processes: ${SIGN_IN_HOW}.`, fix: SIGN_IN_FIX, accountsOnly: true };
    return { kind: "microvm" };
  }

  /** A box couldn't boot or reach Claude: new sessions run as plain processes for FAILED_MS, and say why (`detail`:
   * what a person looks into only when they want to, such as the VM's console). */
  failed(why: string, now = Date.now(), detail?: string): void {
    this.#failed = { until: now + FAILED_MS, why, ...(detail ? { detail } : {}) };
    this.#checked = undefined;
  }

  /** A box didn't come up for session `session`: the node's log says so, with the console's detail, and so does the
   * machine's status until VMs are tried again. */
  #noBox(what: string, session: string, error: unknown): void {
    const why = (error as Error).message;
    const detail = error instanceof BootFailed ? error.detail : undefined;
    console.warn(`${nowIso()} WARN ${what} {"sessionId":"${session}","error":${JSON.stringify(why)}${detail ? `,"detail":${JSON.stringify(detail)}` : ""}}`);
    this.failed(why, undefined, detail);
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
      fromImage: (r) => this.fromImage(s, r),
    };
  }

  /** What every command of session `s` sees read-only besides what it names: its session's files, the update hold,
   * the binary. */
  #base(s: PlaceFor): string[] {
    mkdirSync(join(this.o.home, "update"), { recursive: true });
    // The tools fleetd installed, wherever they are, so the box setup boots is the one its session starts in.
    const tools = TOOL_DIRS.map((d) => join(this.o.home, d)).filter((d) => existsSync(d));
    return [join(this.o.home, "sessions", s.sessionId), join(this.o.home, "update"), this.o.fleetd[0]!, ...tools];
  }

  /** And writable, only where its waits on the update hold mark their tool calls held (`update/held/`): the hold
   * itself stays read-only, or an agent could hold every agent of the machine. Without the marks, the node's drain
   * waits out its 10 minutes for an agent in a VM. */
  #update(): string {
    const held = heldDirOf(this.o.home);
    mkdirSync(held, { recursive: true });
    return held;
  }

  /** A command's environment in a box: git's GitHub helper, its builds' turns asked of the node over the box's link
   * (the machine's build slots, not ones of the box's own), and pnpm's store in its checkout (boxStore). */
  async #inBox<E extends Record<string, string | undefined>>(env: E, cwd: string): Promise<E & Record<string, string>> {
    const out = { ...gitInBox(env), [SLOT_SOCK_VAR]: slotSock(this.o.home) } as Record<string, string | undefined>;
    const store = await boxStore(cwd);
    if (store) out.pnpm_config_store_dir ??= store;
    return out as E & Record<string, string>;
  }

  /** What session `s`'s command with `env` in `cwd` is given in its box (./provision.ts), its copies kept fresh. */
  #provision(s: PlaceFor, cwd: string, env: Record<string, string | undefined>): Provisioned {
    const p = provision({ node: this.o.home, session: s.sessionId, cwd, env });
    this.#refresh.set(s.dir, p.refresh);
    return p;
  }

  async run(s: PlaceFor, r: ConfinedRun): Promise<RunOutcome> {
    if (this.status().kind !== "microvm") return processPlace.run(r);
    let held: Held;
    let p: Provisioned;
    try {
      p = this.#provision(s, r.cwd, r.env ?? {});
      held = await this.#box(s, needs({ cwd: r.cwd, env: p.env, argv: r.argv, node: this.o.home, session: s.sessionId, rw: [this.#update(), ...p.rw], ro: [...this.#base(s), ...p.ro] }), undefined, true);
    } catch (error) {
      this.#noBox("no VM for a setup command: it runs as a plain process", s.sessionId, error);
      return processPlace.run(r);
    }
    return held.box.run({ ...r, env: await this.#inBox(p.env, r.cwd) });
  }

  /** Where this machine's bot images are built and kept (./image.ts), while its agents run in VMs. */
  backend(): Backend | undefined {
    if (this.status().kind !== "microvm") return undefined;
    return {
      where: "vm",
      base: IMAGE.key,
      build: (j) => this.buildImage(j),
      drop: async (ref) => void rmSync(ref, { force: true }),
    };
  }

  /**
   * A bot's image: a box over the bare root image, with a new disk of its own, runs the setup commands in a worktree of
   * the bot's base (shared in, so the checkout isn't in the image), as a session would but with none of a session's
   * own (no Claude, no order). Then, as root in the box, its disk is checked for the values of the bot's secrets and
   * stripped of what's the box's alone (its /run and /tmp, shell history), and frozen, which leaves it whole on this
   * machine's disk for the box's end. That disk is the image.
   */
  async buildImage(j: Job): Promise<Built> {
    const file = join(imagesDir(this.o.home), `${j.project}-${j.key.slice(0, 12)}.img`);
    const part = `${file}.part`;
    rmSync(part, { force: true });
    newDisk(part);
    const session = `image-${j.project}`;
    // Under the node's hosts dir, as a session's box: no session records it, so a node that stops mid-build has its
    // next one end it at its start (runner/host.ts sweep, ./box_record.ts reapLeaked), and a node's shutdown ends it.
    const s: PlaceFor = { sessionId: session, dir: join(this.o.home, "hosts", session), role: "worker", disk: part };
    mkdirSync(s.dir, { recursive: true, mode: 0o700 });
    this.#building.add(s.dir);
    let worktree = false;
    let built = false;
    try {
      const p = provision({ node: this.o.home, session, cwd: j.cwd, env: j.env });
      const need = needs({ cwd: j.cwd, env: p.env, argv: ["sh"], node: this.o.home, session, rw: p.rw, ro: [this.o.fleetd[0]!, ...p.ro] });
      const held = await this.#box(s, need);
      const env = await this.#inBox(p.env, j.cwd);
      for (const command of j.setup.commands ?? []) {
        j.log(`$ ${command}`);
        const at = Date.now();
        const out = await held.box.run({ cwd: j.cwd, argv: ["sh", "-c", command], timeoutSec: SETUP_TIMEOUT_SEC, env, scrub: j.secrets });
        j.log(out.notRun ?? out.outputTail);
        const ran: Ran = { command, exitCode: out.exitCode, outputTail: out.outputTail, timedOut: out.timedOut, tookMs: Date.now() - at };
        if (out.notRun || out.exitCode !== 0) throw new Error(`\`${command}\` ${out.notRun ?? how(ran, SETUP_TIMEOUT_SEC)}`);
      }
      // What setup left in the checkout (node_modules, say) isn't in the image: its sessions run setup again over it.
      const st = await held.box.run({ cwd: j.cwd, argv: ["git", "status", "--porcelain", "--ignored", "--untracked-files=normal"], timeoutSec: 60, env });
      worktree = st.exitCode !== 0 || st.outputTail.trim() !== "";
      const sealed = await (this.o.seal ?? ((box, script, scrub) => box.run({ root: true, cwd: "/", argv: ["/bin/bash", "-c", script], timeoutSec: SETUP_TIMEOUT_SEC, scrub, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", FLEETD_SECRETS: scrub.join("\n") } })))(held.box, sealScript(BOX_HOME), j.secrets.filter((v) => v.length >= 8));
      if (sealed.exitCode === 3) throw new Error(`setup wrote the value of one of the bot's secret variables into ${sealed.outputTail.trim().split("\n").join(", ")}: an image never holds one, so write it where the session starts instead (an environment variable)`);
      if (sealed.notRun || sealed.exitCode !== 0) throw new Error(`the image's disk couldn't be sealed: ${sealed.notRun ?? sealed.outputTail.trim().slice(-500)}`);
      built = true;
    } finally {
      await this.#drop(s.dir);
      this.#building.delete(s.dir);
      unprovision(this.o.home, session);
      rmSync(s.dir, { recursive: true, force: true });
      // A failed build's disk holds what its setup installed: it goes with it.
      if (!built) rmSync(part, { force: true });
    }
    renameSync(part, file);
    chmodSync(file, 0o444);
    return { ref: file, bytes: statSync(file).blocks * 512, worktree };
  }

  /** Whether session `s`'s box, booted for it now, runs over its bot's image: the guest's init says so (IMAGE_MARKER).
   * No VM (VMs off, or one that didn't boot) or an image that didn't mount: no. */
  async fromImage(s: PlaceFor, r: { cwd: string; env: Record<string, string | undefined> }): Promise<boolean> {
    if (this.status().kind !== "microvm") return false;
    try {
      const p = this.#provision(s, r.cwd, r.env);
      const argv = ["test", "-e", this.o.imageMarker ?? IMAGE_MARKER];
      const held = await this.#box(s, needs({ cwd: r.cwd, env: p.env, argv, node: this.o.home, session: s.sessionId, rw: [this.#update(), ...p.rw], ro: [...this.#base(s), ...p.ro] }), undefined, true);
      const out = await held.box.run({ cwd: r.cwd, argv, timeoutSec: 30, env: await this.#inBox(p.env, r.cwd) });
      return out.exitCode === 0;
    } catch {
      return false;
    }
  }

  async start(s: PlaceFor, l: Launch): Promise<HostLink> {
    const status = this.status();
    if (status.kind !== "microvm") {
      await this.#drop(l.dir);
      return processPlace.start(l);
    }
    // What the box is given: its own home and caches, its order's variables, claude, Claude's settings, its transcript.
    // Nothing signs the box's claude in (the machine's own Claude login, which never leaves it): a plain process, and
    // why, for this session alone.
    let p: Provisioned;
    let claude: ReturnType<typeof forClaude>;
    try {
      p = this.#provision(s, l.cwd, l.env);
      claude = forClaude({ node: this.o.home, session: s.sessionId, cwd: l.cwd, env: l.env, program: l.program, boxEnv: p.env });
    } catch (error) {
      const why = (error as Error).message;
      console.warn(`${nowIso()} WARN the session runs as a plain process, not in a VM: ${why} {"sessionId":"${s.sessionId}"}`);
      if (!(error instanceof NoClaudeLogin)) this.failed(why);
      await this.#drop(l.dir);
      return processPlace.start(l);
    }
    // The repo's main checkout (claude's --add-dir) isn't the box's: only its worktree and git store are.
    const args = withoutAddDirs(l.args);
    const need = needs({ cwd: l.cwd, env: p.env, argv: [claude.program, ...args], node: this.o.home, session: s.sessionId, rw: [this.#update(), ...p.rw], ro: [...this.#base(s), ...p.ro, ...claude.ro] });
    let held: Held;
    try {
      held = await this.#box(s, need, l.scope);
    } catch (error) {
      this.#noBox("no VM for the session: it runs as a plain process", s.sessionId, error);
      await this.#drop(l.dir);
      return processPlace.start(l);
    }
    // Claude, whatever its endpoint, through the node, checked from inside the box: a box that can't reach it runs
    // nothing, and the agent runs as a plain process instead of stalling on every call.
    // As this machine's claude picks it: the box's picks the same, from the Claude variables it was given (forClaude).
    const endpoint = claudeEndpoint(l, true);
    let boxArgv: string[];
    try {
      // The guest helper is root: the relay takes the endpoint's own port, and claude calls the URL as set.
      const r = reachOf(endpoint.url);
      await (this.o.reach ?? reach)(held.box, r);
      held.record.relays = held.box.relays;
      writeFileSync(boxFile(l.dir), JSON.stringify(held.record));
      // The guest's word that it ran out of memory reaches the agent at its next tool call, not a bare "Killed".
      boxArgv = withPostToolHook(args, OOM_HOOK);
    } catch (error) {
      const why = `${(error as Error).message} (the endpoint from ${endpoint.source})`;
      console.warn(`${nowIso()} WARN a VM couldn't reach Claude: the session runs as a plain process {"sessionId":"${s.sessionId}","error":${JSON.stringify(why)}}`);
      // The machine's own endpoint (its environment, its user's settings) fails every agent's VM alike; one a project's
      // own settings name, only that project's.
      if (!fromProject(endpoint, l.cwd)) this.failed(why);
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
      // The guest runs the agent as this machine's user, but as root when that is root (a node run as root), which
      // claude refuses to skip its prompts for unless it knows it's in a sandbox.
      if (claude.transcript) {
        held.record.transcript = claude.transcript;
        writeFileSync(boxFile(l.dir), JSON.stringify(held.record));
      }
      const env = { ...(await this.#inBox(p.env, l.cwd)), IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1" };
      const info = await held.box.start({ sessionId: l.sessionId, program: claude.program, args: boxArgv, cwd: l.cwd, env });
      const leader = held.record.leader;
      const registration: Registration = { protocol: info.protocol, hostPid: leader.pid, hostStart: leader.start, pid: leader.pid, start: leader.start, marker: "", refused: info.refused ?? null };
      writeFileSync(join(l.dir, "host.json"), JSON.stringify(registration));
      if (info.refused) throw new LaunchError(info.refused.message, info.refused);
      return await HostLink.connect(l.dir, { dial: (h) => held.box.dialHost(withTranscriptBack(h, claude.transcript)), registration });
    } catch (error) {
      await this.stop(l.dir);
      if (error instanceof LaunchError) throw error;
      throw new LaunchError(`no host came up in the VM: ${(error as Error).message}`);
    }
  }

  /** The session's box: the one booted for it when it shows `need` and runs no host yet, else a new one. A setup
   * command (`run`) takes the box a live session host runs in as it is, even one that shows less than it needs: a new
   * box would end that session. */
  #box(s: PlaceFor, need: Share[], scope?: Scope, run = false): Promise<Held> {
    const going = this.#boxes.get(s.dir);
    const next = (async () => {
      const held = await going?.catch(() => undefined);
      const alive = held?.view !== undefined && boxAlive(held.record);
      const hosting = !!readRegistration(s.dir);
      if (alive && covers(held!.view!, need) && (run || !hosting)) return held!;
      if (alive && run && hosting) {
        console.warn(`${nowIso()} WARN a setup command runs in its session's VM, which doesn't show every path it names {"sessionId":"${s.sessionId}"}`);
        return held!;
      }
      // A new box shows what the last one did and what this needs, and nothing else.
      const view = viewOf([...(held?.view?.home === undefined ? (held?.view?.shares ?? []) : []), ...need]);
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
    // Its own disk, kept between its boxes; over its bot's image when it started from one (./image.ts use).
    const disk = s.disk ?? sessionDisk(this.o.home, s.sessionId);
    newDisk(disk);
    const layer = s.disk ? undefined : sessionLayer(this.o.home, s.sessionId);
    const plan: BootPlan = {
      dir: s.dir,
      sessionId: s.sessionId,
      view,
      port: GUEST_PORT,
      exe: this.o.fleetd[0]!,
      tools,
      check,
      blocked,
      memGiB: s.size?.memGb ?? this.memGiB(),
      ...(s.size ? { cpus: s.size.cpu } : {}),
      home: BOX_HOME,
      disk,
      ...(layer && existsSync(layer) ? { layer } : {}),
      ...(scope ? { scope } : {}),
    };
    const booted = await (this.o.boot ?? bootCloudHypervisor)(plan);
    const record: BoxRecord = {
      kind: "microvm",
      leader: booted.leader,
      helpers: booted.helpers,
      tcp: [],
      port: GUEST_PORT,
      view,
      ...(booted.fs ? { fs: booted.fs } : {}),
      ...(booted.net ? { net: booted.net, blocked } : {}),
    };
    writeFileSync(boxFile(s.dir), JSON.stringify(record));
    try {
      const box = await this.#open(s.dir, s.sessionId, record, at + BOOT_MS);
      console.log(`${nowIso()} INFO a VM is up for the session {"sessionId":"${s.sessionId}","ms":${Date.now() - at},"pid":${record.leader.pid}}`);
      return { box, view, record };
    } catch (error) {
      await destroyBox(s.dir);
      throw bootFailure((error as Error).message, consoleOf(s.dir));
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
          // A box whose VMM ended ends its link at once; one whose guest stopped answering goes, and says so.
          alive: () => boxAlive(record),
          hung: (why) => void this.#hung(dir, session, why),
          clock: true,
        });
      } catch (error) {
        last = (error as Error).message;
      }
      if (Date.now() >= until) throw new Error(`the VM's guest didn't answer within ${BOOT_MS / 1000} s: ${last}`);
      await Bun.sleep(DIAL_EVERY_MS);
    }
  }

  /** A box whose guest stopped answering (frozen, or its kernel panicked): it's destroyed, and its session's host link
   * ends with it, as when a VM ends. */
  async #hung(dir: string, session: string, why: string): Promise<void> {
    console.warn(`${nowIso()} WARN a VM stopped answering: it was ended, and its agent's next turn starts a new one {"sessionId":"${session}","why":${JSON.stringify(why)}}`);
    await this.#drop(dir);
  }

  /** After a node restart: dials the box `dir` recorded again and links to the session host in it. */
  async adopt(dir: string): Promise<HostLink | undefined> {
    const record = readBox(dir);
    const registration = readRegistration(dir);
    const session = dir.split("/").at(-1)!;
    // A box that ended while no node ran: its transcript comes back for the next start.
    const done = () => (transcriptBack(record?.transcript), undefined);
    if (!record || !registration || !boxAlive(record)) return done();
    let box: Box;
    try {
      box = await this.#open(dir, session, record, Date.now() + 5_000);
    } catch {
      return done();
    }
    try {
      const link = await HostLink.connect(dir, { dial: (h) => box.dialHost(withTranscriptBack(h, record.transcript)), registration });
      this.#boxes.set(dir, Promise.resolve({ box, view: record.view, record }));
      return link;
    } catch {
      box.close();
      return done();
    }
  }

  /** Lets go of the box's link and destroys it, with whatever ran in it. */
  async #drop(dir: string): Promise<number> {
    const held = await this.#boxes.get(dir)?.catch(() => undefined);
    this.#boxes.delete(dir);
    this.#shares.delete(dir);
    this.#refresh.delete(dir);
    const transcript = (held?.record ?? readBox(dir))?.transcript;
    const ended = await destroyBox(dir);
    held?.box.close();
    transcriptBack(transcript);
    return ended;
  }

  async stop(dir: string): Promise<void> {
    await this.#drop(dir);
    await stopHost(dir);
  }

  /** The task ended: its box goes, with everything its turns left running in it, and so does its dir, which holds only
   * what the box left (its dead sockets, its console log): the next start makes it afresh. */
  async end(dir: string): Promise<number> {
    const ended = (await this.#drop(dir)) + (await processPlace.end(dir));
    rmSync(dir, { recursive: true, force: true });
    unprovision(this.o.home, dir.split("/").at(-1)!);
    return ended;
  }

  /** Lets go of every box's link (the node's shutdown): the boxes and their sessions go on for the next node. An image
   * build's box ends: nothing would come back for it. */
  close(): void {
    clearInterval(this.#watch);
    clearInterval(this.#shareWatch);
    for (const dir of this.#building) void destroyBox(dir);
    this.#building.clear();
    for (const held of this.#boxes.values()) void held.then((h) => h.box.close(), () => {});
    this.#boxes.clear();
  }
}

/**
 * Run as root in an image build's box, its disk the root's writable layer at /run/fleetd/rw (sandbox/image/init.sh):
 * what is the box's alone goes (its /run and /tmp, the home's shell history and Claude dir), and the disk is searched for
 * each value `FLEETD_SECRETS` holds (one a line): one found exits 3, naming the files. Then the disk is frozen: its
 * journal is written out and it is clean when the box is ended.
 */
export function sealScript(home: string): string {
  const up = "/run/fleetd/rw/up";
  return [
    "set -e",
    `up=${up}`,
    `rm -rf "$up/run" "$up/tmp" "$up${home}/.bash_history" "$up${home}/.claude" "$up/root/.bash_history"`,
    'if [ -n "$FLEETD_SECRETS" ]; then',
    '  printf "%s\\n" "$FLEETD_SECRETS" > /dev/shm/.fleetd-secrets',
    '  hits=$(grep -rlFa -f /dev/shm/.fleetd-secrets "$up" 2>/dev/null | head -5 | sed "s|^$up||" || true)',
    "  rm -f /dev/shm/.fleetd-secrets",
    '  if [ -n "$hits" ]; then echo "$hits"; exit 3; fi',
    "fi",
    "sync",
    "fsfreeze -f /run/fleetd/rw",
  ].join("\n");
}

const same = (a: string[] | undefined, b: string[]) => a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

function toolsOrThrow(): NetTools {
  const net = netTools();
  if ("missing" in net) throw new Error(`this machine has no ${net.missing}`);
  return net;
}

/** A heartbeat's word on where this machine's agents run: in VMs of `memGiB` each (memPerAgentBytes, for the hub's cap),
 * or as plain processes and why. */
export function reportVm(load: Pick<NodeLoad, "sandbox" | "memPerAgentBytes">, status: VmStatus, memGiB = GUEST_MEM_GIB): void {
  load.sandbox =
    status.kind === "microvm"
      ? { kind: "microvm", ...(status.why ? { why: status.why } : {}), ...(status.fix ? { fix: status.fix } : {}), ...(status.accountsOnly ? { accountsOnly: true } : {}) }
      : status;
  if (status.kind === "microvm") load.memPerAgentBytes = memPerAgentBytes(memGiB);
}

/**
 * `env` with git's GitHub credentials from the box's own `gh`, by name. Added as the command's own config
 * (GIT_CONFIG_*, after any it has), which git reads last: an empty helper drops the ones before it (a repo's own config
 * may name a gh by this machine's path), then gh answers with the order's GH_TOKEN. The machine's gh login never
 * reaches a box.
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

/** Where a box's pnpm store goes in its checkout, kept out of git (the checkout's .git/info/exclude). */
export const BOX_STORE = ".fleetd/pnpm-store/";

/**
 * A box's pnpm store, `<checkout>/.fleetd/pnpm-store`, when its cwd is a git checkout. pnpm's store in the home is a
 * SQLite index (WAL, its -shm mapped), and file locks don't cross a VM's share: two VMs, or a VM and a plain process,
 * would write it at once. And pnpm links from its store, which it can't across shares: given the home's, it made a
 * store of its own at the checkout's root, where git saw it. This one is on the checkout's share and out of git; it
 * costs a download of the packages once a checkout (seconds), and goes with it.
 */
export async function boxStore(cwd: string): Promise<string | undefined> {
  if (!existsSync(join(cwd, ".git"))) return undefined;
  if (!(await excludeInCheckout(cwd, BOX_STORE))) return undefined;
  return join(cwd, BOX_STORE);
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

/** claude's argv without its `--add-dir`s (the repo's main checkout, which a box doesn't show). */
export const withoutAddDirs = (args: string[]): string[] => args.filter((a, i) => a !== "--add-dir" && args[i - 1] !== "--add-dir");

/** The session host's link handlers, with the box's transcript coming back here once the link closes (its claude idled
 * out, or the box went): the next start resumes from it, in a box or not. */
function withTranscriptBack<H extends { close: () => void }>(h: H, t: Transcript | undefined): H {
  return t ? { ...h, close: () => (h.close(), transcriptBack(t)) } : h;
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

/** This machine's user's name, which the agent's user has in the guest too. */
const userName = () => {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
};

/** This machine's user, which the guest runs the agent as. */
const ids = () => ({ uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });

/** The VM's console, for why it didn't come up. */
function consoleOf(dir: string): string {
  try {
    return readFileSync(join(dir, "console.log"), "utf8");
  } catch {
    return "";
  }
}

/** A box that didn't come up: why in plain words, and `detail`, what its console said, for whoever looks into it. */
export class BootFailed extends Error {
  constructor(
    why: string,
    readonly detail: string,
  ) {
    super(why);
  }
}

/** The lines of a VM's console kept in a failed boot's detail. */
const DETAIL_LINES = 12;

/**
 * Why a box didn't come up (`error`, the dial's word), in plain words, with its console behind it: the guest's own last
 * error line (sandbox-guest's or its init's) first, then the console's last lines. The words never quote the console.
 */
export function bootFailure(error: string, console: string): BootFailed {
  const lines = console.replaceAll("\r", "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const ended = lines.some((l) => /^fleetd-init: sandbox-guest ended \(/u.test(l));
  const own = lines.filter((l) => / (?:WARN|ERROR) sandbox-guest: /u.test(l) || (/^fleetd-init: /u.test(l) && !/^fleetd-init: sandbox-guest ended \(/u.test(l))).at(-1);
  const why = ended
    ? "fleetd's helper in it stopped right after the VM booted"
    : own
      ? "the VM stopped while it was being set up"
      : error.startsWith("the VM ended before its guest answered")
        ? "the VM stopped right after it booted"
        : error;
  // The guest's own line leads, and isn't repeated among the console's last lines.
  const detail = [...(own ? [own] : []), ...(why === error ? [] : [error]), ...lines.filter((l) => l !== own).slice(-DETAIL_LINES)].join("\n");
  return new BootFailed(why, detail);
}

/** The kernel's command line: the read-only root, fleetd's init and what it reads (sandbox/image/init.sh), and the
 * user the guest runs the agent as (this machine's user's ids and name, with the box's own home: sandbox-guest's
 * FLEETD_GUEST_UID, _GID, _USER and _HOME). */
export function kernelCmdline(p: { exe: string; port: number; dns: string[]; now: number; uid?: number; gid?: number; user?: string; home?: string; like?: HostLike; memGiB?: number; disk?: boolean; layer?: boolean }): string {
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
    ...(p.uid !== undefined && p.gid !== undefined ? [`fleetd.uid=${p.uid}`, `fleetd.gid=${p.gid}`] : []),
    ...(p.user && /^[a-z_][a-z0-9_-]{0,31}$/u.test(p.user) ? [`fleetd.user=${p.user}`] : []),
    ...(p.home && !/\s/u.test(p.home) ? [`fleetd.home=${p.home}`] : []),
    ...(p.like ? [`fleetd.umask=${p.like.umask}`, `fleetd.watches=${p.like.watches}`, `fleetd.instances=${p.like.instances}`] : []),
    ...(p.memGiB ? [`fleetd.mem=${p.memGiB}`] : []),
    // The box's own disk is the root's writable layer, over its bot's image when it has one (sandbox/image/init.sh).
    ...(p.disk ? ["fleetd.upper=/dev/vdb"] : []),
    ...(p.disk && p.layer ? ["fleetd.layer=/dev/vdc"] : []),
  ].join(" ");
}

/** What the guest takes from this machine so its agent works as a plain process here does: the node's umask (files
 * group-writable or not), and inotify's limits (a kernel sized for the guest's 4 GiB allows 35k watches, which a dev
 * server and a test watcher over a large repo outrun). */
export type HostLike = { umask: string; watches: number; instances: number };

export function hostLike(): HostLike {
  const sys = (name: string, fallback: number) => {
    try {
      const n = Number(readFileSync(`/proc/sys/fs/inotify/${name}`, "utf8").trim());
      return Number.isInteger(n) && n > 0 ? n : fallback;
    } catch {
      return fallback;
    }
  };
  return { umask: process.umask().toString(8).padStart(4, "0"), watches: sys("max_user_watches", 1_048_576), instances: sys("max_user_instances", 1024) };
}

/** The flags pasta (passt's binary under that name) links a box's network namespace to this machine's network with:
 * no ports in either way (`-t`/`-u` into it, `-T`/`-U` out of it to this machine's loopback), no gateway address
 * that means this machine, and no DNS of its own (NO_DNS). */
export const PASTA_FLAGS = ["-q", "-f", "--config-net", "-t", "none", "-u", "none", "-T", "none", "-U", "none", "--no-map-gw"];

/** pasta and passt give out no nameserver or search list: the guest's resolv.conf comes from the kernel line
 * (`fleetd.dns=`), and on a machine whose resolv.conf names only a local stub they'd warn at every start that they
 * found none. */
const NO_DNS = ["-D", "none", "-S", "none"];

/** The launcher's script, run in the box's host dir: passt and virtiofsd in the background, then the VMM once they
 * listen, each with the box's sockets by name in that dir (SOCKS); it ends with the VMM, and its helpers with it. passt
 * runs in a network namespace of its own, which pasta links to this machine's network, behind a shell that first routes
 * this machine's own addresses (`blocks`, ./net.ts) nowhere. virtiofsd serves the view (`view`), the box's one share.
 * Their pids go to `pids` as `<vmm> <pasta> <virtiofsd>`. */
export function launcherScript(b: BootPlan, now: number): string {
  const { dir, tools, check, view } = b;
  const viewDir = join(dir, "view");
  // In the namespace it runs in, this machine's user is root: its files are the guest's agent's (its user, at the same
  // ids, kernelCmdline), and the guest's root's are this machine's user's too.
  const { uid, gid } = ids();
  const virtiofsd = [
    tools.virtiofsd,
    `--socket-path=${SOCKS.fs}`,
    `--shared-dir=${viewDir}`,
    "--sandbox=namespace",
    "--announce-submounts",
    "--cache=auto",
    `--translate-uid=map:${uid}:0:1`,
    `--translate-gid=map:${gid}:0:1`,
    "--log-level=error",
  ];
  const passt = [tools.passt, "--vhost-user", "--socket", SOCKS.net, "--foreground", "--one-off", "--quiet", "--no-map-gw", "-a", GUEST_ADDR, "-n", "24", "-g", GUEST_GW, "-t", "none", "-u", "none", ...NO_DNS];
  // The shell stays, holding the namespace for the node's later route changes (nsenter), and ends with passt.
  const inNamespace = [`cd ${q(dir)} || exit 1`, blockScript(check.net.ip, join(dir, "blocks")), `${passt.map(q).join(" ")} &`, "wait $!"].join("\n");
  const pasta = `(exec -a pasta ${[tools.passt, ...PASTA_FLAGS, ...NO_DNS, "--", "/bin/sh", "-c", inNamespace].map(q).join(" ")})`;
  const vmm = [
    tools.cloudHypervisor,
    "--api-socket",
    `path=${SOCKS.api}`,
    "--kernel",
    tools.kernel,
    "--cmdline",
    kernelCmdline({ exe: b.exe, port: b.port, dns: check.dns, now, uid, gid, user: userName(), ...(b.home ? { home: b.home } : {}), like: hostLike(), memGiB: b.memGiB ?? GUEST_MEM_GIB, disk: !!b.disk, layer: !!b.layer }),
    "--disk",
    `path=${tools.root},readonly=on,image_type=raw`,
    ...(b.disk ? [`path=${b.disk},image_type=raw`] : []),
    ...(b.disk && b.layer ? [`path=${b.layer},readonly=on,image_type=raw`] : []),
    "--cpus",
    `boot=${b.cpus ?? GUEST_CPUS}`,
    "--memory",
    `size=${(b.memGiB ?? GUEST_MEM_GIB) * 1024}M,shared=on`,
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
    `unshare --user --map-root-user --mount --propagation private -- /bin/bash -c ${q(views)} 2>>box.log &`,
    "v=$!",
    "i=0",
    'until [ -S net.sock ] && [ -S fs.sock ]; do i=$((i+1)); if [ $i -gt 1000 ] || ! kill -0 $p $v 2>/dev/null; then echo "passt or virtiofsd didn\'t start" >>box.log; kill $p $v 2>/dev/null; exit 1; fi; sleep 0.01; done',
    `${vmmLine} 2>>box.log &`,
    "c=$!",
    'echo "$c $p $v" > pids',
    // The box ends with the first of them to: a VM whose files or network went (its virtiofsd or passt killed, by the
    // OOM killer say) would otherwise hang on every file, or lose the network without a word.
    "wait -n $c $p $v",
    "s=$?",
    'if kill -0 $c 2>/dev/null; then echo "the VM ended because one of its helpers did (virtiofsd or passt)" >>box.log; fi',
    "kill $c $p $v 2>/dev/null",
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
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: "C.UTF-8", [BOX_MARKER]: b.dir, ...scope?.env },
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
      const fs = pids.length === 3 ? pids[2] : undefined;
      return { leader, helpers: net ? [...pids, net] : pids, ...(fs ? { fs } : {}), ...(net ? { net } : {}) };
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

/** How many files `pid` holds open: its fd dir's size (Linux 6.2 and later), else its entries. */
export function openFds(pid: number): number {
  const fd = `/proc/${pid}/fd`;
  const size = statSync(fd).size;
  return size > 0 ? size : readdirSync(fd).length;
}

/** `pid`'s limit on open files, from its own limits. */
export function fdLimit(pid: number): number | undefined {
  const line = readFileSync(`/proc/${pid}/limits`, "utf8")
    .split("\n")
    .find((l) => l.startsWith("Max open files"));
  const soft = Number(line?.slice("Max open files".length).trim().split(/\s+/u)[0]);
  return Number.isFinite(soft) && soft > 0 ? soft : undefined;
}

/** The files the box's share holds open and its limit: of its virtiofsd process nearest its own limit (one serves the
 * view and one this machine's system dirs, each from a child in a sandbox of its own). The processes are found once,
 * and again only when one has gone, and kept in `w`. */
function shareFds(r: BoxRecord, w: ShareWatch): ShareFds | undefined {
  if (!r.fs || !liveProc(r.fs)) return undefined;
  try {
    if (!w.procs?.length || !w.procs.every((p) => liveProc(p))) {
      const procs = table();
      w.procs = [r.fs, ...descendants(procs, r.fs.pid).flatMap((p) => (p.start === undefined ? [] : [{ pid: p.pid, start: p.start }]))];
    }
    let worst: ShareFds | undefined;
    for (const p of w.procs) {
      const limit = fdLimit(p.pid);
      if (!limit) continue;
      const open = openFds(p.pid);
      if (!worst || open / limit > worst.open / worst.limit) worst = { open, limit };
    }
    return worst;
  } catch {
    return undefined;
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
