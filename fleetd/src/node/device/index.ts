// Android sessions: an agent opens one with `session_start` kind
// android. The node lends it a booted `-read-only` copy of its Android emulator from a warm pool (emulator.ts), points
// the agent's agent-device at the copy's serial (agent_device.ts) and records the screen through scrcpy's stream
// (scrcpy.ts) as a browser session's video; `session_end` throws the copy away. The session shares the browser
// sessions' action log, recording format, upload and hub storage (node/browser/record.ts); the kind router
// (router.ts) sends each call of an android session here.
//
// Live view and takeover: the hub's `browser_watch`, `browser_input` and `browser_control` for an android session come
// here (live.ts); the browser's own go on to the broker.
//
// A screen hosted here for another machine takes `device` steps (work.ts): the hub's install of a PR's build into a
// person's screen, each step opened by session routing from what the hub sealed with the screen's relay key.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AndroidHealth, BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserCallFrame, BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame } from "../../shared/screens_wire.ts";
import { CAP_SESSION_ANDROID } from "../../shared/node_link.ts";
import type { ThreadItem } from "../../shared/sessions.ts";
import { GIVE_UP_MS, giveUp, readMeta, report, Steps, upload, waitingIn } from "../browser/record.ts";
import { hubCall, type Node, toHub } from "../browser/node.ts";
import { router as sessionRoute } from "../session_route/index.ts";
import { writeAtomic } from "../secrets/files.ts";
import { agentEnv, binDir, findAgentDevice, install as installAgentDevice, pluginDir, release, writeConfig, VERSION as AGENT_DEVICE_VERSION } from "./agent_device.ts";
import { killLeftovers, Pool } from "./emulator.ts";
import { deviceInput, Pump } from "./live.ts";
import { type Answer, router, type Screens } from "./router.ts";
import { Stream } from "./scrcpy.ts";
import { deviceDir, findSdk, install as installSdk, kvm, type KvmCheck, PINS, type Sdk, sdkAt, supported } from "./sdk.ts";
import { recordingsDir, Session, type StreamStarter } from "./session.ts";
import { commandLine, type DeviceCall, type DeviceDone, isHostKey, ranDone, ranOutput, RUN_WAIT, Work } from "./work.ts";

/** A session no tool call touched this long is ended (node.json `screenIdleMinutes`, else 30). */
const IDLE_MINUTES = 30;

/** node.json's `device`: `enabled` true opts this machine in (the first android start installs), false turns it off. */
export type DeviceConfig = { enabled?: boolean };

const enabled = (config: DeviceConfig) => config.enabled !== false && supported();
const optedIn = (config: DeviceConfig) => config.enabled === true;

/** What the install left for the doctor between heartbeats: `<device dir>/state.json`. */
type InstallState = { installing: boolean; failed?: string };
const statePath = (home: string) => join(deviceDir(home), "state.json");

function readState(home: string): InstallState {
  try {
    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as Partial<InstallState>;
    return { installing: state.installing === true, ...(typeof state.failed === "string" ? { failed: state.failed } : {}) };
  } catch {
    return { installing: false };
  }
}

function writeState(home: string, state: InstallState): void {
  try {
    mkdirSync(dirname(statePath(home)), { recursive: true });
    writeAtomic(statePath(home), JSON.stringify({ installing: state.installing, failed: state.failed ?? null }));
  } catch {
    // The doctor reads the next one.
  }
}

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Whether a command the agent ran drove its device. */
export const drivesDevice = (command: string) => command.includes("agent-device");

const cut = (text: string) => [...text].slice(0, 500).join("");

/**
 * Whether android sessions can run here, for the doctor (each heartbeat): undefined where they are off, or neither
 * installed nor opted in.
 */
export function health(home: string, config: DeviceConfig, kvmCheck: KvmCheck = kvm): AndroidHealth | undefined {
  const installed = findSdk(home) !== undefined && findAgentDevice(home) !== undefined;
  if (!enabled(config) || !(installed || optedIn(config))) return undefined;
  const of = (state: AndroidHealth["state"], message: string, fix?: string): AndroidHealth => ({
    state,
    message: cut(message),
    ...(fix ? { fix: cut(fix) } : {}),
  });
  const k = kvmCheck();
  if ("err" in k) return of("unavailable", k.err.why, k.err.fix);
  if (installed) return of("ready", `Android screens are ready: ${PINS}, agent-device ${AGENT_DEVICE_VERSION}.`);
  const state = readState(home);
  if (state.installing) {
    return of("installing", "Installing the Android emulator for screens (about 2 GB), then booting it once to save its snapshot.");
  }
  if (state.failed) {
    return of("unavailable", `Installing the Android emulator failed: ${state.failed}. The next android session_start tries again.`);
  }
  return of("wanted", "KVM works; the Android emulator installs when an agent first asks for an Android screen.");
}

/** What the node lists at its link's hello for android sessions. */
export function capabilities(home: string, config: DeviceConfig, kvmCheck: KvmCheck = kvm): string[] {
  return health(home, config, kvmCheck)?.state === "ready" ? [CAP_SESSION_ANDROID] : [];
}

type Install = { at: "ready"; pool: Pool } | { at: "wanted" } | { at: "installing" } | { at: "missing"; why: string };

export type DevicesOptions = {
  kvm?: KvmCheck;
  /** How a session's stream starts: scrcpy's, or a test's. */
  stream?: StreamStarter;
  /** How the install runs: the pinned downloads, or a test's. */
  install?: (home: string) => Promise<Sdk>;
  /** The warm pool's size. */
  warm?: number;
};

/** The node's android sessions. */
export class Devices implements Screens {
  private install: Install = { at: "wanted" };
  /** Live sessions by the agent session they belong to: one each. */
  private readonly sessions = new Map<string, Session>();
  /** Agent sessions whose `session_start` is under way: a second one is refused until it answers. */
  private readonly starting = new Set<string>();
  private readonly uploading = new Set<string>();
  readonly steps = new Steps();
  private readonly pumps = new Map<string, { pump: Pump; stop: () => void }>();
  /** The sessions with a finger down: a move counts as a drag only then. */
  private readonly pressed = new Set<string>();
  private readonly housekeeping: Timer;
  private readonly kvm: KvmCheck;

  constructor(
    private readonly node: Node,
    private readonly config: DeviceConfig,
    private readonly options: DevicesOptions = {},
  ) {
    this.kvm = options.kvm ?? kvm;
    const killed = killLeftovers(sdkAt(node.home));
    if (killed > 0) console.info(`${killed} emulators a stopped node left running were killed`);
    // The node stopped during an install; the next session that asks starts it again.
    if (readState(node.home).installing) writeState(node.home, { installing: false });
    this.readyIfInstalled();
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
  }

  private get home(): string {
    return this.node.home;
  }

  /** Makes the pool when the install is there and KVM opens, unless it is made. */
  private readyIfInstalled(): void {
    if (this.install.at === "ready" || "err" in this.kvm()) return;
    const sdk = findSdk(this.home);
    if (sdk && findAgentDevice(this.home)) this.ready(sdk);
  }

  /** Makes the pool and starts filling it. */
  ready(sdk: Sdk): void {
    const pool = new Pool(sdk, this.options.warm ?? 1, this.kvm);
    pool.refill();
    this.install = { at: "ready", pool };
    this.onReady?.();
  }

  /** Told when sessions start answering here (the node core's hello lists them from then on). */
  onReady: (() => void) | undefined;

  /** Whether sessions start here now: installed, with KVM opening. Only then do agents get agent-device. */
  usable(): boolean {
    return this.install.at === "ready" && "ok" in this.kvm();
  }

  /** Whether agents get agent-device: where sessions start, or the machine is opted in (an install finishes meanwhile). */
  offered(): boolean {
    return optedIn(this.config) || this.usable();
  }

  /** Starts installing what is missing, once. */
  private beginInstall(): void {
    if (this.install.at !== "wanted" && this.install.at !== "missing") return;
    this.install = { at: "installing" };
    writeState(this.home, { installing: true });
    void (async () => {
      try {
        if (!findAgentDevice(this.home)) await installAgentDevice(this.home);
        const sdk = await (this.options.install ?? ((home: string) => installSdk(home, this.kvm)))(this.home);
        writeState(this.home, { installing: false });
        this.ready(sdk);
      } catch (e) {
        const why = (e as Error).message;
        console.warn(`android emulator not installed: ${why}`);
        writeState(this.home, { installing: false, failed: why });
        this.install = { at: "missing", why };
      }
    })();
  }

  private pool(): Pool {
    const k = this.kvm();
    if ("err" in k) {
      throw new ToolError(
        "failed",
        `This machine can't run the Android emulator: ${k.err.why}`,
        k.err.fix ? `say so in your result: a person must run \`${k.err.fix}\` on this machine` : "say so in your result: a person must fix this machine",
      );
    }
    this.readyIfInstalled();
    if (this.install.at !== "ready" && !optedIn(this.config)) {
      throw new ToolError(
        "failed",
        "This machine isn't set up for Android sessions.",
        'say so in your result: a person opts a machine in with "device": {"enabled": true} in its node.json (fleetd docs: Android sessions)',
      );
    }
    // A failed install is tried again by the next session that asks.
    if (this.install.at === "missing") this.install = { at: "wanted" };
    this.beginInstall();
    const install = this.install as Install;
    switch (install.at) {
      case "ready":
        return install.pool;
      case "missing":
        throw new ToolError(
          "failed",
          `This machine has no Android emulator for sessions: ${install.why}.`,
          "say so in your result: a person must look at this machine's node log",
        );
      default:
        throw new ToolError(
          "failed",
          "This machine is still installing its Android emulator (about 2 GB, then one cold boot).",
          "try session_start again in a few minutes, or carry on without it",
        );
    }
  }

  /** Emulators booted for the next sessions. */
  warm(): number {
    return this.install.at === "ready" ? this.install.pool.warm() : 0;
  }

  count(): number {
    return this.sessions.size;
  }

  session(thread: string): Session | undefined {
    return this.sessions.get(thread);
  }

  live(thread: string): { id: string; kind: "android" } | undefined {
    const s = this.sessions.get(thread);
    return s ? { id: s.id, kind: "android" } : undefined;
  }

  byId(id: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  async handle(thread: string, frame: BrowserCallFrame): Promise<Answer> {
    switch (frame.call.op) {
      case "session_start":
        return { op: "session_start", ...(await this.sessionStart(thread, frame.cwd, String(frame.call.purpose ?? "an Android session"))) };
      case "session_end":
        return { op: "session_end", ...(await this.sessionEnd(thread)) };
      case "device":
        return { op: "device", ...(await this.device(thread, frame.call as unknown as DeviceCall)) };
      default:
        throw new ToolError("invalid", `${frame.call.op} is not available in Android sessions yet.`, "do without it and say so in your result");
    }
  }

  /**
   * An agent-device command, or a file it reads, for a screen this machine hosts for another (work.ts): the hub's
   * install of a PR's build into a person's screen. Run by the node's own wrapper on that screen's emulator alone, in
   * the screen's folder, and logged as an agent's command is; a person's control holds it back as the wrapper holds a
   * local one.
   */
  async device(thread: string, call: DeviceCall): Promise<DeviceDone> {
    if (!isHostKey(thread)) {
      throw new ToolError("invalid", "device steps are for an Android screen hosted for another machine", "run agent-device yourself");
    }
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No Android session is open.", "start one with session_start kind android");
    const work = new Work(this.home, thread);
    if (call.step !== "run") {
      session.touch();
      return work.step(call);
    }
    const args = Array.isArray(call.args) ? call.args.map(String) : [];
    work.check(args);
    const started = performance.now();
    const ran = await work.run(join(binDir(this.home), "agent-device"), agentEnv(this.home, thread, process.env.PATH), args, RUN_WAIT);
    session.step("agent-device", { command: commandLine(args) }, ran.exitCode === 0, ranOutput(ran), Math.round(performance.now() - started));
    return ranDone(ran);
  }

  private async sessionStart(thread: string, cwd: string, purpose: string): Promise<Record<string, unknown>> {
    const started = performance.now();
    if (this.starting.has(thread)) {
      throw new ToolError("invalid", "Another session_start of yours is under way.", "wait for its answer and use that session");
    }
    const open = this.sessions.get(thread);
    if (open) throw new ToolError("invalid", `Android session ${open.id} is open.`, "use it, or end it with session_end before starting another");
    // Held until the session is in the map (or the start fails): the only way in.
    this.starting.add(thread);
    try {
      const pool = this.pool();
      let lent;
      try {
        lent = await pool.take();
      } catch (e) {
        throw new ToolError("failed", `The Android emulator did not start: ${(e as Error).message}.`, "try session_start again");
      }
      const serial = lent.emulator.serial;
      try {
        writeConfig(this.home, thread, serial);
      } catch (e) {
        lent.release();
        throw new ToolError("failed", `The node could not point agent-device at the emulator: ${(e as Error).message}.`, "try session_start again");
      }
      const id = newId();
      let session: Session;
      try {
        // A host key's are what its agent's node sealed to this one; this node's own sessions' are its own.
        const secrets = sessionRoute(this.node).secretsOf(thread);
        session = Session.open(
          lent,
          pool.sdk,
          { id, thread, cwd, purpose, dir: join(recordingsDir(this.home), id), home: this.home, secrets, steps: this.steps },
          this.options.stream ?? Stream.start,
        );
      } catch (e) {
        lent.release();
        release(this.home, thread);
        throw new ToolError("failed", `The Android session did not start: ${(e as Error).message}.`, "try session_start again");
      }
      this.sessions.set(thread, session);
      session.step("session_start", { purpose, kind: "android", serial }, true, undefined, 0);
      void this.report(session, "live");
      return { sessionId: session.id, serial, startMs: Math.round(performance.now() - started) };
    } finally {
      this.starting.delete(thread);
    }
  }

  private async sessionEnd(thread: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No Android session is open.", "nothing to end");
    this.sessions.delete(thread);
    return this.close(session);
  }

  /** Ends a session already out of the map, and starts its upload. */
  private async close(session: Session): Promise<Record<string, unknown>> {
    // Out of the map but not yet ended: housekeeping's sweep leaves its recording alone until its upload has started.
    this.ending.add(session.id);
    try {
      this.unwatch(session.id);
      session.step("session_end", {}, true, undefined, 0);
      const files = await session.close();
      new Work(this.home, session.thread).remove();
      const note = session.note();
      // The end reaches the hub now, not only with the upload, which a missing or unreadable recording stops.
      void this.report(session, "uploading");
      void this.send(session.dir);
      return { sessionId: session.id, kind: "android", files: files.map(([file, bytes]) => ({ file, bytes })), ...(note ? { note } : {}) };
    } finally {
      this.ending.delete(session.id);
    }
  }

  /** Sessions out of the map whose end is still under way (their video): not yet a recording to send, nor one a
   * stopped node left. */
  private readonly ending = new Set<string>();

  private readonly hub = (thread: string, cwd: string, op: string, args: Record<string, unknown>) =>
    hubCall(this.node, op, args, { threadId: thread, cwd });

  /** Uploads a recording as the browser broker does (node/browser/record.ts); one that waited GIVE_UP_MS is lost. */
  private async send(dir: string): Promise<void> {
    if (this.uploading.has(dir)) return;
    this.uploading.add(dir);
    try {
      await upload(this.hub, dir);
    } catch (e) {
      const why = (e as Error).message;
      console.warn(`device recording ${dir}: not uploaded yet: ${why}`);
      const ended = readMeta(dir)?.endedAt;
      if (ended && Date.now() - Date.parse(ended) >= GIVE_UP_MS) await giveUp(this.hub, dir, `its upload kept failing: ${why}`).catch(() => {});
    } finally {
      this.uploading.delete(dir);
    }
  }

  /** Tells the hub where a session is now, in its agent's name. */
  private async report(session: Session, state: BrowserSessionState): Promise<void> {
    // Past live, it ended now: the hub has its end from this report, whatever becomes of its upload.
    const meta = session.meta(state === "live" ? undefined : new Date().toISOString());
    try {
      await this.hub(session.thread, session.cwd, "browser_session", report(meta, state, session.control(), []));
    } catch (e) {
      console.warn(`device ${session.id}: not reported to the hub: ${(e as Error).message}`);
    }
  }

  /** Every minute: ends sessions idle past the limit, and sends the recordings still waiting for the hub. */
  async housekeep(now = Date.now()): Promise<void> {
    const idle = (Number(this.node.config.screenIdleMinutes) || IDLE_MINUTES) * 60_000;
    for (const [thread, session] of [...this.sessions]) {
      if (session.idleFor(now) >= idle && session.control() === "agent") {
        console.info(`android session ${session.id} idle; ending it`);
        this.sessions.delete(thread);
        await this.close(session).catch(() => {});
      }
    }
    // A recording a stopped node left (this one's or a Rust node's) is ended and sent too.
    const live = [...this.sessions.values()].map((s) => s.id).concat([...this.ending]);
    for (const dir of waitingIn(recordingsDir(this.home), live, now)) await this.send(dir);
  }

  /** Ends the agent session's screen `id` if it is open here; whether it was. */
  endScreen(thread: string, id: string): boolean {
    if (this.sessions.get(thread)?.id !== id) return false;
    this.ended(thread);
    return true;
  }

  /** The agent session ended: its emulator goes now and the recording to the hub, not after the idle timeout. */
  ended(thread: string): void {
    const session = this.sessions.get(thread);
    if (!session) return;
    this.sessions.delete(thread);
    session.step("agent_session_ended", {}, true, undefined, 0);
    void this.close(session).catch(() => {});
  }

  /**
   * A finished `agent-device` command of a session with a live device: a line in its action log. The first after a
   * person handed the device back gives it to the agent again.
   */
  item(thread: string, item: ThreadItem): void {
    const kind = item.kind;
    if (kind.type !== "command" || (item.status !== "completed" && item.status !== "failed") || !drivesDevice(kind.command)) return;
    const session = this.sessions.get(thread);
    if (!session) return;
    const end = item.completedAt ? Date.parse(item.completedAt) : Number.NaN;
    const durationMs = Number.isNaN(end) ? 0 : Math.max(end - Date.parse(item.startedAt), 0);
    const ok = item.status === "completed" && (kind.exitCode === undefined || kind.exitCode === 0);
    session.step("agent-device", { command: kind.command }, ok, kind.output, durationMs);
    if (session.control() === "handing_back") {
      session.setControl("agent", "agent");
      void this.report(session, "live");
    }
  }

  /** Each live session's latest step, for the heartbeat. */
  stepsNow(): { sessionId: string; step: unknown }[] {
    return this.steps.list();
  }

  // ---- live view ----

  /** Starts or stops sending a session's screen to the hub; a watch already on takes the new budget. */
  watch(frame: BrowserWatchFrame): void {
    const session = this.byId(frame.sessionId);
    if (!session) return;
    const on = this.pumps.get(session.id);
    if (!frame.on) return this.unwatch(session.id);
    if (on) {
      on.pump.kbps = frame.kbps;
      return;
    }
    const pump = new Pump(session.id, () => session.control(), (f) => toHub(this.node, { t: "browser_frame", ...f }), frame.kbps);
    const stop = session.watch((f) => pump.offer(f));
    this.pumps.set(session.id, { pump, stop });
  }

  private unwatch(id: string): void {
    const on = this.pumps.get(id);
    if (!on) return;
    on.stop();
    on.pump.stop();
    this.pumps.delete(id);
  }

  input(frame: BrowserInputFrame): void {
    const session = this.byId(frame.sessionId);
    if (!session) return;
    const pressed = { down: this.pressed.has(session.id) };
    const input = deviceInput(frame.input as BrowserInput, pressed);
    if (input && !session.input(input)) console.debug(`device ${session.id}: input not delivered`);
    if (pressed.down) this.pressed.add(session.id);
    else this.pressed.delete(session.id);
  }

  /** A person takes the device, or hands it back; the hub waits to hear who drives, changed or not. */
  control(frame: BrowserControlFrame): void {
    const session = this.byId(frame.sessionId);
    if (!session) return;
    const to: BrowserControlTo = frame.control;
    const now = session.control();
    const next: BrowserControl = to === "human" ? "human" : now === "human" ? "handing_back" : now;
    this.pressed.delete(session.id);
    session.setControl(next, frame.by);
    void this.report(session, "live");
  }

  /** The agent's environment for agent-device: the wrapper first on PATH, where agents get it. */
  env(thread: string, path?: string): [string, string][] {
    return this.offered() ? agentEnv(this.home, thread, path) : [];
  }

  pluginDirs(): string[] {
    const dir = pluginDir(this.home);
    return this.offered() && existsSync(join(dir, ".claude-plugin")) ? [dir] : [];
  }

  /** Ends every live session (the node stops); their recordings go at the node's next start. */
  async shutdown(): Promise<void> {
    clearInterval(this.housekeeping);
    for (const id of [...this.pumps.keys()]) this.unwatch(id);
    const all = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of all) await session.close().catch(() => {});
    if (this.install.at === "ready") this.install.pool.drain();
  }
}

/** The node's android sessions, where node.json leaves them on and the machine runs them; else undefined. */
export function devices(node: Node, options?: DevicesOptions): Devices | undefined {
  const config = (node.config.device ?? {}) as DeviceConfig;
  if (!enabled(config)) return undefined;
  return node.area("device.android", (n) => new Devices(n, config, options));
}

/** Chains a hub frame's handler: an android session's frame comes here, any other goes on to the one before. */
function before(node: Node, tag: "browser_watch" | "browser_input" | "browser_control", mine: (f: Record<string, unknown>) => boolean): void {
  const link = node.area("link");
  const earlier = link.handler(tag);
  link.on(tag, (frame, ctx) => {
    if (!mine(frame as Record<string, unknown>)) earlier?.(frame, ctx);
  });
}

/** Wires the android sessions into the node (Rust `Devices::start`): the kind router, the hub's frames, the heartbeat. */
export function start(node: Node, options?: DevicesOptions): Devices | undefined {
  const d = devices(node, options);
  if (!d) return undefined;
  router(node).android = d;
  const ours = (f: Record<string, unknown>) => d.byId(String(f.sessionId)) !== undefined;
  before(node, "browser_watch", (f) => ours(f) && (d.watch(f as unknown as BrowserWatchFrame), true));
  before(node, "browser_input", (f) => ours(f) && (d.input(f as unknown as BrowserInputFrame), true));
  before(node, "browser_control", (f) => ours(f) && (d.control(f as unknown as BrowserControlFrame), true));
  node.area("items").on((thread, item) => d.item(thread, item));
  const config = (node.config.device ?? {}) as DeviceConfig;
  const kvmCheck = options?.kvm ?? kvm;
  // An agent's claude gets agent-device's wrapper first on its PATH, pointed at its emulator, and its skill.
  node.area("launch").contribute({ env: (thread, path) => d.env(thread, path), pluginDirs: () => d.pluginDirs() });
  // Listed only while a start really answers here: the pool is made and KVM opens. An install that finishes later
  // links again with it.
  const caps = node.area("caps");
  caps.contribute(() => (d.usable() ? [CAP_SESSION_ANDROID] : []));
  d.onReady = () => caps.changed();
  node.area("hb").contribute((hb) => {
    hb.steps.push(...d.stepsNow());
    hb.busy.screens = (hb.busy.screens ?? 0) + d.count();
    const android = health(node.home, config, kvmCheck);
    if (hb.load && android) (hb.load as Record<string, unknown>).android = android;
  });
  return d;
}

/** Stops the android sessions as the node stops. */
export async function stop(node: Node): Promise<void> {
  await router(node).android?.shutdown();
}

