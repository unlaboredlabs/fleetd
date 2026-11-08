// Linux desktop sessions (crates/fleetd/src/node/desktop/mod.rs, W46): an agent opens one with `session_start` kind
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
// node runs in rather than a display of its own, and leased to one session at a time.
//
// TODO(bun): the recordings (session.ts).
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserControlTo, BrowserSessionState, HostCheck } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserCallFrame, BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame } from "../../shared/screens_wire.ts";
import type { SessionsArea } from "../api.ts";
import { hubCall, type Node, toHub } from "../browser/node.ts";
import { type Answer, router, type Screens, type SessionKind } from "../device/router.ts";
import { Masker } from "../mask.ts";
import { router as sessionRoute } from "../session_route/index.ts";
import { homeDir } from "../util.ts";
import { image as pinnedImage, Runtime } from "./container.ts";
import { type Backend, clearLeftovers, Pool, type Settings } from "./display.ts";
import { onPath } from "./paths.ts";
import { install as installAgentDesktop, macDir } from "./mac/agent_desktop.ts";
import { type Blocked, blocked as macBlocked, IDLE_MINUTES as MAC_IDLE_MINUTES, MacLent, type MacConfig, macEnabled, observes } from "./mac/index.ts";
import { MacScreen } from "./mac/screen.ts";
import type { Screen } from "./screen.ts";
import { type DesktopCall, Session } from "./session.ts";

/** The capability a node lists at its hello once desktop sessions can run (node_link.rs `CAP_SESSION_DESKTOP`). */
export const CAP_SESSION_DESKTOP = "session_linux_desktop";

/** node.json's `desktop`: how this machine runs Linux desktop sessions. Every field is optional. */
export type DesktopConfig = {
  /** False turns desktop sessions off on this machine; true also prepares them as the node starts. Absent: on,
   * prepared when an agent first asks for a session. */
  enabled?: boolean;
  /** `container` or `xvfb` only. Absent: a container where docker or podman works, else Xvfb. */
  backend?: Backend;
  /** The docker or podman to use instead of the one on the PATH: `FLEETD_DESKTOP_RUNTIME`, for development. */
  runtime?: string;
  /** An image to run instead of building the pinned one: `FLEETD_DESKTOP_IMAGE`, for development. */
  image?: string;
  /** The Xvfb to use instead of the one on the PATH: `FLEETD_XVFB`, for development. */
  xvfb?: string;
  /** Displays kept started for the next sessions: 1, and 0 in tests that start none. */
  pool?: number;
  /** A session no action touched for this long is ended: node.json's `screenIdleMinutes`. Absent: 30. */
  idleMinutes?: number;
  /** Where X servers put their sockets and locks, and the window managers looked for: a test's own, never the
   * host's. */
  x11Dir?: string;
  lockDir?: string;
  windowManagers?: string[];
};

/** On unless node.json turns them off; Linux only (a container's X socket can't cross into macOS). */
export const enabled = (config: DesktopConfig) => config.enabled !== false && process.platform === "linux";

const devOverride = (name: string) => process.env[name] || undefined;

/** The node's desktop config as it runs it: node.json's section, its idle time and the development overrides
 * (config.rs `desktop_screen`). The agents' Mac hosts its own screen, never a Linux desktop. */
export function desktopConfig(node: Node): DesktopConfig {
  const section = (node.config.desktop ?? {}) as DesktopConfig;
  const config: DesktopConfig = {
    ...section,
    ...(node.config.screenIdleMinutes !== undefined ? { idleMinutes: node.config.screenIdleMinutes } : {}),
  };
  for (const [key, env] of [["runtime", "FLEETD_DESKTOP_RUNTIME"], ["image", "FLEETD_DESKTOP_IMAGE"], ["xvfb", "FLEETD_XVFB"]] as const) {
    const v = devOverride(env);
    if (v) config[key] = v;
  }
  if (node.config.agentsMac === true) config.enabled = false;
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
 * it prepared them, else what it finds now, a container runtime counting only if it answers (asked when `ask`).
 * undefined where node.json turns them off, and where nothing works and node.json doesn't ask for them. */
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
  if (config.enabled !== true) return undefined;
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

/** A screen's idle timeout where node.json sets none. */
const IDLE_MINUTES = 30;

/** The desktop's line in the heartbeat's `load.hosts` (hosts.rs `desktop`). */
export async function hostCheck(home: string, config: DesktopConfig): Promise<HostCheck> {
  const check = (off: string | undefined, detail: string, fix?: string): HostCheck => ({
    host: "desktop",
    ready: off === undefined,
    detail: detail.length > 300 ? `${detail.slice(0, 297)}...` : detail,
    ...(off ? { off } : {}),
    ...(off && fix && fix.length <= 300 ? { fix } : {}),
    on: enabled(config),
    idleMinutes: Math.max(1, Math.min(1440, config.idleMinutes ?? IDLE_MINUTES)),
  } as HostCheck);
  if (process.platform !== "linux") return check("unsupported", "desktop screens run on Linux (docker or Xvfb)");
  if (!enabled(config)) return check("off", "desktop screens are off in node.json");
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

/** What Desktops reads of the node's sessions: their secrets (to scrub the steps) and their worktrees. The node core
 * sets these from its session service; the defaults know no session. */
export type Hooks = { maskFor: (thread: string) => Masker; worktreeFor: WorktreeFor };

/** The node's Linux desktop sessions. */
export class Desktops implements Screens {
  private prep: Prep = { kind: "wanted" };
  /** Live sessions by the agent session they belong to: one each. */
  private readonly sessions = new Map<string, Session>();
  /** Agent sessions whose `session_start` is under way. */
  private readonly starting = new Set<string>();
  private housekeeping: Timer | undefined;
  /** Read of the node's own sessions (node-core's `sessions` area) where it has one; a test's own otherwise. */
  hooks: Hooks = {
    maskFor: (thread) => this.sessionsArea()?.maskFor(thread) ?? new Masker(),
    worktreeFor: (thread) => this.sessionsArea()?.sessionCwd(thread),
  };
  /** What the hello lists for desktop sessions now (`capabilities`), kept for the `caps` seam, which reads it at once. */
  capsNow: string[] = [];
  /** node.json's `mac`: the agents' Mac's screen, where this node lends it. */
  readonly mac: MacConfig;
  /** The Mac screen session that holds the Mac's screen now. */
  private lease: string | undefined;
  /** What stands in the way of the Mac's screen now (mac/index.ts `blocked`; a test's own). */
  macGate: () => Blocked | undefined = macBlocked;
  /** The Mac's own screen, for a session to read and drive (a test's own). */
  openMacScreen: (scratch: string) => Screen = (scratch) => MacScreen.open(scratch);

  constructor(
    private readonly node: Node,
    readonly config: DesktopConfig = desktopConfig(node),
    mac?: MacConfig,
  ) {
    this.mac = mac ?? ((node.config.mac ?? {}) as MacConfig);
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
      if (this.config.enabled === true) this.beginPrepare();
      else {
        // Ask the runtime now, so the next link's hello knows whether containers work.
        const { runtime } = choose(this.config, this.node.home);
        void (runtime ? runtimeAnswers(runtime, true) : Promise.resolve()).then(() => this.refreshCaps());
      }
    }
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
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

  count(): number {
    return this.sessions.size;
  }

  session(thread: string): Session | undefined {
    return this.sessions.get(thread);
  }

  live(thread: string): { id: string; kind: SessionKind } | undefined {
    const s = this.sessions.get(thread);
    return s ? { id: s.id, kind: s.kind } : undefined;
  }

  /** Each live session's latest step, for the heartbeat. */
  steps(): { sessionId: string; step: unknown }[] {
    return [...this.sessions.values()].flatMap((s) => (s.step ? [{ sessionId: s.id, step: s.step }] : []));
  }

  byId(id: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  /** A session call for `thread`'s desktop (node/device's router sends it here). */
  async handle(thread: string, frame: BrowserCallFrame): Promise<Answer> {
    const call = frame.call;
    switch (call.op) {
      case "session_start":
        if (call.kind === "mac") {
          return { op: "session_start", ...(await this.macStart(thread, frame.cwd, String(call.purpose ?? "a Mac screen session"))) };
        }
        return { op: "session_start", ...(await this.sessionStart(thread, frame.cwd, String(call.purpose ?? "a desktop session"))) };
      case "session_end":
        return { op: "session_end", ...(await this.sessionEnd(thread)) };
      case "desktop":
        return { op: "desktop", ...(await this.act(thread, call as unknown as DesktopCall)) };
      case "request_takeover":
        return { op: "request_takeover", ...(await this.requestTakeover(thread, String(call.reason ?? ""))) };
      default:
        throw new ToolError("invalid", `${call.op} is for browser sessions.`, "do without it and say so in your result");
    }
  }

  async sessionStart(thread: string, cwd: string, purpose: string): Promise<Record<string, unknown>> {
    if (!enabled(this.config)) {
      throw new ToolError(
        "failed",
        "This machine hosts no Linux desktop sessions (they run on Linux, and node.json may turn them off).",
        "say so in your result",
      );
    }
    const started = performance.now();
    if (this.starting.has(thread)) throw new ToolError("invalid", "Another session_start of yours is under way.", "wait for its answer and use that session");
    const open = this.sessions.get(thread);
    if (open) throw new ToolError("invalid", `Desktop session ${open.id} is open.`, "use it, or end it with session_end before starting another");
    this.starting.add(thread);
    try {
      const pool = await this.pool();
      const hosted = sessionRoute(this.node).hosted.has(thread);
      const mount = worktreeMount(pool.backend(), hosted, this.hooks.worktreeFor(thread));
      const didntStart = (why: string) => new ToolError("failed", `The desktop did not start: ${why}.`, "try session_start again");
      let mask: Masker;
      try {
        mask = this.hooks.maskFor(thread);
      } catch (e) {
        throw new ToolError(
          "failed",
          `The node could not read this session's secrets to scrub its recording (${(e as Error).message}).`,
          "try again; if it keeps failing, check the node's log",
        );
      }
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
      const session = new Session(display, x, { id: newId(), thread, cwd, purpose, mask, kind: "linux_desktop" });
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

  async sessionEnd(thread: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No desktop session is open.", "nothing to end");
    this.sessions.delete(thread);
    return this.close(session);
  }

  /** Ends a session already out of the map, and tells the hub. */
  private async close(session: Session): Promise<Record<string, unknown>> {
    session.logStep("session_end", {}, true);
    await session.close();
    this.releaseLease(session.id);
    const note = session.note() ? `${session.note()}; ${NO_RECORDING}` : NO_RECORDING;
    await this.report(session, "recorded", { endedAt: new Date().toISOString(), note });
    return { sessionId: session.id, kind: session.kind, files: [], note };
  }

  /** Tells the hub where a session is now, in its agent's name. */
  async report(session: Session, state: BrowserSessionState, extra: { endedAt?: string; note?: string } = {}): Promise<void> {
    try {
      await hubCall(
        this.node,
        "browser_session",
        {
          threadId: session.thread,
          sessionId: session.id,
          kind: session.kind,
          purpose: session.purpose.slice(0, 200) || "a desktop session",
          state,
          control: session.control(),
          startedAt: session.startedAt,
          files: [],
          credentialsFilled: 0,
          ...extra,
        },
        { threadId: session.thread, cwd: session.cwd },
      );
    } catch (e) {
      console.warn(`desktop session ${session.id} not reported to the hub: ${(e as Error).message}`);
    }
  }

  /** The agent's `desktop` action, on its live session. Refused while a person has control; the first after a handback
   * gives the desktop back to the agent. */
  async act(thread: string, call: DesktopCall): Promise<Record<string, unknown>> {
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No desktop session is open.", "start one with session_start kind linux_desktop");
    switch (session.control()) {
      case "human":
        throw new ToolError(
          "invalid",
          "A person has control of this desktop.",
          "carry on with what you can without it; once they hand it back, take a screenshot first: they may have changed things",
        );
      case "handing_back":
        session.setControl("agent", "agent");
        session.logStep("agent_resumed", {}, true);
        void this.report(session, "live");
    }
    if (session.kind === "mac" && session.observing() && !observes(call)) await this.takeLease(session);
    try {
      return await session.act(call);
    } catch (e) {
      throw new ToolError("failed", (e as Error).message, "check the action's arguments, take a screenshot, and try again");
    }
  }

  /** An agent's `request_takeover`: the hub lists it under "waiting on you". */
  async requestTakeover(thread: string, reason: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No desktop session is open.", "start one with session_start");
    await hubCall(this.node, "browser_takeover", { sessionId: session.id, reason }, { threadId: thread, cwd: session.cwd });
    session.logStep("request_takeover", { reason }, true);
    return {
      message:
        "Asked: it shows under waiting on you. Carry on with what you can; while a person has control your desktop actions answer so, and after they hand it back take a screenshot first.",
    };
  }

  /** Who holds the Mac's lease, in a line for the others; undefined while nobody does. */
  heldBy(): string | undefined {
    const holder = this.lease === undefined ? undefined : this.byId(this.lease);
    return holder ? this.describe(holder) : undefined;
  }

  /** The lease's holder `session`, in a line for the others. */
  private describe(session: Session): string {
    if (session.control() === "human") return `a person has taken it over ("${session.purpose}")`;
    return `another agent's session "${session.purpose}" holds it (idle ${Math.floor(session.idleFor() / 60_000)} min; it ends after ${MAC_IDLE_MINUTES} min idle)`;
  }

  /** `session_start` kind mac: the Mac's screen, leased to this session if nobody holds it, else observed. */
  async macStart(thread: string, cwd: string, purpose: string): Promise<Record<string, unknown>> {
    if (!macEnabled(this.mac)) {
      throw new ToolError(
        "failed",
        "This machine lends no Mac screen: it is off in its node.json, or this isn't a Mac.",
        "say so in your result: an admin turns the Mac screen on, on the Mac's page in Settings › Hub › Machines",
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

  /** Opens a Mac screen session on `screen`, holding the lease if nobody does, else observing. */
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
    let mask: Masker;
    try {
      mask = this.hooks.maskFor(thread);
    } catch (e) {
      await lent.drop();
      throw new ToolError(
        "failed",
        `The node could not read this session's secrets to scrub its recording (${(e as Error).message}).`,
        "try again; if it keeps failing, check the node's log",
      );
    }
    // A holder whose session is gone holds nothing.
    const heldBy = this.heldBy();
    const session = new Session(lent, screen, { id, thread, cwd, purpose, mask, kind: "mac", observing: heldBy !== undefined });
    if (heldBy === undefined) this.lease = id;
    this.sessions.set(thread, session);
    session.open();
    session.logStep("session_start", { purpose, kind: "mac", observing: heldBy !== undefined }, true, heldBy);
    void this.report(session, "live");
    return { sessionId: id, desktop: "mac", ...(heldBy ? { heldBy: heldBy.slice(0, 300) } : {}), startMs: session.offsetMs() };
  }

  /** Before an action of an observing session that acts on the screen: takes the lease if nobody holds it, else
   * refuses with who does. */
  private async takeLease(session: Session): Promise<void> {
    const heldElsewhere = () => this.lease !== undefined && this.lease !== session.id && this.byId(this.lease) !== undefined;
    if (heldElsewhere()) {
      throw new ToolError(
        "invalid",
        `The Mac's screen is someone else's now: ${this.heldBy() ?? "another session holds it"}. You can observe it meanwhile: screenshot, cursor_position, wait and agent-desktop's reading commands (snapshot, find, get, is, list-apps).`,
        "carry on with what you can without it and try again later; once it's free, your next action takes it",
      );
    }
    const gate = this.macGate();
    if (gate) {
      throw new ToolError("failed", `The Mac's screen can't be lent now: ${gate.message}.`, "say so in your result, with what a person must do at the Mac");
    }
    if (heldElsewhere()) {
      throw new ToolError("invalid", "Another session took the Mac's screen just now.", "carry on with what you can without it and try again later");
    }
    this.lease = session.id;
    session.setObserving(false);
  }

  /** A person takes a Mac screen session over: the lease is theirs through it, and whoever held it only observes. */
  private personTakesLease(session: Session): void {
    const before = this.lease;
    this.lease = session.id;
    if (before !== undefined && before !== session.id) this.byId(before)?.setObserving(true);
    session.setObserving(false);
  }

  /** A session ended: the lease is free if it held it. */
  private releaseLease(id: string): void {
    if (this.lease === id) this.lease = undefined;
  }

  /** The hub's live view for one of these sessions: false when the id isn't one of these. */
  watch(frame: BrowserWatchFrame): boolean {
    const session = this.byId(frame.sessionId);
    if (!session) return false;
    if (!frame.on) session.setWatcher(undefined);
    else if (session.watched()) session.setBudget(frame.kbps);
    else session.setWatcher({ kbps: frame.kbps, send: (f) => void toHub(this.node, { t: "browser_frame", ...f }) });
    return true;
  }

  input(frame: BrowserInputFrame): boolean {
    const session = this.byId(frame.sessionId);
    if (!session) return false;
    session.queueInput(frame.input);
    return true;
  }

  /** A person takes a session over, or hands it back; the hub hears who drives, changed or not. */
  control(frame: BrowserControlFrame): boolean {
    const session = this.byId(frame.sessionId);
    if (!session) return false;
    const to: BrowserControlTo = frame.control;
    const now = session.control();
    if (to === "human" && now !== "human") {
      if (session.kind === "mac") this.personTakesLease(session);
      session.setControl("human", frame.by);
    }
    else if (to === "agent" && now === "human") session.setControl("handing_back", frame.by);
    void this.report(session, "live");
    return true;
  }

  endScreen(thread: string, id: string): boolean {
    if (this.sessions.get(thread)?.id !== id) return false;
    this.ended(thread);
    return true;
  }

  /** The agent session ended: its desktop session ends too. */
  ended(thread: string): void {
    const session = this.sessions.get(thread);
    if (!session) return;
    this.sessions.delete(thread);
    session.logStep("agent_session_ended", {}, true);
    void this.close(session);
  }

  /** Ends sessions idle past the limit. */
  async housekeep(): Promise<void> {
    const linux = 60_000 * (this.config.idleMinutes ?? IDLE_MINUTES);
    const mac = 60_000 * MAC_IDLE_MINUTES;
    for (const [thread, session] of [...this.sessions]) {
      if (session.idleFor() >= (session.kind === "mac" ? mac : linux) && session.control() === "agent") {
        console.info(`desktop session ${session.id} idle; ending it`);
        this.sessions.delete(thread);
        await this.close(session);
      }
    }
  }

  /** Ends every live session and every warm display (the node stops). */
  async shutdown(): Promise<void> {
    clearInterval(this.housekeeping);
    for (const [thread, session] of [...this.sessions]) {
      this.sessions.delete(thread);
      await this.close(session);
    }
    if (this.prep.kind === "ready") for (const d of this.prep.pool.drain()) await d.drop();
  }
}

/** What a desktop session's end says while the Bun node records none. */
export const NO_RECORDING = "no recording: the Bun node records none yet";

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

/** The agents' Mac's screen as the heartbeat's host line reads it (hosts.rs `mac_screen`): on in node.json on a Mac,
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
