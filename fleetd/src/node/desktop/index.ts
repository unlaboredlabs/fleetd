// Linux desktop sessions (W46): an agent opens one with `session_start` kind
// linux_desktop. The node lends it an X display of its own from a warm pool (display.ts): a fresh container of the
// pinned image where the node has docker or podman (container.ts), else an Xvfb with a fresh home directory. The agent
// drives it with its `desktop` tool (Anthropic's computer-use actions, plus `launch`), which the node does itself over
// its own X11 connection (x11.ts): it reads the screen and types and clicks through XTEST, so nothing but the session's
// apps and the node reach the display. `session_end` throws the display away with everything on it.
//
// The session shares the browser sessions' live view and takeover: the hub's `browser_watch`, `browser_input` and
// `browser_control` for a desktop's id come here, every other id to the broker. node/device's router sends each
// session call to the kind it is for (`router(node).desktops`).
//
// The agents' Mac's own screen is a session here too (`session_start` kind mac, desktop/mac/): on the screen the Mac's
// node runs in rather than a display of its own, shared by several sessions at once: one claim per app for
// agent-desktop's headless commands, and a lease, one holder at a time, for real pointer and key input.
//
// A hosted agent's desktop runs in its own box; what drives, records and watches it is the node-free core this class
// extends (desktops.ts), which a service with no node runs as well. This class gives it the node's host (the link,
// the sessions' secrets, the hosted boxes, recordings on this disk) and adds this machine's displays and the Mac.
//
// Each session is recorded as a browser session is (session.ts, disk_recordings.ts): its video, where an ffmpeg
// is installed, and its action log, scrubbed of its agent session's secrets (for a session hosted here for an agent
// elsewhere, the ones its node sealed to this one). Once it ends the recording goes to the hub, tried again each
// minute until it does, with any a Rust node left here, iOS screens' included.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCheck } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserCallFrame, BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame } from "../../shared/screens_wire.ts";
import type { SessionsArea } from "../api.ts";
import { hubCall, type Node, toHub } from "../browser/node.ts";
import { findFfmpeg, Steps } from "../browser/record.ts";
import { installDir as browserInstallDir } from "../browser/chrome.ts";
import { ensureFfmpeg, sdkAt } from "../device/sdk.ts";
import { router, type Screens } from "../device/router.ts";
import { router as sessionRoute } from "../session_route/index.ts";
import { homeDir } from "../util.ts";
import { image as pinnedImage, Runtime } from "./container.ts";
import { type Backend, clearLeftovers, Pool, type Settings } from "./display.ts";
import { onPath } from "./paths.ts";
import { install as installAgentDesktop, macDir } from "./mac/agent_desktop.ts";
import { type App, type Blocked, blocked as macBlocked, IDLE_MINUTES as MAC_IDLE_MINUTES, MacLent, type MacConfig, macEnabled, needs as macNeeds } from "./mac/index.ts";
import { MacScreen } from "./mac/screen.ts";
import type { Screen } from "./screen.ts";
import { type DesktopCall, Session } from "./session.ts";
import { DesktopSessions, IDLE_MINUTES } from "./desktops.ts";
import { DiskDesktopRecordings } from "./disk_recordings.ts";
import { hasBox, hostedBox } from "../place/hosted.ts";
import { BOX_NO_DESKTOP_LAUNCH, inBox as agentInBox } from "../place/index.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { liveEncoder } from "../screen/x264.ts";

/** The capability a node lists at its hello once desktop sessions can run (node_link.rs `CAP_SESSION_DESKTOP`). */
export const CAP_SESSION_DESKTOP = "session_linux_desktop";

/** node.json's `desktop`: how this machine runs Linux desktop sessions. Every field is optional. */
export type DesktopConfig = {
  /** The node's own word, never node.json's (an older one's `enabled` is ignored): false where this machine lends no
   * Linux desktop (the agents' Mac, the hub's runner, a test's). Absent: on, prepared when an agent first asks. */
  enabled?: boolean;
  /** `container` or `xvfb` only. Absent: a container where docker or podman works, else Xvfb. */
  backend?: Backend;
  /** The docker or podman to use instead of the one on the PATH: `FLEETD_DESKTOP_RUNTIME`, for development. */
  runtime?: string;
  /** An image to run instead of building the pinned one: `FLEETD_DESKTOP_IMAGE`, for development. */
  image?: string;
  /** The Xvfb to use instead of the one on the PATH: `FLEETD_XVFB`, for development. */
  xvfb?: string;
  /** An ffmpeg to encode the video with (matroska and mjpeg in, libvpx-vp9 out): `FLEETD_FFMPEG`, for development. */
  ffmpeg?: string;
  /** Displays kept started for the next sessions: 1, and 0 in tests that start none. */
  pool?: number;
  /** Where X servers put their sockets and locks, and the window managers looked for: a test's own, never the
   * host's. */
  x11Dir?: string;
  lockDir?: string;
  windowManagers?: string[];
};

/** On unless the node turns them off; Linux only (a container's X socket can't cross into macOS). */
export const enabled = (config: DesktopConfig) => config.enabled !== false && process.platform === "linux";

const devOverride = (name: string) => process.env[name] || undefined;

/** The node's desktop config as it runs it: node.json's section and the development overrides (config.rs
 * `desktop_screen`). The agents' Mac hosts its own screen, never a Linux desktop. */
export function desktopConfig(node: Node): DesktopConfig {
  const { enabled: _, ...section } = (node.config.desktop ?? {}) as DesktopConfig;
  const config: DesktopConfig = { ...section };
  for (const [key, env] of [["runtime", "FLEETD_DESKTOP_RUNTIME"], ["image", "FLEETD_DESKTOP_IMAGE"], ["xvfb", "FLEETD_XVFB"], ["ffmpeg", "FLEETD_FFMPEG"]] as const) {
    const v = devOverride(env);
    if (v) config[key] = v;
  }
  // The hub's runner lends no display of its machine's: its agents' desktops run in their boxes.
  if (node.config.agentsMac === true || node.config.runner === true) config.enabled = false;
  return config;
}

export type DesktopHealth = { state: "ready" | "preparing" | "unavailable"; backend?: Backend; message: string; fix?: string };

const health = (state: DesktopHealth["state"], backend: Backend | undefined, message: string, fix?: string): DesktopHealth => ({
  state,
  ...(backend ? { backend } : {}),
  message: message.slice(0, 500),
  ...(fix ? { fix: fix.slice(0, 500) } : {}),
});

export const desktopDir = (home: string) => join(home, "desktop");
/** Where the node keeps desktop recordings until the hub has them. */
export const recordingsDir = (home: string) => join(desktopDir(home), "recordings");
const statePath = (home: string) => join(desktopDir(home), "state.json");

/** The fix a person runs on a machine with neither docker nor Xvfb that works: Xvfb, with its package manager. */
export function installFix(): string {
  const byManager: [string, string][] = [
    ["apt-get", "sudo apt-get install -y xvfb"],
    ["dnf", "sudo dnf install -y xorg-x11-server-Xvfb"],
    ["pacman", "sudo pacman -S --needed xorg-server-xvfb"],
  ];
  return (byManager.find(([m]) => onPath(m)) ?? byManager[0]!)[1];
}

/** What the node found, before it prepares anything: a usable runtime is checked only when it prepares. */
function choose(config: DesktopConfig, home: string): { runtime?: Runtime; xvfb?: string } {
  const runtime = config.backend === "xvfb" ? undefined : Runtime.find(config.runtime, home);
  const xvfb = config.backend === "container" ? undefined : (config.xvfb ?? onPath("Xvfb"));
  return { ...(runtime ? { runtime } : {}), ...(xvfb ? { xvfb } : {}) };
}

/** How long the node trusts its last `docker info` (or podman's). */
const RUNTIME_CHECK_FRESH = 300_000;
let lastRuntimeCheck: { at: number; bin: string; why: string | undefined } | undefined;

/** Whether the container runtime answers (undefined) or why not: the last check while it's fresh, else a new one when
 * `ask` allows it, else `false` for not known yet. */
async function runtimeAnswers(runtime: Runtime, ask: boolean): Promise<string | undefined | false> {
  const last = lastRuntimeCheck;
  if (last && last.bin === runtime.bin && performance.now() - last.at < RUNTIME_CHECK_FRESH) return last.why;
  if (!ask) return false;
  const why = await runtime.usable();
  lastRuntimeCheck = { at: performance.now(), bin: runtime.bin, why };
  return why;
}

/** Forgets the last runtime check: a test's. */
export function forgetRuntimeCheck(): void {
  lastRuntimeCheck = undefined;
}

/** Whether desktop sessions can run here, and in what, for the doctor (each heartbeat): what the node last found when
 * it prepared them, else what it finds now, a container runtime counting only if it answers (asked when `ask`), and
 * what to install where nothing works. undefined where the node lends none. */
export async function healthOf(home: string, config: DesktopConfig, ask = true): Promise<DesktopHealth | undefined> {
  if (!enabled(config)) return undefined;
  try {
    return JSON.parse(readFileSync(statePath(home), "utf8")) as DesktopHealth;
  } catch {}
  const { runtime, xvfb } = choose(config, home);
  const answers = runtime ? await runtimeAnswers(runtime, ask) : false;
  if (runtime && answers === undefined) {
    return health("ready", "container", `Desktop screens run in ${runtime.name()} containers; the first one builds the image.`);
  }
  if (xvfb) {
    const why = !runtime ? "; no docker or podman for containers" : typeof answers === "string" ? `; not in containers: ${answers}` : "";
    return health("ready", "xvfb", `Desktop screens run on Xvfb (${xvfb}) with a fresh home each${why}.`);
  }
  if (runtime && typeof answers === "string") {
    return health(
      "unavailable",
      "container",
      `Desktop screens can't run here: ${answers}, and there's no Xvfb. Install Xvfb, or make \`${runtime.name()} info\` answer for this user (${runtime.bin}).`,
      installFix(),
    );
  }
  return health("unavailable", undefined, "Desktop screens need docker or podman, or Xvfb; this machine has none that works.", installFix());
}

/** What the node lists at its link's hello for desktop sessions. Never asks the runtime: one not checked yet counts
 * only once a heartbeat has asked it. */
export async function capabilities(node: Node): Promise<string[]> {
  const h = await healthOf(node.home, desktopConfig(node), false);
  return h?.state === "ready" ? [CAP_SESSION_DESKTOP] : [];
}

/** The desktop's line in the heartbeat's `load.hosts` (hosts.rs `desktop`). */
export async function hostCheck(home: string, config: DesktopConfig): Promise<HostCheck> {
  const check = (off: string | undefined, detail: string, fix?: string): HostCheck => ({
    host: "desktop",
    ready: off === undefined,
    detail: detail.length > 300 ? `${detail.slice(0, 297)}...` : detail,
    ...(off ? { off } : {}),
    ...(off && fix && fix.length <= 300 ? { fix } : {}),
    idleMinutes: IDLE_MINUTES,
  } as HostCheck);
  if (process.platform !== "linux" || !enabled(config)) return check("unsupported", "desktop screens run on Linux (docker or Xvfb)");
  const h = await healthOf(home, config);
  if (!h) return check("missing", "no docker, podman or Xvfb", installFix());
  return check(h.state === "unavailable" ? "missing" : undefined, h.message, h.fix);
}

/** A session's own working directory (its worktree), as the node started it; undefined for one it doesn't know. */
export type WorktreeFor = (thread: string) => string | undefined;

/** The folder a container session's apps see, read-only: the calling agent's own worktree, `known` as the node started
 * its session, never a folder the call names. A session hosted for an agent elsewhere sees none, nor does an Xvfb
 * session, whose apps run on this machine already. */
export function worktreeMount(backend: Backend, hosted: boolean, known: string | undefined): string | undefined {
  if (backend !== "container" || hosted || !known) return undefined;
  const home = homeDir();
  const broad = known === "/" || known === home || home.startsWith(`${known.replace(/\/$/, "")}/`);
  if (!known.startsWith("/") || broad) return undefined;
  try {
    return statSync(known).isDirectory() ? known : undefined;
  } catch {
    return undefined;
  }
}

/** How long a `session_start` waits for the node to prepare desktop sessions before it says to come back. */
export const PREPARE_WAIT = 30_000;

type Prep = { kind: "wanted" } | { kind: "preparing"; done: Promise<void> } | { kind: "ready"; pool: Pool } | { kind: "unavailable"; why: string };

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** What Desktops reads of the node's sessions: their secrets (to scrub the recording; throws why they can't be read)
 * and their worktrees. The node core sets these from its session service; the defaults know no session. */
export type Hooks = { secretsFor: (thread: string) => [string, string][]; worktreeFor: WorktreeFor };

/** The node's desktop sessions: its agents' in their boxes (./desktops.ts), and those on this machine's own displays
 * and on the agents' Mac's screen. */
export class Desktops extends DesktopSessions implements Screens {
  private prep: Prep = { kind: "wanted" };
  private housekeeping: Timer | undefined;
  /** Where its recordings are kept until the hub has them. */
  private readonly disk: DiskDesktopRecordings;
  /** Read of the node's own sessions (node-core's `sessions` area) where it has one; a test's own otherwise. */
  hooks: Hooks = {
    // A host key's are what its agent's node sealed to this one; this node's own sessions' are its own.
    secretsFor: (thread) => sessionRoute(this.node).secretsOf(thread),
    worktreeFor: (thread) => this.sessionsArea()?.sessionCwd(thread),
  };
  /** What the hello lists for desktop sessions now (`capabilities`), kept for the `caps` seam, which reads it at once. */
  capsNow: string[] = [];
  /** node.json's `mac`: the agents' Mac's screen, where this node lends it. */
  readonly mac: MacConfig;
  /** The Mac screen session that holds the Mac's lease now (its pointer and keys), and when it last used it. It stays
   * its holder's until the holder's session has ended, its last command included, or it goes unused IDLE_MINUTES. */
  private lease: Session | undefined;
  private leaseUsed = 0;
  /** Each app claimed on the Mac's screen: the session that claimed it, the app's name as it gave it, and every name
   * the app goes by (mac/index.ts `App`), more as they are learned. Kept until that session has ended, its last command
   * included. */
  private claims: { session: Session; name: string; keys: Set<string> }[] = [];
  /** The clock the lease's idle time is read on (a test's own). */
  clock: () => number = () => performance.now();
  /** What stands in the way of the Mac's screen now (mac/index.ts `blocked`; a test's own). */
  macGate: () => Blocked | undefined = macBlocked;
  /** The Mac's own screen, for a session to read and drive (a test's own). */
  openMacScreen: (scratch: string) => Screen = (scratch) => MacScreen.open(join(scratch, "frames"));

  constructor(
    private readonly node: Node,
    readonly config: DesktopConfig = desktopConfig(node),
    mac?: MacConfig,
  ) {
    // What the host reads of this object (its hooks, its ffmpeg) it reads once the object is made.
    const late: { d?: Desktops } = {};
    const disk = new DiskDesktopRecordings(
      recordingsDir(node.home),
      (thread, cwd, op, args) => hubCall(node, op, args, { threadId: thread, cwd }),
      () => late.d!.ffmpeg(),
    );
    super({
      call: (op, args, opts) => hubCall(node, op, args, opts),
      send: (frame) => void toHub(node, frame),
      secrets: (thread) => late.d!.hooks.secretsFor(thread),
      inBox: (thread) => hostedBox(thread) ?? (hasBox(thread) ? "starting" : undefined),
      recordings: disk,
      encoder: liveEncoder(() => ensureFfmpeg(node.home)),
    });
    late.d = this;
    this.disk = disk;
    this.latest = new Steps();
    // The agents' Mac lends its screen, whatever an older node.json's `mac.enabled` says; no other machine does.
    this.mac = mac ?? { ...((node.config.mac ?? {}) as MacConfig), enabled: node.config.agentsMac === true };
  }

  private sessionsArea(): SessionsArea | undefined {
    try {
      return this.node.area("sessions");
    } catch {
      return undefined;
    }
  }

  /** Reads what the hello lists for desktop sessions again, and has the node link anew when it changed. */
  async refreshCaps(): Promise<void> {
    const now = await capabilities(this.node);
    if (now.join() === this.capsNow.join()) return;
    this.capsNow = now;
    this.node.area("caps").changed();
  }

  /** Nothing starts here unless node.json turns them on explicitly; the first linux_desktop `session_start` prepares
   * them otherwise. */
  start(): void {
    rmSync(statePath(this.node.home), { force: true });
    // Where it lends the Mac's screen, agent-desktop is installed now, so the first Mac screen doesn't wait for it.
    if (macEnabled(this.mac)) {
      void installAgentDesktop(this.node.home).catch((e: Error) => console.warn(`agent-desktop not installed yet: ${e.message}`));
    }
    if (enabled(this.config)) {
      // Ask the runtime now, so the next link's hello knows whether containers work.
      const { runtime } = choose(this.config, this.node.home);
      void (runtime ? runtimeAnswers(runtime, true) : Promise.resolve()).then(() => this.refreshCaps());
    }
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
    void this.sweep();
  }

  private writeState(h: DesktopHealth): void {
    try {
      mkdirSync(desktopDir(this.node.home), { recursive: true, mode: 0o700 });
      const next = `${statePath(this.node.home)}.next`;
      writeFileSync(next, JSON.stringify(h), { mode: 0o600 });
      renameSync(next, statePath(this.node.home));
    } catch {}
  }

  /** Starts preparing, once: picks the backend, clears what a dead node left, builds the image if it must, then
   * fills the pool. */
  private beginPrepare(): void {
    if (this.prep.kind !== "wanted" && this.prep.kind !== "unavailable") return;
    const done = prepare(this.node.home, this.config, (h) => this.writeState(h)).then(
      (settings) => this.ready(settings),
      (e: Error) => {
        console.warn(`desktop sessions not prepared: ${e.message}`);
        this.writeState(health("unavailable", undefined, `Desktop screens can't run here: ${e.message}.`, installFix()));
        this.prep = { kind: "unavailable", why: e.message };
      },
    ).then(() => this.refreshCaps());
    this.prep = { kind: "preparing", done };
  }

  /** Makes the pool and starts filling it. */
  ready(settings: Settings): void {
    const pool = new Pool(settings, this.config.pool ?? 1);
    pool.refill();
    this.writeState(
      health(
        "ready",
        settings.backend,
        settings.backend === "container" ? "Desktop screens run in containers of the pinned image." : "Desktop screens run on Xvfb with a fresh home each.",
      ),
    );
    this.prep = { kind: "ready", pool };
  }

  /** The pool, once prepared: a start that finds preparing under way waits for it (up to PREPARE_WAIT). */
  private async pool(): Promise<Pool> {
    // What failed is tried again by the next session that asks: a person may have fixed it.
    if (this.prep.kind === "unavailable") this.prep = { kind: "wanted" };
    this.beginPrepare();
    if (this.prep.kind === "preparing") await Promise.race([this.prep.done, Bun.sleep(PREPARE_WAIT)]);
    const prep = this.prep as Prep;
    switch (prep.kind) {
      case "ready":
        return prep.pool;
      case "unavailable":
        throw new ToolError(
          "failed",
          `This machine can't host desktop sessions: ${prep.why}.`,
          `say so in your result: a person must run \`${installFix()}\` on this machine`,
        );
      default:
        throw new ToolError(
          "failed",
          "This machine is still preparing desktop sessions (the first time, it builds their container image).",
          "try session_start again in a few minutes, or carry on without it",
        );
    }
  }

  /** Whether sessions start at once now. */
  readyNow(): boolean {
    return this.prep.kind === "ready";
  }

  /** Displays started for the next sessions. */
  warm(): number {
    return this.prep.kind === "ready" ? this.prep.pool.warm() : 0;
  }

  /** `session_start` kind mac lends the Mac's screen; the rest go to the core. */
  protected override startKind(thread: string, cwd: string, call: BrowserCallFrame["call"]): Promise<Record<string, unknown>> {
    if (call.kind === "mac") return this.macStart(thread, cwd, String(call.purpose ?? "a Mac screen session"));
    return super.startKind(thread, cwd, call);
  }

  /** `session_start` of an agent in no box (a hosted agent's desktop runs in its own box, whatever this machine
   * lends: ./desktops.ts): a display of this machine's pool. */
  protected override async machineStart(thread: string, cwd: string, purpose: string): Promise<Record<string, unknown>> {
    if (!enabled(this.config)) {
      throw new ToolError(
        "failed",
        "This machine hosts no Linux desktop sessions: they run on Linux machines that run agents.",
        "say so in your result",
      );
    }
    const started = performance.now();
    this.notTwice(thread);
    this.starting.add(thread);
    try {
      const pool = await this.pool();
      const hosted = sessionRoute(this.node).hosted.has(thread);
      const mount = worktreeMount(pool.backend(), hosted, this.hooks.worktreeFor(thread));
      const didntStart = (why: string) => new ToolError("failed", `The desktop did not start: ${why}.`, "try session_start again");
      const secrets = this.secrets(thread);
      let display;
      try {
        display = await pool.take(mount);
      } catch (e) {
        throw didntStart((e as Error).message);
      }
      let x;
      try {
        x = await display.connect();
      } catch (e) {
        await display.drop();
        throw didntStart((e as Error).message);
      }
      const id = newId();
      let recording;
      try {
        recording = await this.record(this.metaOf(id, thread, cwd, purpose, new Date().toISOString(), "linux_desktop"));
      } catch (e) {
        x.close();
        await display.drop();
        throw e;
      }
      const session = new Session(display, x, { id, thread, cwd, purpose, secrets, kind: "linux_desktop", recording, steps: this.latest, launchRefusal: this.launchRefusal(thread), ...this.encodes() });
      this.sessions.set(thread, session);
      session.open();
      session.logStep("session_start", { purpose, kind: "linux_desktop", backend: display.backend, worktree: mount ?? null }, true);
      await this.report(session, "live");
      return {
        sessionId: session.id,
        desktop: display.backend,
        ...(mount ? { worktree: mount } : {}),
        startMs: Math.round(performance.now() - started),
      };
    } finally {
      this.starting.delete(thread);
    }
  }

  /** A hosted agent on this machine's display: what it launches would run outside its box. */
  private launchRefusal(thread: string): () => string | undefined {
    return () => (agentInBox(thread) ? BOX_NO_DESKTOP_LAUNCH : undefined);
  }

  /** `FLEETD_FFMPEG` (node.json `desktop.ffmpeg`), else one the Android or browser sessions installed. */
  ffmpeg(): string | undefined {
    if (this.config.ffmpeg) return this.config.ffmpeg;
    const android = sdkAt(this.node.home).ffmpeg;
    if (existsSync(android) && statSync(android).isFile()) return android;
    return findFfmpeg(browserInstallDir(this.node.home));
  }

  /** A session ended: the Mac's lease and its claims go back, its last agent-desktop command stopped; its recording
   * goes to the hub, which has heard of its end. */
  protected override closed(session: Session): void {
    this.release(session);
    this.disk.send(session.id);
  }

  /** Before a Mac screen session's action: its lease or a claim. */
  protected override async beforeAct(session: Session, call: DesktopCall): Promise<void> {
    if (session.kind === "mac") await this.macAccess(session, call);
  }

  /** A person takes a Mac screen session over: the lease is theirs. */
  protected override takingOver(session: Session): void {
    if (session.kind === "mac") this.personTakesLease(session);
  }

  /** Who holds the Mac's lease, in a line for the others; undefined while nobody does. */
  heldBy(): string | undefined {
    return this.lease ? this.describe(this.lease) : undefined;
  }

  /** The apps claimed on the Mac's screen now, each with who holds it, in a line for the others. */
  claimed(): { app: string; heldBy: string }[] {
    return this.claims.map((c) => ({ app: c.name, heldBy: this.describe(c.session) }));
  }

  /** The lease's or a claim's holder `session`, in a line for the others. */
  private describe(session: Session): string {
    if (session.control() === "human") return `a person has taken it over ("${session.purpose}")`;
    return `another agent's session "${session.purpose}" holds it (idle ${Math.floor(session.idleFor() / 60_000)} min; it ends after ${MAC_IDLE_MINUTES} min idle)`;
  }

  /** `session_start` kind mac: the Mac's screen, shared; the session holds nothing until an action needs it. */
  async macStart(thread: string, cwd: string, purpose: string): Promise<Record<string, unknown>> {
    if (!macEnabled(this.mac)) {
      throw new ToolError(
        "failed",
        "This machine lends no Mac screen: it is off in its node.json, or this isn't a Mac.",
        `say so in your result: an admin turns the Mac screen on, on the Mac's page in ${settingsPath()} › Machines`,
      );
    }
    const open = this.sessions.get(thread);
    if (open) throw new ToolError("invalid", `Mac screen session ${open.id} is open.`, "use it, or end it with session_end before starting another");
    // Checked at every start: Fast User Switching, a lock or a revoked grant can change it at any time.
    const gate = this.macGate();
    if (gate) {
      throw new ToolError("failed", `The Mac's screen can't be lent now: ${gate.message}.`, "say so in your result, with what a person must do at the Mac");
    }
    const agentDesktop = await installAgentDesktop(this.node.home).catch((e: Error) => e);
    let screen: Screen;
    try {
      screen = this.openMacScreen(macDir(this.node.home));
    } catch (e) {
      throw new ToolError("failed", `The Mac's screen can't be read here: ${(e as Error).message}.`, "say so in your result");
    }
    return this.openMac(thread, cwd, purpose, screen, agentDesktop);
  }

  /** Opens a Mac screen session on `screen`. It holds neither the lease nor a claim yet, so it observes until its first
   * action that needs one; the answer says who holds the lease now, and which apps are claimed. */
  async openMac(thread: string, cwd: string, purpose: string, screen: Screen, agentDesktop: string | Error): Promise<Record<string, unknown>> {
    if (this.starting.has(thread) || this.sessions.has(thread)) {
      throw new ToolError("invalid", "Another session_start of yours is under way.", "wait for its answer and use that session");
    }
    const id = newId();
    let lent: MacLent;
    try {
      lent = new MacLent(join(macDir(this.node.home), "sessions", id), agentDesktop);
    } catch (e) {
      throw new ToolError("failed", `The node could not make the session's folder: ${(e as Error).message}.`, "say so in your result; the node's log says why");
    }
    let secrets: [string, string][];
    try {
      secrets = this.secrets(thread);
    } catch (e) {
      await lent.drop();
      throw e;
    }
    // Held while its recording opens: the only way in.
    this.starting.add(thread);
    let recording;
    try {
      recording = await this.record(this.metaOf(id, thread, cwd, purpose, new Date().toISOString(), "mac"));
    } catch (e) {
      await lent.drop();
      throw e;
    } finally {
      this.starting.delete(thread);
    }
    const heldBy = this.heldBy();
    const claimed = this.claimed().map((c) => c.app);
    const session = new Session(lent, screen, {
      id,
      thread,
      cwd,
      purpose,
      secrets,
      kind: "mac",
      observing: true,
      recording,
      steps: this.latest,
      launchRefusal: this.launchRefusal(thread),
    });
    this.sessions.set(thread, session);
    session.open();
    session.logStep("session_start", { purpose, kind: "mac" }, true, heldBy);
    void this.report(session, "live");
    return {
      sessionId: id,
      desktop: "mac",
      ...(heldBy ? { heldBy: heldBy.slice(0, 300) } : {}),
      ...(claimed.length ? { claimed: claimed.slice(0, 20) } : {}),
      startMs: session.offsetMs(),
    };
  }

  /** Before a Mac screen session's action: nothing for a read; a claim on the app it names for a headless command; the
   * lease (and a claim on its app, where it names one) for anything else. Refused while a person drives any Mac screen
   * session, while another session holds what it needs, or while the screen can't be lent. */
  private async macAccess(session: Session, call: DesktopCall): Promise<void> {
    const need = macNeeds(call);
    if (need.needs === "read") return;
    this.personDriving(session);
    let app: App | undefined;
    if (need.target) {
      try {
        app = await session.appOf(need.target);
      } catch {}
      if (this.sessions.get(session.thread) !== session) throw new ToolError("not_found", "No desktop session is open.", "start one with session_start kind mac");
      this.personDriving(session);
    }
    // A command whose app the session can't tell (a ref from a snapshot it never saw) can't be claimed: it needs the
    // lease, as anything not known to be headless does.
    const lease = need.needs === "lease" || app === undefined;
    const claim = app ? this.claims.find((c) => app.keys.some((k) => c.keys.has(k))) : undefined;
    if (app && claim && claim.session !== session) {
      throw new ToolError(
        "invalid",
        `${app.name} is another session's on the Mac now: ${this.describe(claim.session)}. Its claim lasts until that session ends. You can still read ${app.name} (snapshot, find, get, is), and work on any other app meanwhile.`,
        "carry on with another app or without it, and try again later",
      );
    }
    if (lease) this.takeLease(session);
    if (app && !claim) {
      // The lease checked the screen already; a claim alone checks it now.
      if (!lease) this.gate();
      this.claims.push({ session, name: app.name, keys: new Set(app.keys) });
      session.logStep("app_claimed", { app: app.name }, true);
      session.setObserving(false);
    }
    // Its own claim learns the names the app goes by now: one made by name before the app ran matches its bundle id.
    if (app && claim) for (const key of app.keys) claim.keys.add(key);
  }

  /** Refuses while a person drives a Mac screen session other than `session`: their takeover takes the whole screen,
   * every agent's lease and claims included, for as long as they drive. */
  private personDriving(session: Session): void {
    for (const other of this.sessions.values()) {
      if (other !== session && other.kind === "mac" && other.control() === "human") {
        throw new ToolError(
          "invalid",
          `The Mac's screen is a person's for now: a person has taken it over ("${other.purpose}"). Until they hand it back, every agent only observes it: screenshot, cursor_position, wait and agent-desktop's reading commands (snapshot, find, get, is, list-apps).`,
          "carry on with what you can without it and try again later; once they're done, take a screenshot first: they may have changed things",
        );
      }
    }
  }

  /** Throws what stands in the way of the Mac's screen now, if anything does. */
  private gate(): void {
    const gate = this.macGate();
    if (gate) {
      throw new ToolError("failed", `The Mac's screen can't be lent now: ${gate.message}.`, "say so in your result, with what a person must do at the Mac");
    }
  }

  /** Before an action of `session` that needs the lease: takes it if nobody holds it, else refuses with who does. */
  private takeLease(session: Session): void {
    if (this.lease === session) {
      this.leaseUsed = this.clock();
      return;
    }
    if (this.lease) {
      throw new ToolError(
        "invalid",
        `The Mac's pointer and keys are someone else's now: ${this.heldBy()}. You can observe meanwhile (screenshot, cursor_position, wait and agent-desktop's reading commands: snapshot, find, get, is, list-apps), and agent-desktop's headless commands on an app no other session has claimed need no lease (click, type, set-value, ... on a ref; press with --app).`,
        "carry on with what you can without it and try again later; once it's free, your next action takes it",
      );
    }
    this.gate();
    this.lease = session;
    this.leaseUsed = this.clock();
    session.logStep("lease_taken", {}, true);
    session.setObserving(false);
  }

  /** A person takes a Mac screen session over: the lease is theirs through it, and whoever held it only observes. */
  private personTakesLease(session: Session): void {
    const before = this.lease;
    this.lease = session;
    this.leaseUsed = this.clock();
    if (before && before !== session) this.lostLease(before, "a person took the Mac's screen over");
    session.setObserving(false);
  }

  /** `session` no longer holds the lease: it records only while it still holds a claim. */
  private lostLease(session: Session, why: string, log = true): void {
    if (log) session.logStep("lease_lost", { why }, true);
    if (!this.claims.some((c) => c.session === session)) session.setObserving(true);
  }

  /** A session ended: the lease, if it held it, and its claims go back. */
  private release(session: Session): void {
    if (this.lease === session) this.lease = undefined;
    this.claims = this.claims.filter((c) => c.session !== session);
  }

  /** A Mac screen session's idle limit is the Mac's; a Linux desktop's the core's. */
  protected override idleLimit(session: Session): number {
    return session.kind === "mac" ? 60_000 * MAC_IDLE_MINUTES : super.idleLimit(session);
  }

  /** Ends sessions idle past the limit, and gives back a lease unused that long; then sends the recordings still
   * waiting for the hub: this kind's, and what a Rust node's iOS screens left. */
  override async housekeep(now = Date.now()): Promise<void> {
    const holder = this.lease;
    if (holder && holder.control() === "agent" && this.clock() - this.leaseUsed >= 60_000 * MAC_IDLE_MINUTES) {
      this.lease = undefined;
      // Not a step: one would count as the session's action and keep it from ending idle.
      this.lostLease(holder, "unused", false);
    }
    await super.housekeep(now);
  }

  /** Ends every live session and every warm display (the node stops); their recordings go at the node's next start. */
  override async shutdown(): Promise<void> {
    clearInterval(this.housekeeping);
    await super.shutdown();
    if (this.prep.kind === "ready") for (const d of this.prep.pool.drain()) await d.drop();
  }
}

/** Picks the backend and gets it ready: a usable container runtime and its image, else Xvfb. */
export async function prepare(home: string, config: DesktopConfig, state: (h: DesktopHealth) => void): Promise<Settings> {
  const { runtime: found, xvfb } = choose(config, home);
  let runtime = found;
  if (found) {
    const why = await found.usable();
    if (why !== undefined) {
      if (config.backend === "container" || !xvfb) throw new Error(why);
      console.info(`desktop sessions use Xvfb: the container runtime doesn't answer: ${why}`);
      runtime = undefined;
    }
  }
  const root = join(desktopDir(home), "displays");
  const cleared = await clearLeftovers(root, runtime);
  if (cleared > 0) console.info(`${cleared} desktop displays a stopped node left running were cleared`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`cannot make ${root}: ${(e as Error).message}`);
  }
  const dirs = {
    ...(config.x11Dir ? { x11Dir: config.x11Dir } : {}),
    ...(config.lockDir ? { lockDir: config.lockDir } : {}),
    ...(config.windowManagers ? { windowManagers: config.windowManagers } : {}),
  };
  const onXvfb = (at: string): Settings => ({ backend: "xvfb", image: "", xvfb: at, root, ...dirs });
  if (runtime) {
    const image = config.image ?? pinnedImage();
    if (!config.image && !(await runtime.hasImage(image))) {
      state(health("preparing", "container", `Building the desktop sessions' container image with ${runtime.name()}.`));
      try {
        await runtime.build(image, desktopDir(home), join(desktopDir(home), "build.log"));
      } catch (e) {
        // No image (no network, a slow snapshot server): Xvfb still serves, and the next start tries the build again.
        if (!xvfb || config.backend !== undefined) throw e;
        console.warn(`desktop sessions use Xvfb: the container image didn't build: ${(e as Error).message}`);
        return onXvfb(xvfb);
      }
    }
    return { backend: "container", runtime, image, ...(xvfb ? { xvfb } : {}), root, ...dirs };
  }
  if (xvfb) return onXvfb(xvfb);
  throw new Error("this machine has neither docker or podman nor Xvfb");
}

/** The agents' Mac's screen as the heartbeat's host line reads it (hosts.rs `mac_screen`): on on the agents' Mac,
 * what stands in the way of it now, and who holds it. */
export function macScreen(node: Node): { enabled: boolean; blocked(): Blocked | undefined; heldBy(): string | undefined } {
  const d = desktops(node);
  return { enabled: macEnabled(d.mac), blocked: () => d.macGate(), heldBy: () => d.heldBy() };
}

/** The node's desktops: `given` (a test's) when it is the first to ask, else the node's own. */
export const desktops = (node: Node, given?: Desktops) => node.area("desktop", (n) => given ?? new Desktops(n));

/**
 * Wires the desktops into the node (Rust `Desktops::start`): the router's desktop kind, agent-mcp's `desktop` and
 * `request_takeover` (through session routing, as a session placed on another machine answers them there), the hub's
 * live view for desktop ids, the heartbeat's desktop health and host check, and the hello's capability.
 */
export function start(node: Node, given?: Desktops): Desktops {
  const d = desktops(node, given);
  d.start();
  router(node).desktops = d;
  const agentOnly = () => new ToolError("forbidden", "A desktop session belongs to an agent's session, and this call comes from none.");
  for (const op of ["desktop", "request_takeover"]) {
    node.area("local").on(op, async (thread, frame) => {
      try {
        if (!thread) throw agentOnly();
        const call = { ...((frame.call ?? {}) as Record<string, unknown>), op };
        const cwd = typeof frame.cwd === "string" ? frame.cwd : "/";
        return { result: await sessionRoute(node).route(thread, { id: String(frame.id ?? op), cwd, call }) };
      } catch (e) {
        if (e instanceof ToolError) return { error: e.toJSON() };
        return { error: { code: "failed", message: (e as Error).message } };
      }
    });
  }
  // The hub's live view: a desktop's ids here, every other the handler before (the browser broker's).
  const link = node.area("link");
  for (const [tag, mine] of [
    ["browser_watch", (f: unknown) => d.watch(f as BrowserWatchFrame)],
    ["browser_input", (f: unknown) => d.input(f as BrowserInputFrame)],
    ["browser_control", (f: unknown) => d.control(f as BrowserControlFrame)],
  ] as const) {
    const before = link.handler(tag);
    link.on(tag, (frame, ctx) => {
      if (!mine(frame)) before?.(frame, ctx);
    });
  }
  node.area("hb").contribute(async (hb) => {
    hb.steps.push(...d.steps());
    hb.busy.screens = (hb.busy.screens ?? 0) + d.count();
    await d.refreshCaps();
    if (hb.load) {
      const h = await healthOf(node.home, d.config);
      if (h) hb.load.desktop = h;
      if (node.config.agentsMac !== true) hb.load.hosts = [...(hb.load.hosts ?? []), await hostCheck(node.home, d.config)];
    }
  });
  // The hello lists desktop sessions once their health is ready, as the Rust node does: re-read at each heartbeat.
  node.area("caps").contribute(() => d.capsNow);
  void d.refreshCaps();
  return d;
}

/** Stops the desktops as the node stops. */
export async function stop(node: Node): Promise<void> {
  await desktops(node).shutdown();
}
