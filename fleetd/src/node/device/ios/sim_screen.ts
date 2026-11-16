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
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserAction, BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../../shared/contracts.ts";
import { RECORDING_FILES, type BrowserControlFrame, type BrowserInputFrame, type BrowserWatchFrame, type SimScreen as SimScreenKey } from "../../../shared/screens_wire.ts";
import { appendAction, files as recordedFiles, GIVE_UP_MS, giveUp, type HubCall, type Meta, readMeta, report, Scrub, Steps, upload, waitingIn, writeMeta } from "../../browser/record.ts";
import { mkdirPrivate } from "../../config.ts";
import { deviceInput, Pump } from "../live.ts";
import type { Frame, Input } from "../scrcpy.ts";
import { Hands, type Ran, type Runner, Shooter, type Shoot } from "./screen.ts";
import { recordingStarted, type Simctl } from "./simctl.ts";
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

/** A running recording of the simulator's screen: `finish` stops it and says why there is no video, if there is none. */
export type Recording = { finish(): Promise<string | undefined> };

/** What a screen does to its simulator: a screenshot, a recording, an agent-device command. Simctl's, or a test's. */
export type SimTools = {
  shoot(udid: string): Promise<Uint8Array>;
  record(udid: string, path: string): Recording;
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

/**
 * `simctl io recordVideo` (`argv`), in a process group of its own so SIGINT reaches simctl through xcrun. It is stopped
 * only once it has started: a SIGINT before then kills it with no file. Started is when it says "Recording started",
 * or else when its file is there and growing.
 */
export function startRecording(argv: string[], path: string, saysStarted: (line: string) => boolean): Recording {
  mkdirSync(dirname(path), { recursive: true });
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let started = false;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    // Read to the end, so the pipe never fills while it records.
    for await (const chunk of stream) if (!started && decoder.decode(chunk, { stream: true }).split("\n").some(saysStarted)) started = true;
  };
  void read(child.stdout).catch(() => {});
  void read(child.stderr).catch(() => {});
  let before: number | undefined;
  const poll = setInterval(() => {
    const now = sizeOf(path);
    if (fileGrowing(before, now)) started = true;
    before = now;
    if (started) clearInterval(poll);
  }, FILE_POLL);
  return {
    async finish() {
      const deadline = Date.now() + START_VIDEO;
      while (!started && child.exitCode === null && Date.now() < deadline) await Bun.sleep(FILE_POLL);
      clearInterval(poll);
      try {
        process.kill(-child.pid, "SIGINT");
      } catch {
        // Gone already.
      }
      const ended = await Promise.race([child.exited, Bun.sleep(FINISH_VIDEO).then(() => "timeout" as const)]);
      if (ended === "timeout") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Gone meanwhile.
        }
        return "simctl did not finish the video in 20 s";
      }
      if ((sizeOf(path) ?? 0) > 0) return undefined;
      return started ? "simctl wrote no video" : "simctl's recording never started";
    },
  };
}

/** The tools on the Mac's own simulators: simctl's screenshot (through a file in `shots`) and recordVideo. */
export function simctlTools(simctl: Simctl, shots: string): SimTools {
  return {
    async shoot(udid) {
      mkdirSync(shots, { recursive: true });
      const to = join(shots, `${udid}.jpg`);
      await simctl.screenshot(udid, to);
      return new Uint8Array(await Bun.file(to).arrayBuffer());
    },
    record: (udid, path) => startRecording(simctl.argv(["io", udid, "recordVideo", "--codec=h264", "--force", path]), path, recordingStarted),
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
};

/** One simulator's screen. */
export class SimScreen {
  readonly id: string;
  readonly hostKey: string;
  readonly agent: string;
  readonly udid: string;
  readonly purpose: string;
  readonly dir: string;
  readonly startedAt = new Date().toISOString();
  readonly start = performance.now();
  private readonly controlFile: string;
  private readonly steps: Steps;
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
    this.purpose = screenName(opened.device, opened.agent);
    this.dir = join(recordingsDir(opened.home), this.id);
    this.controlFile = opened.controlFile;
    this.steps = opened.steps;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.writeMeta();
    const shoot: Shoot = () => tools.shoot(this.udid);
    this.shooter = new Shooter(shoot, this.start, () => this.watchers.size > 0, (frame) => this.frame(frame));
    this.hands = new Hands(opened.runner, opened.scale, (args, ran) => this.step("agent-device", { command: `agent-device ${args.join(" ")}`, by: "person" }, ran.ok, ran.ok ? undefined : ran.said, ran.ms), tools.run);
  }

  offsetMs(): number {
    return Math.round(performance.now() - this.start);
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
    this.newest = frame;
    for (const watcher of this.watchers) watcher(frame);
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
        this.recording = this.tools.record(this.udid, join(this.dir, RECORDING_FILES.video_mp4.name));
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
      if (before === "human") this.step("handback", { by }, true, undefined, 0);
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
  async close(): Promise<[string, number][]> {
    if (this.closed) return recordedFiles(this.dir);
    this.closed = true;
    this.shooter.stop();
    this.hands.stop();
    this.watchers.clear();
    this.newest = undefined;
    rmSync(this.controlFile, { force: true });
    const why = await this.recording?.finish();
    if (why) {
      rmSync(join(this.dir, RECORDING_FILES.video_mp4.name), { force: true });
      this.setNote(`no video: ${why}`);
    }
    this.writeMeta(new Date().toISOString());
    return recordedFiles(this.dir);
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
      screen = new SimScreen({ ...opened, home: this.home, steps: this.steps }, this.tools);
    } catch (e) {
      console.warn(`the iOS simulator ${opened.udid} has no screen: ${(e as Error).message}`);
      return undefined;
    }
    this.screens.set(opened.agent, screen);
    screen.step("sim_start", { device: opened.device, udid: opened.udid }, true, undefined, 0);
    void this.report(screen, "live");
    return screen;
  }

  /** The agent's simulator went: its screen ends, and its recording goes to the hub. */
  async close(agent: string): Promise<void> {
    const screen = this.screens.get(agent);
    if (!screen) return;
    this.screens.delete(agent);
    this.ending.add(screen.id);
    try {
      this.unwatch(screen.id);
      this.pressed.delete(screen.id);
      screen.step("sim_end", {}, true, undefined, 0);
      await screen.close();
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

  private async report(screen: SimScreen, state: BrowserSessionState): Promise<void> {
    const meta = screen.meta(state === "live" ? undefined : new Date().toISOString());
    try {
      await this.link.hub(screen.hostKey, "/", "browser_session", report(meta, state, screen.control(), []));
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
    const on = this.pumps.get(screen.id);
    if (on) {
      // Another viewer: it gets the newest frame too.
      on.pump.kbps = frame.kbps;
      if (screen.newest) on.pump.offer(screen.newest);
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
    if (input && !screen.input(input)) console.debug(`iOS screen ${screen.id}: input not delivered`);
    if (pressed.down) this.pressed.add(screen.id);
    else this.pressed.delete(screen.id);
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

  /** Every screen ends (the node stops); their recordings go at the node's next start. */
  async shutdown(): Promise<void> {
    for (const id of [...this.pumps.keys()]) this.unwatch(id);
    const all = [...this.screens.values()];
    this.screens.clear();
    for (const screen of all) await screen.close().catch(() => {});
  }
}
