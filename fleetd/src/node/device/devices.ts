// Agents' Android sessions with nothing of the machine's, for a holder with no node (fleetd cloud): each agent's
// emulator runs in its own box, and so does everything that needs adb, scrcpy or ffmpeg (../place/box_emulator.ts,
// ./android_part.mjs). What comes in is a `DeviceHost`: the hub's calls, the frames to the hub, the session's secrets,
// the agent's box, where recordings go. Nothing is spawned, read or written here: the box does it through its own calls,
// and frames (JPEGs) and the box's word are what come out of it. A node's own Android sessions are ./index.ts.
//
// It answers `session_start` and `session_end` of kind android, the agent's finished `agent-device` commands (each a
// step of its session's action log), the hub's `browser_watch`, `browser_input` and `browser_control` for its sessions
// (live view and takeover, as ./live.ts has them on a node), and the heartbeat's latest steps. A session no step
// touched for the idle limit ends, unless a person has it.
//
// Each session's recording goes through the host's RecordingStore (../browser/recording.ts), as a browser session's
// does: its action log, kept here and scrubbed of the agent session's secrets, never in the box; its video from the
// part's frames.
//
// A new holder (another instance of a service) takes a live session over from its `snapshot` with `adopt`: the box's
// part waits its grace for a new connection, and the session goes on as it was. A person who had control keeps it: the
// box's control file is written again and the holder's own state says `human` until they hand it back. A part that
// can't be reached again ends the session with a plain note, and control goes back to the agent. What a takeover
// guards holds only against the agent's own driver (../place/box_emulator.ts says what does not).
import type { BrowserAction, BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserCallFrame, BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame, SessionEndFrame } from "../../shared/screens_wire.ts";
import type { ThreadItem } from "../../shared/sessions.ts";
import { jpegSize } from "../browser/fit.ts";
import { type Meta, type Recording, type RecordingStore, report, Steps } from "../browser/recording.ts";
import { Scrub } from "../mask.ts";
import {
  agentToolsIn,
  type AndroidBox,
  BOX_PLUGIN_DIR,
  boxAgentEnv,
  bootIn,
  controlIn,
  dialPart,
  type PartEvents,
  type PartHandle,
  type PartLink,
  pointAgent,
  releaseAgent,
  SERIAL,
  startPart,
  stopEmulator,
  stopPart,
  timing,
} from "../place/box_emulator.ts";
import { deviceInput, Pump } from "./live.ts";
import { type Frame, messages } from "./scrcpy_wire.ts";

/** A session no step touched this long ends (DeviceHost `idleMinutes`, else 30). */
const IDLE_MINUTES = 30;
/** How long a `session_start` waits for its box's emulator before it says to come back, within the call's own wait. */
const BOOT_WAIT_MS = 50_000;
/** The start of a result's text the action log keeps. */
const RESULT_CHARS = 500;

export { type AndroidBox, ANDROID_SIZE } from "../place/box_emulator.ts";

/** What Android sessions need of where they run. */
export type DeviceHost = {
  /** A lead call to the hub in a session's name: its result, or its refusal thrown (a ToolError). */
  call(op: string, args: Record<string, unknown>, opts: { threadId?: string; cwd?: string; waitMs?: number }): Promise<Record<string, unknown>>;
  /** A frame to the hub: a watched session's `browser_frame`. */
  send(frame: { t: string } & Record<string, unknown>): void;
  /** The agent session's own secrets, which its recording is scrubbed of. */
  secrets(thread: string): [string, string][];
  /** The box the agent session's emulator runs in: its own, unless `agentBox` says otherwise; `starting` while made. */
  inBox(thread: string): AndroidBox | "starting" | undefined;
  /**
   * The box the agent session's claude runs in, when its emulator runs in another (`inBox`: a host that gives an agent
   * whose own box is too small for the emulator a box of its own for it). agent-device, adb and the files they read (its
   * config, the person's takeover) are there; its adb's server is the emulator box's, which the host relays to this
   * box's ADB_SERVER_PORT. Absent, or undefined: the same box as `inBox`.
   */
  agentBox?(thread: string): AndroidBox | undefined;
  /** Where recordings go. */
  recordings: RecordingStore;
  /** The idle limit: a session no step touched this long ends. */
  idleMinutes?: () => number;
  /** A session changed in what its `snapshot` holds (it started, changed hands, ended). */
  changed?: (thread: string) => void;
  /** How long a start waits for the box's emulator before it says to come back (a test's own). */
  bootWaitMs?: number;
};

/**
 * What carries a session to another holder (`snapshot`, `adopt`): plain JSON. It holds the part's token, which lets
 * whoever has it watch the device and drive it through the box's loopback: whoever stores a snapshot seals it, as a
 * session's secret (the cloud's row is sealed under the team's key). It holds none of the agent session's secrets.
 */
export type DeviceSnapshot = {
  v: 1;
  id: string;
  thread: string;
  cwd: string;
  purpose: string;
  startedAt: string;
  /** Steps logged so far: the next holder's go on from here. */
  seq: number;
  control: BrowserControl;
  note?: string;
  /** The box's part: where it listens in the box, and its token (a credential: see above). */
  part: PartHandle;
};

/** One open session. */
type Open = {
  id: string;
  thread: string;
  cwd: string;
  purpose: string;
  startedAt: string;
  seq: number;
  control: BrowserControl;
  note?: string;
  part: PartHandle;
  box: AndroidBox;
  /** Where the agent's agent-device and its files are (DeviceHost `agentBox`): `box` itself, unless the host says. */
  agent: AndroidBox;
  recording: Recording;
  scrub: Scrub;
  touched: number;
  link?: PartLink;
  newest?: Frame;
  size?: [number, number];
  pump?: Pump;
  pressed: boolean;
  ticker?: Timer;
  /** Set once it ends or this holder lets go: a late frame or drop starts nothing. */
  over: boolean;
  /** Redials in a row, each waiting longer (`backoff`), and when the last connection came up. */
  redials: number;
  linkedAt: number;
};

/** How long a redial waits after a dropped connection: from `firstMs`, doubling each time in a row, at most `maxMs`.
 * A connection that stayed up `steadyMs` starts the count again (a test's own, each). */
export const redialing = { firstMs: 250, maxMs: 30_000, steadyMs: 30_000 };

/** The wait before the `n`th redial in a row (0 for the first). */
export const backoff = (n: number) => Math.min(redialing.firstMs * 2 ** Math.min(n, 20), redialing.maxMs);

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Whether a command the agent ran drove its device. */
export const drivesDevice = (command: string) => command.includes("agent-device");

/** Why a session whose box's screen went ends, in the agent's and the person's words. */
export const goneNote = (why: string) => `the Android screen in the box went: ${why}`;

const noBox = () => new ToolError("failed", "Android screens run only in an agent's box, and this session has none.", "say so in your result: a person can check the bot's computer");

export class AndroidSessions {
  private readonly sessions = new Map<string, Open>();
  /** Agent sessions whose `session_start` is under way: a second one is refused until it answers. */
  private readonly starting = new Set<string>();
  /** Boots under way in agents' boxes, by agent session: a start that came back before it was done finds it here. */
  private readonly booting = new Map<string, Promise<unknown>>();
  /** Sessions out of the map whose end is still under way: not yet a recording the sweep may send. */
  private readonly ending = new Set<string>();
  readonly steps = new Steps();
  private readonly housekeeping: Timer;
  private lettingGo = false;
  private reports: Promise<void> = Promise.resolve();

  constructor(private readonly host: DeviceHost) {
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
  }

  count(): number {
    return this.sessions.size;
  }

  live(thread: string): { id: string; kind: "android" } | undefined {
    const s = this.sessions.get(thread);
    return s ? { id: s.id, kind: "android" } : undefined;
  }

  /** Who drives agent session `thread`'s device, while it has one. */
  controlOf(thread: string): BrowserControl | undefined {
    return this.sessions.get(thread)?.control;
  }

  private byId(id: string): Open | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  /** The agent's environment for agent-device in its box: the wrapper first on PATH, its home, its control file. */
  env(thread: string, path?: string): [string, string][] {
    return boxAgentEnv(thread, path);
  }

  /** agent-device's skill, as a plugin in the box (there once ../place/box_emulator.ts `toolsScript` ran). */
  pluginDirs(): string[] {
    return [BOX_PLUGIN_DIR];
  }

  async handle(thread: string, frame: BrowserCallFrame): Promise<Record<string, unknown>> {
    switch (frame.call.op) {
      case "session_start":
        return { op: "session_start", ...(await this.start(thread, frame.cwd, String(frame.call.purpose ?? "an Android session"))) };
      case "session_end":
        return { op: "session_end", ...(await this.end(thread)) };
      default:
        throw new ToolError("invalid", `${frame.call.op} is not available in Android sessions yet.`, "do without it and say so in your result");
    }
  }

  /**
   * `session_start`: the box's emulator boots, the first time there after fetching the pinned pieces (about two
   * minutes in all). That is longer than a call may wait, so the boot goes on by itself and a start that comes back
   * before it is done says so; the next one, once it booted, opens the session on it.
   */
  async start(thread: string, cwd: string, purpose: string): Promise<Record<string, unknown>> {
    const box = this.host.inBox(thread);
    if (!box) throw noBox();
    if (box === "starting") throw new ToolError("invalid", "Your sandbox is still starting.", "try session_start again in a moment");
    if (this.starting.has(thread)) throw new ToolError("invalid", "Another session_start of yours is under way.", "wait for its answer and use that session");
    const open = this.sessions.get(thread);
    if (open) throw new ToolError("invalid", `Android session ${open.id} is open.`, "use it, or end it with session_end before starting another");
    const started = performance.now();
    this.starting.add(thread);
    try {
      let pending = this.booting.get(thread);
      if (!pending) {
        const agent = this.agentOf(thread, box);
        pending = agent === box ? bootIn(box) : Promise.all([bootIn(box), agentToolsIn(agent)]).then(([booted]) => booted);
        pending.catch(() => {});
        this.booting.set(thread, pending);
      }
      const done = await Promise.race([
        pending.then(
          () => ({ ok: true as const }),
          (e: unknown) => ({ e: e as Error }),
        ),
        Bun.sleep(this.host.bootWaitMs ?? BOOT_WAIT_MS).then(() => undefined),
      ]);
      if (!done) {
        throw new ToolError(
          "failed",
          "The Android emulator is starting in your sandbox: the first time there it fetches the emulator and boots it, about two minutes.",
          "call session_start kind android again in a minute; it carries on meanwhile",
        );
      }
      this.booting.delete(thread);
      if ("e" in done) throw new ToolError("failed", `The Android emulator did not start in your sandbox: ${done.e.message}.`, "do without it and say so in your result");
      return await this.openOn(thread, cwd, purpose, box, started);
    } finally {
      this.starting.delete(thread);
    }
  }

  private async openOn(thread: string, cwd: string, purpose: string, box: AndroidBox, started: number): Promise<Record<string, unknown>> {
    const id = newId();
    let part: PartHandle;
    const agent = this.agentOf(thread, box);
    try {
      await pointAgent(agent, thread);
      part = await startPart(box, id);
    } catch (e) {
      throw new ToolError("failed", `The Android session did not start in your sandbox: ${(e as Error).message}.`, "try session_start again");
    }
    const startedAt = new Date().toISOString();
    const meta: Meta = { sessionId: id, kind: "android", threadId: thread, cwd, purpose, startedAt, credentialsFilled: 0 };
    let recording: Recording;
    try {
      recording = await this.host.recordings.open(meta);
    } catch (e) {
      await stopPart(box, id);
      throw new ToolError("failed", `The Android session's recording didn't start: ${(e as Error).message}`, "try session_start again in a moment");
    }
    const entry = this.entry({ id, thread, cwd, purpose, startedAt, seq: 0, control: "agent", part }, box, agent, recording);
    this.sessions.set(thread, entry);
    this.step(entry, "session_start", { purpose, kind: "android", serial: SERIAL }, true, undefined, 0);
    // The stream connects in the background: the agent's first command needn't wait for it.
    void this.connect(entry).catch((e: Error) => this.addNote(entry, `no video or live view: ${e.message}`));
    await this.report(entry, "live");
    return { sessionId: id, serial: SERIAL, startMs: Math.round(performance.now() - started) };
  }

  /** Where agent session `thread`'s agent-device is: the host's `agentBox`, else the emulator's `box`. */
  private agentOf(thread: string, box: AndroidBox): AndroidBox {
    return this.host.agentBox?.(thread) ?? box;
  }

  private entry(s: Omit<DeviceSnapshot, "v">, box: AndroidBox, agent: AndroidBox, recording: Recording): Open {
    const entry: Open = {
      ...s,
      box,
      agent,
      recording,
      scrub: new Scrub(this.host.secrets(s.thread)),
      touched: Date.now(),
      pressed: false,
      over: false,
      redials: 0,
      linkedAt: 0,
    };
    entry.ticker = setInterval(() => entry.recording.video?.tick(this.offsetMs(entry)), 1_000);
    return entry;
  }

  /** Milliseconds since the session started, whoever held it: the recording's clock. */
  private offsetMs(entry: Open): number {
    return Math.max(Date.now() - Date.parse(entry.startedAt), 0);
  }

  private addNote(entry: Open, note: string): void {
    entry.note = entry.note === undefined ? note : `${entry.note}; ${note}`;
    this.host.changed?.(entry.thread);
  }

  /** Dials the session's part, its frames into the recording and to whoever watches. */
  private async connect(entry: Open, ms?: number): Promise<void> {
    const events: PartEvents = {
      frame: (seq, jpeg) => {
        if (entry.over) return;
        const size = jpegSize(jpeg);
        if (!size) return;
        entry.size = size;
        const frame: Frame = { seq, jpeg, width: size[0], height: size[1], atMs: this.offsetMs(entry) };
        entry.newest = frame;
        entry.recording.video?.frame(jpeg, frame.atMs);
        entry.pump?.offer(frame);
      },
      note: (text) => {
        if (!entry.over) this.addNote(entry, `no video or live view: ${text}`);
      },
      closed: () => {
        // Before the dial answered, `link` isn't this connection's yet: the dial's own caller hears of it.
        if (entry.over || this.lettingGo || link === undefined || entry.link !== link) return;
        entry.link = undefined;
        void this.redial(entry);
      },
    };
    let link: PartLink | undefined;
    link = await dialPart(entry.box, entry.part, events, ms);
    if (entry.over || this.lettingGo) return void link.drop();
    // Closed as it opened (its `closed` came before `link` was this one's): dialled again, as any drop is.
    if (!link.open) return void this.redial(entry);
    entry.link = link;
    entry.linkedAt = Date.now();
  }

  /**
   * A dropped connection to the part (the box's link redialled): dialled again within its grace, else the session
   * ends plainly, so control never stays with a person on a screen nobody shows. Each redial in a row waits longer, so
   * two holders that both think they hold the session (one the cloud didn't stop) displace each other at most every
   * `redialing.maxMs`, and a redial is no step of the agent's: it never keeps a session from its idle end.
   */
  private async redial(entry: Open): Promise<void> {
    if (Date.now() - entry.linkedAt >= redialing.steadyMs) entry.redials = 0;
    const wait = backoff(entry.redials++);
    await Bun.sleep(wait);
    if (entry.over || this.lettingGo || this.sessions.get(entry.thread) !== entry) return;
    try {
      await this.connect(entry, Math.max(timing.graceMs - wait, 1_000));
      if (entry.link) this.step(entry, "device_reconnected", { after: entry.redials }, true, undefined, 0, false);
    } catch (e) {
      if (entry.over || this.lettingGo || this.sessions.get(entry.thread) !== entry) return;
      const why = (e as Error).message;
      this.step(entry, "device_gone", { why }, false, undefined, 0);
      await this.end(entry.thread, goneNote(why)).catch(() => {});
    }
  }

  /** Logs one step: a tool call of the agent's, or fleetd's own, scrubbed of the session's secrets. */
  private step(entry: Open, tool: string, args: unknown, ok: boolean, result: string | undefined, durationMs: number, touch = true): number {
    if (touch) entry.touched = Date.now();
    const seq = ++entry.seq;
    const action: BrowserAction = {
      seq,
      at: new Date().toISOString(),
      offsetMs: Math.max(this.offsetMs(entry) - durationMs, 0),
      tool,
      args,
      ok,
      ...(result === undefined ? {} : { result: [...result].slice(0, RESULT_CHARS).join("") }),
      durationMs,
    };
    try {
      const clean = entry.scrub.value(action);
      this.steps.note(entry.recording.key ?? entry.id, entry.id, clean);
      entry.recording.append("actions", JSON.stringify(clean));
    } catch (e) {
      console.warn(`device ${entry.id}: action not logged: ${(e as Error).message}`);
    }
    return seq;
  }

  private meta(entry: Open, resumed = false): Meta {
    return {
      sessionId: entry.id,
      kind: "android",
      threadId: entry.thread,
      cwd: entry.cwd,
      purpose: entry.purpose,
      startedAt: entry.startedAt,
      credentialsFilled: 0,
      ...(entry.note !== undefined ? { note: entry.note } : {}),
      ...(resumed ? { resumed } : {}),
    };
  }

  /** Tells the hub where a session is now, in its agent's name, after what was reported before. */
  private report(entry: Open, state: BrowserSessionState): Promise<void> {
    if (state === "live") this.host.changed?.(entry.thread);
    const args = report(this.meta(entry), state, entry.control, []);
    this.reports = this.reports.then(async () => {
      try {
        await this.host.call("browser_session", args, { threadId: entry.thread, cwd: entry.cwd });
      } catch (e) {
        console.warn(`device ${entry.id}: not reported to the workspace: ${(e as Error).message}`);
      }
    });
    return this.reports;
  }

  /** The agent's `session_end`, or the hub's, or the idle limit: the stream, the part and the emulator go, and the
   * recording ends. `note`: why it ended when it didn't by itself. */
  async end(thread: string, note?: string): Promise<{ sessionId: string; kind: "android"; files: { file: string; bytes: number }[]; note?: string }> {
    const entry = this.sessions.get(thread);
    if (!entry) throw new ToolError("not_found", "No Android session is open.", "nothing to end");
    this.sessions.delete(thread);
    this.ending.add(entry.id);
    try {
      this.step(entry, "session_end", {}, true, undefined, 0);
      this.stopLocal(entry);
      entry.link?.stop();
      entry.link = undefined;
      await stopPart(entry.box, entry.id);
      await releaseAgent(entry.agent, thread);
      // The device goes with everything done in it, as a node's copy does: the next session boots a fresh one.
      await stopEmulator(entry.box);
      if (note) this.addNote(entry, note);
      const done = await entry.recording.end(
        { endedAt: new Date().toISOString(), credentialsFilled: 0, ...(entry.note ? { note: entry.note } : {}) },
        entry.scrub,
        this.offsetMs(entry),
      );
      return { sessionId: entry.id, kind: "android", files: done.files, ...(done.note ? { note: done.note } : {}) };
    } finally {
      this.ending.delete(entry.id);
      this.host.changed?.(thread);
    }
  }

  /** What this holder alone keeps of a session: its watch, its ticker. */
  private stopLocal(entry: Open): void {
    entry.over = true;
    clearInterval(entry.ticker);
    entry.pump?.stop();
    entry.pump = undefined;
  }

  /** The agent session ended: its device goes now, and a boot no start took yet, not after the idle limit. */
  ended(thread: string): void {
    const boot = this.booting.get(thread);
    const box = this.host.inBox(thread);
    if (boot) {
      this.booting.delete(thread);
      if (box && box !== "starting") void boot.then(() => stopEmulator(box), () => {});
    }
    const entry = this.sessions.get(thread);
    if (!entry) return;
    this.step(entry, "agent_session_ended", {}, true, undefined, 0);
    void this.end(thread).catch(() => {});
  }

  /** The hub ended the task of `threadId`: its screen `sessionId` goes, if it is still open here. */
  sessionEnd(frame: SessionEndFrame): void {
    if (this.sessions.get(frame.threadId)?.id === frame.sessionId) void this.end(frame.threadId).catch(() => {});
  }

  /**
   * A finished `agent-device` command of a session with a live device: a line in its action log. The first after a
   * person handed the device back gives it to the agent again.
   */
  item(thread: string, item: ThreadItem): boolean {
    const kind = item.kind;
    if (kind.type !== "command" || (item.status !== "completed" && item.status !== "failed") || !drivesDevice(kind.command)) return false;
    const entry = this.sessions.get(thread);
    if (!entry) return false;
    const end = item.completedAt ? Date.parse(item.completedAt) : Number.NaN;
    const durationMs = Number.isNaN(end) ? 0 : Math.max(end - Date.parse(item.startedAt), 0);
    const ok = item.status === "completed" && (kind.exitCode === undefined || kind.exitCode === 0);
    this.step(entry, "agent-device", { command: kind.command }, ok, kind.output, durationMs);
    if (entry.control === "handing_back") {
      entry.control = "agent";
      void this.report(entry, "live");
    }
    return true;
  }

  // ---- live view and takeover ----

  /** Starts or stops sending a session's screen to the hub; a watch already on takes the new budget. */
  watch(frame: BrowserWatchFrame): void {
    const entry = this.byId(frame.sessionId);
    if (!entry) return;
    if (!frame.on) {
      entry.pump?.stop();
      entry.pump = undefined;
      return;
    }
    if (entry.pump) {
      entry.pump.kbps = frame.kbps;
      return;
    }
    entry.pump = new Pump(entry.id, () => entry.control, (f) => this.host.send({ t: "browser_frame", ...f }), frame.kbps);
    if (entry.newest) entry.pump.offer(entry.newest);
  }

  /** A person's input, while they have control: one finger, a scroll, a key or text, to the part. */
  input(frame: BrowserInputFrame): void {
    const entry = this.byId(frame.sessionId);
    if (!entry) return;
    const pressed = { down: entry.pressed };
    const input = deviceInput(frame.input as BrowserInput, pressed);
    entry.pressed = pressed.down;
    if (!input || entry.control !== "human" || !entry.size || !entry.link?.control(messages(input, entry.size))) {
      if (input) console.debug(`device ${entry.id}: input not delivered`);
    }
  }

  /**
   * A person takes the device (`human`: the agent's `agent-device` refuses until they hand it back), or hands it back
   * (`handing_back`, until the agent's next command, then `agent`); the hub waits to hear who drives, changed or not.
   */
  control(frame: BrowserControlFrame): void {
    const entry = this.byId(frame.sessionId);
    if (!entry) return;
    const to: BrowserControlTo = frame.control;
    const before = entry.control;
    const next: BrowserControl = to === "human" ? "human" : before === "human" ? "handing_back" : before;
    entry.pressed = false;
    if (next !== before) {
      entry.control = next;
      void controlIn(entry.agent, entry.thread, next === "human").catch((e: Error) => console.warn(`device ${entry.id}: control file not written: ${e.message}`));
      if (next === "human") this.step(entry, "takeover", { by: frame.by }, true, undefined, 0);
      else if (before === "human") this.step(entry, "handback", { by: frame.by }, true, undefined, 0);
    }
    void this.report(entry, "live");
  }

  // ---- holders ----

  /** What carries agent session `thread`'s Android session to another holder; undefined for none. */
  snapshot(thread: string): DeviceSnapshot | undefined {
    const e = this.sessions.get(thread);
    if (!e) return undefined;
    return {
      v: 1,
      id: e.id,
      thread: e.thread,
      cwd: e.cwd,
      purpose: e.purpose,
      startedAt: e.startedAt,
      seq: e.seq,
      control: e.control,
      ...(e.note !== undefined ? { note: e.note } : {}),
      part: { ...e.part },
    };
  }

  /**
   * Takes over agent session `thread`'s Android session from the holder before (`snapshot`): its box's part dialled
   * again, recording on from there, control as it was (a person's takeover written again in the box). A part that
   * went meanwhile (its grace ran out, or its box) ends the session plainly instead: its recording ends with a note and
   * control goes back to the agent. Throws for a snapshot it can't read, and when the recording store refuses to go on
   * (the part then waits on in its grace, for a try again).
   */
  async adopt(thread: string, snapshot: DeviceSnapshot): Promise<{ adopted: true; sessionId: string } | { adopted: false; note: string }> {
    if (snapshot?.v !== 1 || snapshot.thread !== thread || !snapshot.part || typeof snapshot.id !== "string") {
      throw new Error("not an Android session's snapshot for this agent session");
    }
    const held = this.sessions.get(thread);
    if (held) return { adopted: true, sessionId: held.id };
    const inBox = this.host.inBox(thread);
    const box = inBox && inBox !== "starting" ? inBox : undefined;
    const { v: _, ...state } = snapshot;
    let recording: Recording;
    const base: Meta = {
      sessionId: state.id,
      kind: "android",
      threadId: thread,
      cwd: state.cwd,
      purpose: state.purpose,
      startedAt: state.startedAt,
      credentialsFilled: 0,
      ...(state.note !== undefined ? { note: state.note } : {}),
      resumed: true,
    };
    try {
      recording = await this.host.recordings.open(base);
    } catch (e) {
      throw new Error(`the Android session's recording didn't go on: ${(e as Error).message}`);
    }
    let why = "its box is gone";
    const agent = box ? this.agentOf(thread, box) : undefined;
    const entry = this.entry(state, box ?? ({} as AndroidBox), agent ?? ({} as AndroidBox), recording);
    if (box) {
      try {
        await this.connect(entry, timing.reachMs);
      } catch (e) {
        why = (e as Error).message;
      }
    }
    if (!entry.link) {
      // A screen that isn't there to drive: the session ends now, recorded as far as it went, with the agent driving.
      const note = goneNote(`${why}, while it moved to another server`);
      this.stopLocal(entry);
      entry.control = "agent";
      this.step(entry, "device_gone", { why }, false, undefined, 0);
      if (box) {
        await controlIn(agent!, thread, false).catch(() => {});
        await stopPart(box, entry.id);
        await releaseAgent(agent!, thread);
        await stopEmulator(box);
      }
      this.addNote(entry, note);
      await recording.end({ endedAt: new Date().toISOString(), credentialsFilled: 0, note: entry.note ?? note }, entry.scrub, this.offsetMs(entry));
      this.host.changed?.(thread);
      return { adopted: false, note };
    }
    this.sessions.set(thread, entry);
    // What a takeover guards is put back as it was, never reset: the box's control file, written again.
    await controlIn(agent!, thread, entry.control === "human").catch((e: Error) => console.warn(`device ${entry.id}: control file not written: ${e.message}`));
    this.step(entry, "device_adopted", {}, true, undefined, 0);
    await this.report(entry, "live");
    return { adopted: true, sessionId: entry.id };
  }

  /**
   * Lets go of every session without ending one (this holder stops, or lost the team): each connection to its part
   * drops, which waits in its box for the next holder's `adopt`. Nothing is reported or recorded.
   */
  letGo(): void {
    this.lettingGo = true;
    clearInterval(this.housekeeping);
    for (const entry of this.sessions.values()) {
      this.stopLocal(entry);
      entry.link?.drop();
    }
    this.sessions.clear();
  }

  private housekeepingNow = false;

  /** Every minute: ends sessions idle past the limit (none a person has), and sends the recordings still to go. */
  async housekeep(now = Date.now()): Promise<void> {
    if (this.housekeepingNow || this.lettingGo) return;
    this.housekeepingNow = true;
    try {
      const idle = (this.host.idleMinutes?.() ?? IDLE_MINUTES) * 60_000;
      for (const [thread, entry] of [...this.sessions]) {
        if (entry.control !== "human" && now - entry.touched >= idle) {
          this.step(entry, "idle", { minutes: idle / 60_000 }, true, undefined, 0);
          await this.end(thread).catch(() => {});
        }
      }
      const live = [...this.sessions.values()].map((e) => e.id).concat([...this.ending]);
      await this.host.recordings.sweep?.(live, now);
    } finally {
      this.housekeepingNow = false;
    }
  }

  /** Each live session's latest step, for the heartbeat. */
  stepsNow(): { sessionId: string; step: unknown }[] {
    return this.steps.list();
  }

  /** Ends every live session. */
  async shutdown(): Promise<void> {
    clearInterval(this.housekeeping);
    for (const thread of [...this.sessions.keys()]) await this.end(thread).catch(() => {});
  }
}
