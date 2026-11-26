// An agent's iOS simulator as a screen of its own, on the agents' Mac: a
// simulator `mac sim start` lends shows in Screens as "iPhone 17 · T12", for the agent's project, and a person watches
// it live, takes it over and hands it back there, as they do an Android screen. It never touches the Mac's shared
// desktop and takes no desktop lease: its frames are the simulator's framebuffer (screen.ts), and a person's input goes
// straight into the simulator's HID service, or else through the agent's own agent-device daemon.
//
// The hub made the screen with the step that lent the simulator (hub/mac_tool: a place on the Mac in the agent's name,
// its key and session id in the `mac_call`). The Mac reports it under that key, as a machine reports a session it
// hosts for an agent elsewhere, and sends its recording the same way (node/browser/record.ts): its action log (the
// agent's agent-device jobs, a person's takeover, hand-back and commands, and each change of the display shown: a
// `device` step) and its video: the very H.264 stream the live view shows (fleetd-frames', ../../screen/mac_frames.ts),
// upright as the simulator's UI is and of the panel lit, written as it comes into a fragmented MP4 (../../screen/mp4.ts)
// from the screen's start to its end, watched or not. So a replay is what the live view was, frame for frame, on the
// action log's clock. The screen ends with its simulator (`mac sim end`, or 30 minutes without a step).
//
// A node that stops lets its screens go without ending them (`letGo`): the simulator and a person's control file run
// on, and the next node opens each again under the same ids (`resume`), its log going on and its video too, in the same
// file from its last whole frame (the seconds the node was down hold the last picture).
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
import { type Display, ensureHelper, stream } from "../../screen/mac_frames.ts";
import { Mp4Writer, resumeAt } from "../../screen/mp4.ts";
import { Hands, type Live, type Ran, type Runner, Shooter, type Shoot } from "./screen.ts";
import type { Simctl } from "./simctl.ts";
import type { SimDevice } from "./controls.ts";
import { iosDir } from "./wrapper.ts";

/** The start of a result's text the action log keeps. */
const RESULT_CHARS = 500;
/** Where the Mac keeps simulator screens' recordings until the hub has them. */
export const recordingsDir = (home: string) => join(iosDir(home), "recordings");

/** A UIDeviceOrientation as a `device` step names it. */
export function orientationName(orientation: number): "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right" {
  return orientation === 2 ? "portrait_upside_down" : orientation === 3 ? "landscape_left" : orientation === 4 ? "landscape_right" : "portrait";
}

/** A screen's name in Screens: the device without its runtime, and the agent ("iPhone 17 · T12"). */
export const screenName = (device: string, agent: string) => `${device.split(" on ")[0]} · ${agent}`;

/** What a screen does to its simulator: a screenshot, a stream, an agent-device command. Simctl's, or a test's. */
export type SimTools = {
  /** `display`: the lit panel of a simulator with two (controls.ts `SimDevice.display`). */
  shoot(udid: string, display?: string): Promise<Uint8Array>;
  /** The screen as a stream of frames, where the Mac can make one: the live view and the video. */
  live?: (udid: string) => Live;
  run?: (runner: Runner, args: string[]) => Promise<Ran>;
};

/** The tools on the Mac's own simulators: fleetd-frames' stream (built beside `shots`) and simctl's screenshot (through
 * a file in `shots`). */
export function simctlTools(simctl: Simctl, shots: string): SimTools {
  const frames = join(dirname(shots), "frames");
  // Built as the Mac's node starts (~10 s, once per source), not as the first person watches.
  if (process.platform === "darwin") {
    void ensureHelper(frames).catch((e: Error) => console.warn(`iOS live view: screenshots until fleetd-frames builds: ${e.message}`));
  }
  return {
    live: (udid) => (onFrame, onDisplay) => stream(frames, ["sim", simctl.set, udid], onFrame, onDisplay),
    async shoot(udid, display) {
      mkdirSync(shots, { recursive: true });
      const to = join(shots, `${udid}.jpg`);
      await simctl.screenshot(udid, to, display);
      return new Uint8Array(await Bun.file(to).arrayBuffer());
    },
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
  /** A screen the node before left (SimScreens `resume`): when it started. */
  resumed?: { startedAt: string };
  /** Its device controls (controls.ts), and its orientation, fold and appearance as they last went. */
  dev?: SimDevice;
  /** Who it is for in its name, when not the agent: a person's own simulator ("iPhone Duo · Ada"). */
  label?: string;
};

/** What the next node needs to open a screen again (SimScreens `resume`), kept with its simulator (sims.ts). `video`:
 * the pid of the `simctl io recordVideo` a node before this one's version recorded with. */
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
  /** The video, while the screen streams into it; its file, open for appending. */
  private video: { writer: Mp4Writer; fd: number } | undefined;
  /** The display last shown, as fleetd-frames said it: a change is a `device` step. */
  private shownDisplay: string | undefined;
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
      this.seq = logged(this.dir);
      // A person who had taken it over still has it: the control file ran on with the agent's agent-device held back.
      if (existsSync(this.controlFile)) this.controlNow = "human";
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.writeMeta();
    const live = tools.live?.(this.udid);
    if (live) this.openVideo(resumed !== undefined);
    else this.setNote("no video: this Mac can't stream the simulator's screen");
    const shoot: Shoot = () => tools.shoot(this.udid, this.dev?.display());
    // The stream shows the panel the device's pose lights (controls.ts `display`), else the one whose framebuffer
    // changed last; a screenshot names it.
    this.shooter = new Shooter(shoot, this.start, () => this.watchers.size > 0, (frame) => this.frame(frame), Bun.sleep, live, {
      keep: () => this.video !== undefined,
      panel: () => this.dev?.display(),
      onDisplay: (d) => this.displayed(d),
    });
    this.hands = new Hands(
      opened.runner,
      opened.scale,
      (args, ran, direct) =>
        direct
          ? this.step("input", { command: args.join(" "), by: "person" }, true, undefined, 0)
          : this.step("agent-device", { command: `agent-device ${args.join(" ")}`, by: "person" }, ran.ok, ran.ok ? undefined : ran.said, ran.ms),
      tools.run,
      () => this.shooter.direct(),
      () => this.shooter.directPending(),
    );
  }

  offsetMs(): number {
    return Math.round(performance.now() - this.start);
  }

  /** What the next node needs to open this screen again. */
  kept(): KeptScreen {
    return { sessionId: this.id, hostKey: this.hostKey, startedAt: this.startedAt };
  }

  /** The video's file, new, or the one a stopped node left (`resumed`), from its last whole frame on. */
  private openVideo(resumed: boolean): void {
    const path = join(this.dir, RECORDING_FILES.video_mp4.name);
    try {
      const at = resumed ? resumeAt(path) : undefined;
      const fd = openSync(path, at ? "r+" : "w", 0o600);
      // A frame cut short by the stop is let go: the file goes on from the last whole one.
      if (at) ftruncateSync(fd, at.bytes);
      let offset = at?.bytes ?? 0;
      const writer = new Mp4Writer((bytes) => {
        offset += writeSync(fd, bytes, 0, bytes.length, offset);
      }, at ? { sequence: at.sequence } : undefined);
      this.video = { writer, fd };
    } catch (e) {
      this.setNote(`no video: ${(e as Error).message}`);
    }
  }

  /** The display the stream shows changed (a turn, a fold): a `device` step, which a replay's frame follows. */
  private displayed(d: Display): void {
    const key = `${d.name} ${d.orientation} ${d.width}x${d.height}`;
    if (key === this.shownDisplay) return;
    this.shownDisplay = key;
    const model = this.purpose.split(" · ")[0];
    const fold = this.dev?.report().fold;
    this.step("device", { model, panel: d.name, orientation: orientationName(d.orientation), width: d.width, height: d.height, ...(fold ? { fold } : {}) }, true, undefined, 0);
  }

  /** The video's last frame, shown until now, and its file closed. */
  private closeVideo(): void {
    const video = this.video;
    if (!video) return;
    this.video = undefined;
    try {
      video.writer.end(this.offsetMs());
      closeSync(video.fd);
    } catch (e) {
      this.setNote(`no video: ${(e as Error).message}`);
    }
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
    if (frame.video && this.video) {
      try {
        this.video.writer.frame({ data: frame.video.data, key: frame.video.key, atMs: frame.atMs, size: frame.video.size ?? [frame.width, frame.height] });
      } catch (e) {
        console.warn(`iOS screen ${this.id}: the video stopped: ${(e as Error).message}`);
        this.closeVideo();
      }
    }
    // A new watcher starts from a whole picture: an H.264 frame alone is none.
    if (!frame.video) this.newest = frame;
    for (const watcher of this.watchers) watcher(frame);
  }

  /** H.264 from now on (every watcher decodes it) within `kbps` and `fps`, or JPEG: whether that switched. */
  want(video: boolean, kbps: number | undefined, fps?: number): boolean {
    return this.shooter.want(video, kbps, fps);
  }

  /** A watcher lost an H.264 frame: the screen now as a JPEG, then H.264 from a keyframe. */
  key(): void {
    this.shooter.key();
  }

  /** Each new frame of the screen to `fn` (the newest so far at once), until the returned function is called. */
  watch(fn: (frame: Frame) => void): () => void {
    if (this.closed) return () => {};
    this.watchers.add(fn);
    if (this.newest) fn(this.newest);
    this.shooter.run();
    return () => {
      this.watchers.delete(fn);
      // Nobody watches: the next watcher starts from a fresh screenshot, and the stream goes on for the video alone.
      if (this.watchers.size === 0) {
        this.newest = undefined;
        this.shooter.refresh();
      }
    };
  }

  /** The device's pose or orientation changed (a control ran): the stream shows the panel it now lights (a panel
   * folding away shows its own animation until then, never a stale picture of the other). */
  posed(): void {
    this.shooter.refresh();
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
    this.closeVideo();
    this.writeMeta(new Date().toISOString());
    return recordedFiles(this.dir);
  }

  /** Stops the live view and a person's queue, and nothing else: the node stops, and the next resumes the screen. */
  letGo(): void {
    this.closed = true;
    this.closeVideo();
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
   * folder, its log and its video going on, and live again at the hub, which watches it again once the node links.
   */
  resume(opened: Omit<Opened, "home" | "steps">, kept: KeptScreen): SimScreen | undefined {
    if (this.screens.has(opened.agent)) return this.screens.get(opened.agent);
    // A node of the version before recorded with simctl's recordVideo, which runs on into the same file: it stops
    // unfinished, and the video starts again from here.
    const video = join(recordingsDir(this.home), kept.sessionId, RECORDING_FILES.video_mp4.name);
    const legacy = kept.video !== undefined && stopLegacyVideo(kept.video, video);
    if (legacy) rmSync(video, { force: true });
    let screen: SimScreen;
    try {
      screen = new SimScreen(
        {
          ...opened,
          screen: { sessionId: kept.sessionId, hostKey: kept.hostKey },
          home: this.home,
          steps: this.steps,
          changed: () => this.changed(),
          resumed: { startedAt: kept.startedAt },
        },
        this.tools,
      );
    } catch (e) {
      console.warn(`the iOS simulator ${opened.udid} has no screen: ${(e as Error).message}`);
      return undefined;
    }
    if (legacy) screen.step("video_lost", {}, false, "the video before fleetd's update was let go", 0);
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
      console.warn(`iOS screen ${screen.id}: not reported to the workspace: ${(e as Error).message}`);
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
    const switched = screen.want(frame.video === true, frame.kbps, frame.fps);
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
      screen.posed();
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
    screen.posed();
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
    // A watched screen says the new control in a frame at once, still or not: a window's peer takes a person's input
    // only once the screen's newest frame says they have control (../../rtc), and a still simulator sends none of itself.
    if (next !== now && this.pumps.has(screen.id)) screen.key();
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

/** Stops the `simctl io recordVideo` a node of the version before left recording into `path` (its process group, at
 * once: it writes nothing more), only while `pid` is still that recordVideo (`command` reads a pid's command line), not
 * another process given the pid since: whether one was running. */
export function stopLegacyVideo(pid: number, path: string, command: (pid: number) => string | undefined = commandOf): boolean {
  const line = command(pid);
  if (!line?.includes("recordVideo") || !line.includes(path)) return false;
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** A pid's command line, as ps prints it. */
function commandOf(pid: number): string | undefined {
  const out = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return out.success ? out.stdout.toString().trim() : undefined;
}
