// An agent's iOS simulator as a screen of its own, on the agents' Mac: a
// simulator `mac sim start` lends shows in Screens as "iPhone 17 · T12", for the agent's project, and a person watches
// it live, takes it over and hands it back there, as they do an Android screen. It never touches the Mac's shared
// desktop and takes no desktop lease: its frames are the simulator's own screenshots (screen.ts), and a person's input
// goes through the agent's own agent-device daemon.
//
// The hub made the screen with the step that lent the simulator (hub/mac_tool: a place on the Mac in the agent's name,
// its key and session id in the `mac_call`). The Mac reports it under that key, as a machine reports a session it
// hosts for an agent elsewhere, and sends its recording the same way (node/browser/record.ts): its action log (the
// agent's agent-device jobs, a person's takeover, hand-back and commands) and its video, `simctl io recordVideo`'s,
// from the first time someone watches until it ends. Nobody watching: no screenshots, no video. The screen ends with
// its simulator (`mac sim end`, or 30 minutes without a step).
//
// A node that stops lets its screens go without ending them (`letGo`): the simulator, its video's recordVideo and a
// person's control file run on, and the next node opens each again under the same ids (`resume`), its log and video
// going on where they were.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserAction, BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../../shared/contracts.ts";
import {
  RECORDING_FILES,
  type BrowserControlFrame,
  type BrowserInputFrame,
  type BrowserWatchFrame,
  type ScreenControlFrame,
  type ScreenControlResult,
  type SimScreen as SimScreenKey,
} from "../../../shared/screens_wire.ts";
import { ToolError } from "../../../shared/errors.ts";
import { appendAction, files as recordedFiles, GIVE_UP_MS, giveUp, type HubCall, type Meta, readMeta, report, Scrub, Steps, upload, waitingIn, writeMeta } from "../../browser/record.ts";
import { mkdirPrivate } from "../../config.ts";
import { deviceInput, Pump } from "../live.ts";
import type { Frame, Input } from "../scrcpy.ts";
import { ensureHelper, stream } from "../../screen/mac_frames.ts";
import { Hands, type Live, type Ran, type Runner, Shooter, type Shoot } from "./screen.ts";
import { recordingStarted, type Simctl } from "./simctl.ts";
import type { SimDevice } from "./controls.ts";
import { iosDir } from "./wrapper.ts";

/** The start of a result's text the action log keeps. */
const RESULT_CHARS = 500;
/** recordVideo finishes its file within moments of SIGINT; this allows a loaded Mac. */
const FINISH_VIDEO = 20_000;
/** recordVideo says it started within a second or two; a screen that ends sooner waits this long for it at most. */
const START_VIDEO = 15_000;
/** How often the recording's file is looked at, to see it has started. */
const FILE_POLL = 250;

/** Where the Mac keeps simulator screens' recordings until the hub has them. */
export const recordingsDir = (home: string) => join(iosDir(home), "recordings");

/** A screen's name in Screens: the device without its runtime, and the agent ("iPhone 17 · T12"). */
export const screenName = (device: string, agent: string) => `${device.split(" on ")[0]} · ${agent}`;

/**
 * A running recording of the simulator's screen: `finish` stops it and says why there is no video, if there is none.
 * `pid`: its recordVideo's, which runs on past the node, for the next node to finish (`resumeRecording`).
 */
export type Recording = { finish(): Promise<string | undefined>; pid?: number };

/** What a screen does to its simulator: a screenshot, a recording, an agent-device command. Simctl's, or a test's. */
export type SimTools = {
  /** `display`: the lit panel of a simulator with two (controls.ts `SimDevice.display`). */
  shoot(udid: string, display?: string): Promise<Uint8Array>;
  /** The screen as a stream of frames, where the Mac can make one. */
  live?: (udid: string) => Live;
  /** `display` as `shoot`'s: a Duo's video is of the panel lit when it starts. */
  record(udid: string, path: string, display?: string): Recording;
  /** The recording the node before started, by its recordVideo's pid, while it still runs. */
  resume?: (pid: number, path: string) => Recording | undefined;
  run?: (runner: Runner, args: string[]) => Promise<Ran>;
};

/** Whether the recording's file, `before` and `now` (undefined while it isn't there), shows it recording. */
export const fileGrowing = (before: number | undefined, now: number | undefined) => before !== undefined && now !== undefined && now > before && now > 0;

const sizeOf = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * `simctl io recordVideo` (`argv`), in a process group of its own so SIGINT reaches simctl through xcrun, and so it
 * records on when the node stops. Its output goes to a file beside the video, never a pipe: simctl writing to a pipe
 * no node reads any more would die of SIGPIPE before it finished the video. It is stopped only once it has started: a
 * SIGINT before then kills it with no file. Started is when it says "Recording started", or else when its file is
 * there and growing.
 */
export function startRecording(argv: string[], path: string, saysStarted: (line: string) => boolean): Recording {
  mkdirSync(dirname(path), { recursive: true });
  const log = `${path}.log`;
  const fd = openSync(log, "w");
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: fd, stderr: fd, detached: true });
  } finally {
    closeSync(fd);
  }
  let exited = false;
  void child.exited.then(() => (exited = true));
  let started = false;
  let before: number | undefined;
  const poll = setInterval(() => {
    const now = sizeOf(path);
    if (fileGrowing(before, now)) started = true;
    before = now;
    try {
      if (readFileSync(log, "utf8").split("\n").some(saysStarted)) started = true;
    } catch {
      // Not written yet.
    }
    if (started) clearInterval(poll);
  }, FILE_POLL);
  return recordingOf(child.pid, path, () => started, () => exited, () => clearInterval(poll));
}

/**
 * The recordVideo a stopped node left recording into `path`, by its pid: only while that pid is still a recordVideo
 * of `path` (`command` reads a pid's command line), not another process given the pid since.
 */
export function resumeRecording(pid: number, path: string, command: (pid: number) => string | undefined = commandOf): Recording | undefined {
  const line = alive(pid) ? command(pid) : undefined;
  if (!line?.includes("recordVideo") || !line.includes(path)) return undefined;
  return recordingOf(pid, path, () => true, () => !alive(pid));
}

/** A pid's command line, as ps prints it. */
function commandOf(pid: number): string | undefined {
  const out = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return out.success ? out.stdout.toString().trim() : undefined;
}

/** Finishing the recordVideo `pid` heads the group of: SIGINT once it has `started`, and its file once it is `gone`. */
function recordingOf(pid: number, path: string, started: () => boolean, gone: () => boolean, done = () => {}): Recording {
  return {
    pid,
    async finish() {
      const deadline = Date.now() + START_VIDEO;
      while (!started() && !gone() && Date.now() < deadline) await Bun.sleep(FILE_POLL);
      done();
      try {
        process.kill(-pid, "SIGINT");
      } catch {
        // Gone already.
      }
      const until = Date.now() + FINISH_VIDEO;
      while (!gone() && Date.now() < until) await Bun.sleep(FILE_POLL);
      if (!gone()) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Gone meanwhile.
        }
        return "simctl did not finish the video in 20 s";
      }
      if ((sizeOf(path) ?? 0) > 0) return undefined;
      return started() ? "simctl wrote no video" : "simctl's recording never started";
    },
  };
}

/** The tools on the Mac's own simulators: fleetd-frames' stream (built beside `shots`), simctl's screenshot (through a
 * file in `shots`) and recordVideo. */
export function simctlTools(simctl: Simctl, shots: string): SimTools {
  const frames = join(dirname(shots), "frames");
  // Built as the Mac's node starts (~10 s, once per source), not as the first person watches.
  if (process.platform === "darwin") {
    void ensureHelper(frames).catch((e: Error) => console.warn(`iOS live view: screenshots until fleetd-frames builds: ${e.message}`));
  }
  return {
    live: (udid) => (onFrame) => stream(frames, ["sim", simctl.set, udid], onFrame),
    async shoot(udid, display) {
      mkdirSync(shots, { recursive: true });
      const to = join(shots, `${udid}.jpg`);
      await simctl.screenshot(udid, to, display);
      return new Uint8Array(await Bun.file(to).arrayBuffer());
    },
    record: (udid, path, display) =>
      startRecording(
        simctl.argv(["io", udid, "recordVideo", "--codec=h264", ...(display ? [`--display=${display}`] : []), "--force", path]),
        path,
        recordingStarted,
      ),
    resume: (pid, path) => resumeRecording(pid, path),
  };
}

/** What opens a screen: the hub's key and id for it, and the simulator it shows. */
export type Opened = {
  screen: SimScreenKey;
  /** The agent holding the simulator, as the Mac names its folder (its task, else its session). */
  agent: string;
  udid: string;
  /** "iPhone 17 on iOS 27.0". */
  device: string;
  /** The screen's pixels per point. */
  scale: number;
  /** How a person's commands run: the wrapper, with the agent's agent-device home. */
  runner: Runner;
  /** The file whose presence makes the agent's agent-device refuse while a person has control. */
  controlFile: string;
  /** The node's home: the screen's recording goes under it. */
  home: string;
  steps: Steps;
  /** Told when what the next node needs to resume the screen changes (its video started). */
  changed?: () => void;
  /** A screen the node before left (SimScreens `resume`): when it started, and its video, still recording. */
  resumed?: { startedAt: string; recording?: Recording };
  /** Its device controls (controls.ts), and its orientation, fold and appearance as they last went. */
  dev?: SimDevice;
  /** Who it is for in its name, when not the agent: a person's own simulator ("iPhone Duo · Ada"). */
  label?: string;
};

/** What the next node needs to open a screen again (SimScreens `resume`), kept with its simulator (sims.ts). */
export type KeptScreen = { sessionId: string; hostKey: string; startedAt: string; video?: number };

/** One simulator's screen. */
export class SimScreen {
  readonly id: string;
  readonly hostKey: string;
  readonly agent: string;
  readonly udid: string;
  readonly purpose: string;
  readonly dir: string;
  readonly startedAt: string;
  readonly start: number;
  private readonly controlFile: string;
  private readonly steps: Steps;
  private readonly changed: () => void;
  readonly dev: SimDevice | undefined;
  private readonly scrub = new Scrub([]);
  private readonly shooter: Shooter;
  private readonly hands: Hands;
  private readonly watchers = new Set<(frame: Frame) => void>();
  private recording: Recording | undefined;
  private controlNow: BrowserControl = "agent";
  private noteText: string | undefined;
  private seq = 0;
  private closed = false;
  /** The newest frame, while someone watches. */
  newest: Frame | undefined;

  constructor(
    opened: Opened,
    private readonly tools: SimTools,
  ) {
    this.id = opened.screen.sessionId;
    this.hostKey = opened.screen.hostKey;
    this.agent = opened.agent;
    this.udid = opened.udid;
    this.purpose = screenName(opened.device, opened.label ?? opened.agent);
    this.dev = opened.dev;
    this.dir = join(recordingsDir(opened.home), this.id);
    this.controlFile = opened.controlFile;
    this.steps = opened.steps;
    this.changed = opened.changed ?? (() => {});
    const resumed = opened.resumed;
    this.startedAt = resumed?.startedAt ?? new Date().toISOString();
    // A resumed screen's log and video go on from its start, as the node before counted it.
    this.start = performance.now() - (resumed ? Math.max(Date.now() - Date.parse(resumed.startedAt), 0) : 0);
    if (resumed) {
      this.recording = resumed.recording;
      this.seq = logged(this.dir);
      // A person who had taken it over still has it: the control file ran on with the agent's agent-device held back.
      if (existsSync(this.controlFile)) this.controlNow = "human";
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.writeMeta();
    const shoot: Shoot = () => tools.shoot(this.udid, this.dev?.display());
    // The stream follows a foldable's lit panel by itself (fleetd-frames shows the panel whose framebuffer changed last);
    // a screenshot names it.
    this.shooter = new Shooter(shoot, this.start, () => this.watchers.size > 0, (frame) => this.frame(frame), Bun.sleep, tools.live?.(this.udid));
    this.hands = new Hands(opened.runner, opened.scale, (args, ran) => this.step("agent-device", { command: `agent-device ${args.join(" ")}`, by: "person" }, ran.ok, ran.ok ? undefined : ran.said, ran.ms), tools.run);
  }

  offsetMs(): number {
    return Math.round(performance.now() - this.start);
  }

  /** What the next node needs to open this screen again. */
  kept(): KeptScreen {
    const video = this.recording?.pid;
    return { sessionId: this.id, hostKey: this.hostKey, startedAt: this.startedAt, ...(video !== undefined ? { video } : {}) };
  }

  note(): string | undefined {
    return this.noteText;
  }

  private setNote(note: string): void {
    this.noteText = this.noteText === undefined ? note : `${this.noteText}; ${note}`;
  }

  meta(endedAt?: string): Meta {
    return {
      sessionId: this.id,
      kind: "ios",
      threadId: this.hostKey,
      cwd: "/",
      purpose: this.purpose,
      startedAt: this.startedAt,
      ...(endedAt ? { endedAt } : {}),
      credentialsFilled: 0,
      ...(this.noteText !== undefined ? { note: this.noteText } : {}),
    };
  }

  private writeMeta(endedAt?: string): void {
    try {
      writeMeta(this.dir, this.meta(endedAt));
    } catch (e) {
      console.warn(`iOS screen ${this.id}: session file not written: ${(e as Error).message}`);
    }
  }

  private frame(frame: Frame): void {
    if (this.closed) return;
    // A new watcher starts from a whole picture: an H.264 frame alone is none.
    if (!frame.video) this.newest = frame;
    for (const watcher of this.watchers) watcher(frame);
  }

  /** H.264 from now on (every watcher decodes it) within `kbps`, or JPEG: whether that switched. */
  want(video: boolean, kbps: number | undefined): boolean {
    return this.shooter.want(video, kbps);
  }

  /** A watcher lost an H.264 frame: the screen now as a JPEG, then H.264 from a keyframe. */
  key(): void {
    this.shooter.key();
  }

  /**
   * Each new frame of the screen to `fn` (the newest so far at once), until the returned function is called. The first
   * watcher starts the video, which runs until the screen ends.
   */
  watch(fn: (frame: Frame) => void): () => void {
    if (this.closed) return () => {};
    this.watchers.add(fn);
    if (this.newest) fn(this.newest);
    if (!this.recording) {
      try {
        this.recording = this.tools.record(this.udid, join(this.dir, RECORDING_FILES.video_mp4.name), this.dev?.display());
        this.changed();
      } catch (e) {
        this.recording = { finish: async () => undefined };
        this.setNote(`no video: ${(e as Error).message}`);
      }
    }
    this.shooter.run();
    return () => {
      this.watchers.delete(fn);
      // Nobody watches: the next watcher starts from a fresh screenshot.
      if (this.watchers.size === 0) this.newest = undefined;
    };
  }

  watched(): boolean {
    return this.watchers.size > 0;
  }

  /** A person's input, while they have control: false when it can't go. */
  input(input: Input): boolean {
    if (this.controlNow !== "human" || this.closed) return false;
    return this.hands.send(input);
  }

  control(): BrowserControl {
    return this.controlNow;
  }

  /**
   * Who drives the simulator: a person takes it (`human`: the agent's agent-device refuses until they hand it back),
   * or hands it back (`handing_back`, until the agent's next agent-device job, then `agent`). Logged as a step.
   */
  setControl(control: BrowserControl, by: string): void {
    const before = this.controlNow;
    this.controlNow = control;
    if (before === control) return;
    if (control === "human") {
      try {
        mkdirPrivate(dirname(this.controlFile));
        writeFileSync(this.controlFile, "human\n");
      } catch (e) {
        console.warn(`iOS screen ${this.id}: control file not written: ${(e as Error).message}`);
      }
      this.step("takeover", { by }, true, undefined, 0);
    } else {
      rmSync(this.controlFile, { force: true });
      if (before === "human") {
        this.hands.release();
        this.step("handback", { by }, true, undefined, 0);
      }
    }
  }

  /** Logs one step: an agent's agent-device job, a person's command, or fleetd's own. */
  step(tool: string, args: unknown, ok: boolean, result: string | undefined, durationMs: number): void {
    const action: BrowserAction = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      offsetMs: Math.max(this.offsetMs() - durationMs, 0),
      tool,
      args,
      ok,
      ...(result === undefined ? {} : { result: [...result].slice(0, RESULT_CHARS).join("") }),
      durationMs,
    };
    try {
      appendAction(this.dir, action, this.scrub, this.steps, this.id);
    } catch (e) {
      console.warn(`iOS screen ${this.id}: action not logged: ${(e as Error).message}`);
    }
  }

  /** Stops the live view and a person's queue, finishes the video and gives the agent its agent-device back. */
  async close(note?: string): Promise<[string, number][]> {
    if (this.closed) return recordedFiles(this.dir);
    this.letGo();
    if (note !== undefined) this.setNote(note);
    rmSync(this.controlFile, { force: true });
    const why = await this.recording?.finish();
    if (why) {
      rmSync(join(this.dir, RECORDING_FILES.video_mp4.name), { force: true });
      this.setNote(`no video: ${why}`);
    }
    this.writeMeta(new Date().toISOString());
    return recordedFiles(this.dir);
  }

  /** Stops the live view and a person's queue, and nothing else: the node stops, and the next resumes the screen. */
  letGo(): void {
    this.closed = true;
    this.shooter.stop();
    this.hands.stop();
    this.watchers.clear();
    this.newest = undefined;
  }
}

/** How many steps a screen's log holds. */
function logged(dir: string): number {
  try {
    return readFileSync(join(dir, RECORDING_FILES.actions.name), "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

/** What the screens tell the hub: a lead call in a screen's name (its host key), and a frame. */
export type ScreensLink = { hub: HubCall; send: (frame: { t: string } & Record<string, unknown>) => void };

/** The Mac's simulator screens, one for each simulator agents hold that the hub made a screen for. */
export class SimScreens {
  private readonly screens = new Map<string, SimScreen>();
  readonly steps = new Steps();
  private readonly pumps = new Map<string, { pump: Pump; stop: () => void }>();
  /** The screens with a finger down: a move counts as a drag only then. */
  private readonly pressed = new Set<string>();
  private readonly uploading = new Set<string>();
  /** Screens closing: their recording isn't one a stopped node left. */
  private readonly ending = new Set<string>();
  /** Told when what the next node needs to resume a screen changes (sims.ts keeps it). */
  changed: () => void = () => {};
  /** A person used the agent's simulator (its input or a control): it isn't idle. */
  used: ((agent: string) => void) | undefined;

  constructor(
    private readonly home: string,
    private readonly link: ScreensLink,
    private readonly tools: SimTools,
  ) {}

  /** The agent's screen, while it has one. */
  of(agent: string): SimScreen | undefined {
    return this.screens.get(agent);
  }

  byId(id: string): SimScreen | undefined {
    for (const s of this.screens.values()) if (s.id === id) return s;
    return undefined;
  }

  count(): number {
    return this.screens.size;
  }

  /** Opens the screen of a simulator just lent, and tells the hub it is live. */
  open(opened: Omit<Opened, "home" | "steps">): SimScreen | undefined {
    if (this.screens.has(opened.agent)) return this.screens.get(opened.agent);
    let screen: SimScreen;
    try {
      screen = new SimScreen({ ...opened, home: this.home, steps: this.steps, changed: () => this.changed() }, this.tools);
    } catch (e) {
      console.warn(`the iOS simulator ${opened.udid} has no screen: ${(e as Error).message}`);
      return undefined;
    }
    this.screens.set(opened.agent, screen);
    screen.step("sim_start", { device: opened.device, udid: opened.udid }, true, undefined, 0);
    void this.report(screen, "live");
    return screen;
  }

  /**
   * Opens again the screen a stopped node left (`kept`), of a simulator its agent still holds: the same ids and
   * folder, its log going on, its video too while the recordVideo the node before started runs, and live again at the
   * hub, which watches it again once the node links.
   */
  resume(opened: Omit<Opened, "home" | "steps">, kept: KeptScreen): SimScreen | undefined {
    if (this.screens.has(opened.agent)) return this.screens.get(opened.agent);
    const video = join(recordingsDir(this.home), kept.sessionId, RECORDING_FILES.video_mp4.name);
    const recording = kept.video !== undefined ? this.tools.resume?.(kept.video, video) : undefined;
    let screen: SimScreen;
    try {
      screen = new SimScreen(
        {
          ...opened,
          screen: { sessionId: kept.sessionId, hostKey: kept.hostKey },
          home: this.home,
          steps: this.steps,
          changed: () => this.changed(),
          resumed: { startedAt: kept.startedAt, ...(recording ? { recording } : {}) },
        },
        this.tools,
      );
    } catch (e) {
      console.warn(`the iOS simulator ${opened.udid} has no screen: ${(e as Error).message}`);
      return undefined;
    }
    // Its video ended with the node before: a new one starts at the next watch, over it.
    if (kept.video !== undefined && !recording) screen.step("video_lost", {}, false, "the video's recording ended with the node's restart", 0);
    this.screens.set(opened.agent, screen);
    screen.step("sim_resumed", { udid: opened.udid }, true, undefined, 0);
    void this.report(screen, "live");
    return screen;
  }

  /** The agent's simulator went: its screen ends (with `note`, why), and its recording goes to the hub. */
  async close(agent: string, note?: string): Promise<void> {
    const screen = this.screens.get(agent);
    if (!screen) return;
    this.screens.delete(agent);
    this.ending.add(screen.id);
    try {
      this.unwatch(screen.id);
      this.pressed.delete(screen.id);
      screen.step("sim_end", {}, true, undefined, 0);
      await screen.close(note);
      // The end reaches the hub now, not only with the upload, which a missing or unreadable recording stops.
      await this.report(screen, "uploading");
      void this.send(screen.dir);
    } finally {
      this.ending.delete(screen.id);
    }
  }

  /** An agent's job on the Mac ended: a line in its screen's log when it drove agent-device, and the simulator is the
   * agent's again after a person handed it back. */
  ran(agent: string, command: string, ok: boolean, durationMs: number): void {
    const screen = this.screens.get(agent);
    if (!screen || !command.includes("agent-device")) return;
    screen.step("agent-device", { command }, ok, undefined, durationMs);
    if (screen.control() === "handing_back") {
      screen.setControl("agent", "agent");
      void this.report(screen, "live");
    }
  }

  async report(screen: SimScreen, state: BrowserSessionState): Promise<void> {
    const meta = screen.meta(state === "live" ? undefined : new Date().toISOString());
    const device = state === "live" ? screen.dev?.report() : undefined;
    try {
      await this.link.hub(screen.hostKey, "/", "browser_session", { ...report(meta, state, screen.control(), []), ...(device ? { device } : {}) });
    } catch (e) {
      console.warn(`iOS screen ${screen.id}: not reported to the hub: ${(e as Error).message}`);
    }
  }

  /** Uploads a recording as the browser broker does; one that waited GIVE_UP_MS is lost. */
  private async send(dir: string): Promise<void> {
    if (this.uploading.has(dir)) return;
    this.uploading.add(dir);
    try {
      await upload(this.link.hub, dir);
    } catch (e) {
      const why = (e as Error).message;
      console.warn(`iOS screen recording ${dir}: not uploaded yet: ${why}`);
      const ended = readMeta(dir)?.endedAt;
      if (ended && Date.now() - Date.parse(ended) >= GIVE_UP_MS) await giveUp(this.link.hub, dir, `its upload kept failing: ${why}`).catch(() => {});
    } finally {
      this.uploading.delete(dir);
    }
  }

  /** Sends the recordings still waiting for the hub, a stopped node's among them. */
  async housekeep(now = Date.now()): Promise<void> {
    const live = [...this.screens.values()].map((s) => s.id).concat([...this.ending]);
    for (const dir of waitingIn(recordingsDir(this.home), live, now)) await this.send(dir);
  }

  // ---- live view ----

  /** Starts or stops sending a screen to the hub; a watch already on takes the new budget. */
  watch(frame: BrowserWatchFrame): void {
    const screen = this.byId(frame.sessionId);
    if (!screen) return;
    if (!frame.on) return this.unwatch(screen.id);
    const switched = screen.want(frame.video === true, frame.kbps);
    const on = this.pumps.get(screen.id);
    if (on) {
      on.pump.kbps = frame.kbps;
      // A new H.264 watcher (the hub's `key`), a lost frame, or a switch to H.264: the screen now, then a keyframe. A
      // JPEG watcher that may be new gets the newest picture; a budget told again costs nothing more.
      if (frame.key || (switched && frame.video)) return screen.key();
      if (!frame.video && screen.newest) on.pump.offer(screen.newest);
      return;
    }
    const pump = new Pump(screen.id, () => screen.control(), (f) => this.link.send({ t: "browser_frame", ...f }), frame.kbps);
    const stop = screen.watch((f) => pump.offer(f));
    this.pumps.set(screen.id, { pump, stop });
  }

  private unwatch(id: string): void {
    const on = this.pumps.get(id);
    if (!on) return;
    on.stop();
    on.pump.stop();
    this.pumps.delete(id);
  }

  input(frame: BrowserInputFrame): void {
    const screen = this.byId(frame.sessionId);
    if (!screen) return;
    const pressed = { down: this.pressed.has(screen.id) };
    const input = deviceInput(frame.input as BrowserInput, pressed);
    this.used?.(screen.agent);
    if (input && !screen.input(input)) console.debug(`iOS screen ${screen.id}: input not delivered`);
    if (pressed.down) this.pressed.add(screen.id);
    else this.pressed.delete(screen.id);
  }

  /**
   * A person's device control (`screen_control`): it runs while they have control, is a line in the screen's log, and
   * the hub hears the device after it.
   */
  async screenControl(frame: ScreenControlFrame): Promise<ScreenControlResult> {
    const screen = this.byId(frame.sessionId);
    const refused = (message: string, fix?: string): ScreenControlResult => ({ id: frame.id, error: { code: "invalid", message, ...(fix ? { fix } : {}) } });
    if (!screen?.dev) return refused(`Screen ${frame.sessionId} has no device controls here.`);
    if (screen.control() !== "human") return refused("Take the screen over first: its controls are the person's in control.");
    this.used?.(screen.agent);
    const started = performance.now();
    try {
      const shot = await screen.dev.apply(frame.control, frame.value);
      screen.step("control", { control: frame.control, ...(frame.value === undefined ? {} : { value: frame.value }), by: frame.by }, true, undefined, Math.round(performance.now() - started));
      // The device as it is now is kept for the next node (sims.ts).
      this.changed();
      await this.report(screen, "live");
      return {
        id: frame.id,
        device: screen.dev.report(),
        ...(shot ? { screenshot: { pngB64: Buffer.from(shot.png).toString("base64"), width: shot.width, height: shot.height } } : {}),
      };
    } catch (e) {
      const error = e instanceof ToolError ? e.toJSON() : { code: "failed" as const, message: (e as Error).message };
      screen.step("control", { control: frame.control, by: frame.by }, false, error.message, Math.round(performance.now() - started));
      return { id: frame.id, error };
    }
  }

  /** A device control an agent ran (`mac sim <control>`): a line in its screen's log, and the hub hears the device. */
  controlled(agent: string, control: string, ok: boolean, why: string | undefined, durationMs: number): void {
    const screen = this.screens.get(agent);
    if (!screen) return;
    screen.step("control", { control, by: "agent" }, ok, why, durationMs);
    if (ok) void this.report(screen, "live");
  }

  /** A person takes the simulator, or hands it back; the hub waits to hear who drives, changed or not. */
  control(frame: BrowserControlFrame): void {
    const screen = this.byId(frame.sessionId);
    if (!screen) return;
    const to: BrowserControlTo = frame.control;
    const now = screen.control();
    const next: BrowserControl = to === "human" ? "human" : now === "human" ? "handing_back" : now;
    this.pressed.delete(screen.id);
    screen.setControl(next, frame.by);
    void this.report(screen, "live");
  }

  /** What the next node needs to resume each screen, by agent. */
  kept(): Map<string, KeptScreen> {
    return new Map([...this.screens].map(([agent, s]) => [agent, s.kept()]));
  }

  /** The node stops: each screen's live view stops, and the rest runs on for the next node to resume. */
  letGo(): void {
    for (const id of [...this.pumps.keys()]) this.unwatch(id);
    for (const screen of this.screens.values()) screen.letGo();
    this.screens.clear();
  }

  /** Every screen ends; their recordings go at the node's next start. */
  async shutdown(): Promise<void> {
    for (const id of [...this.pumps.keys()]) this.unwatch(id);
    const all = [...this.screens.values()];
    this.screens.clear();
    for (const screen of all) await screen.close().catch(() => {});
  }
}
