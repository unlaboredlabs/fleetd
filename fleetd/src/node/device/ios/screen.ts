// What a person watching an agent's iOS simulator sees, and what they do to
// it (the Rust node's ios/screen.rs, ported). `simctl io` records video files but can't stream, so the live view is
// fleetd-frames' stream of the simulator's framebuffer (../../screen/mac_frames.ts: a JPEG as soon as the screen
// changes), run only while someone watches; where that can't run, a loop of `simctl io screenshot` JPEGs, at most one
// every MIN_GAP (each takes ~0.5 s). They are the same Frames an Android screen gives, sized in the screen's pixels.
//
// A person's input goes straight into the simulator's HID service while the stream runs and its helper says it can
// (./hid.ts: a finger, keys, the home button, as Simulator.app's own input, landing within a frame or two). Otherwise,
// and for what that can't carry (Back, text with no key on a US keyboard), it goes through agent-device on the agent's
// own home, so through its daemon and the XCTest runner it already started (0.4-0.9 s a gesture): a tap is `press`, a
// drag `swipe`, a held tap `longpress`, the wheel a `swipe`, typing `type`, and Enter, Home and Back their own
// commands. Inputs queue and run one at a time; scrolls and typing that pile up behind a slow command go as one. agent-device runs them only in a session, and keeps its sessions per working folder: the
// agent's is its job folder's, never the node's. So the first input it refuses opens one (`open`, no app): refused as
// the agent's session holds the simulator, the inputs go to that session by name (`--session`); opened, the inputs
// go to that new one, which is closed at hand-back so the agent's own `open` isn't refused.
import type { Frame, Input } from "../scrcpy.ts";
import { jpegSize } from "../../browser/fit.ts";
import type { StreamFrame, StreamRun } from "../../screen/live.ts";
import { type Direct, Touches } from "./hid.ts";

/** The live view's frames come no closer together than this. */
export const MIN_GAP = 100;
/** The H.264 bit rate at most, in kbit/s, and the share of the watchers' links it takes when they are the bound. */
const VIDEO_KBPS = 2_500;
const VIDEO_SHARE = 0.7;
/** How often a stream looks whether someone still watches: it stops this long after the last one left. */
const WATCHED_EVERY = 250;
/** After a failed screenshot, the next comes this much later. */
const FAILED_GAP = 1_000;
/** A touch held this long without moving is a long press. */
export const LONG_PRESS = 500;
/** A touch that moved less than this many points is a tap. */
const TAP_SLOP = 8;
/** One input command may take this long (the runner may be starting). */
export const COMMAND = 30_000;
/** What agent-device says when no session of its own is open on the simulator. */
export const NO_SESSION = "SESSION_NOT_FOUND";

/** The session holding the simulator, as agent-device names it when it refuses an `open` (`DEVICE_IN_USE`). */
export function heldBy(said: string): string | undefined {
  return /in use by workspace session "([^"]+)"/.exec(said)?.[1];
}

/** A command run in a session by name: the flag right after the verb, before any `--`. */
export const inSession = (args: string[], session: string | undefined) => (session ? [args[0]!, "--session", session, ...args.slice(1)] : args);

/** Takes one screenshot of the simulator as JPEG. */
export type Shoot = () => Promise<Uint8Array>;

/** A running stream of the simulator's screen (../../screen/mac_frames.ts). */
export type LiveRun = StreamRun;
/** Starts a stream of the simulator's screen (../../screen/mac_frames.ts): each change a JPEG or H.264, sized in the
 * screen's own pixels (the picture may be smaller). */
export type Live = (onFrame: (frame: StreamFrame) => void) => Promise<LiveRun>;

/**
 * The screenshot loop for one simulator: it runs while `wanted` says someone watches, a new frame to `onFrame` only
 * when the screen changed. `run` starts it, once; it stops by itself when nobody watches, or for good on `stop`.
 */
export class Shooter {
  private looping = false;
  private stopped = false;
  private seq = 0;
  private last: bigint | number | undefined;
  /** The stream while it runs. */
  private streaming: LiveRun | undefined;
  /** Why the stream failed, once it has: screenshots from then on. */
  private liveFailed: string | undefined;
  /** What the watchers take: H.264 (every one decodes it), and their links' budget. */
  private wants: { video: boolean; kbps: number | undefined } = { video: false, kbps: undefined };
  /** The screen's size in pixels, as the stream's last frame said. */
  private screen: [number, number] | undefined;

  constructor(
    private readonly shoot: Shoot,
    /** The screen's start, in performance.now() ms: a frame's `atMs` counts from it. */
    private readonly start: number,
    private readonly wanted: () => boolean,
    private readonly onFrame: (frame: Frame) => void,
    private readonly sleep: (ms: number) => Promise<unknown> = Bun.sleep,
    /** The screen as a stream, where the Mac can: a frame as it changes, not a screenshot each MIN_GAP at most. */
    private readonly live?: Live,
  ) {}

  /** Runs while someone watches; a new watcher meanwhile gets the screen at once. */
  run(): void {
    if (this.stopped) return;
    if (this.looping) {
      // The screen now, even unchanged: a new watcher hasn't seen it.
      this.last = undefined;
      return this.streaming?.still();
    }
    this.looping = true;
    void (this.live && this.liveFailed === undefined ? this.stream(this.live) : this.loop()).finally(() => (this.looping = false));
  }

  stop(): void {
    this.stopped = true;
    this.streaming?.stop();
  }

  /** H.264 from now on (every watcher decodes it), or JPEG; with H.264, `kbps` (undefined: the links keep up) is its
   * bit rate's bound. Only a stream sends H.264: screenshots stay JPEG. */
  want(video: boolean, kbps: number | undefined): boolean {
    const switched = this.wants.video !== video;
    this.wants = { video, kbps };
    this.tellWants();
    return switched;
  }

  /** Where a person's input goes straight into the simulator, while the stream takes it. */
  direct(): Direct | undefined {
    const run = this.streaming;
    if (!run?.input?.() || !this.screen) return undefined;
    return { tell: (command) => run.tell(command), screen: this.screen };
  }

  /** A watcher lost an H.264 frame: the screen now as a JPEG (even unchanged), and the next H.264 frame a keyframe. */
  key(): void {
    this.last = undefined;
    this.streaming?.still();
  }

  private tellWants(): void {
    const run = this.streaming;
    if (!run) return;
    run.tell(this.wants.video ? "h264" : "jpeg");
    const kbps = this.wants.kbps;
    run.tell(`kbps ${kbps === undefined ? VIDEO_KBPS : Math.min(VIDEO_KBPS, Math.max(100, Math.round(kbps * VIDEO_SHARE)))}`);
  }

  /** The stream, until nobody watches; screenshots instead if it can't start or stops by itself. */
  private async stream(live: Live): Promise<void> {
    let run: LiveRun;
    // A watcher that comes back gets the screen at once, changed or not.
    this.last = undefined;
    try {
      run = await live((f) => {
        if (this.stopped) return;
        const [width, height] = f.screen;
        this.screen = f.screen;
        const atMs = Math.round(performance.now() - this.start);
        if (f.kind === "h264") return this.onFrame({ seq: ++this.seq, jpeg: new Uint8Array(0), width, height, atMs, video: { data: f.data, key: f.key } });
        // A still asked for on an unchanged screen is the same picture: the watchers have it.
        const hash = Bun.hash(f.data);
        if (hash === this.last) return;
        this.last = hash;
        this.onFrame({ seq: ++this.seq, jpeg: f.data, width, height, atMs });
      });
    } catch (e) {
      this.liveFailed = (e as Error).message;
      console.warn(`iOS live view: screenshots instead of a stream: ${this.liveFailed}`);
      return this.loop();
    }
    this.streaming = run;
    this.tellWants();
    let ended: string | undefined;
    void run.ended.then((why) => (ended = why ?? "it stopped"));
    while (this.wanted() && !this.stopped && ended === undefined) await this.sleep(WATCHED_EVERY);
    this.streaming = undefined;
    run.stop();
    if (ended !== undefined && !this.stopped) {
      this.liveFailed = ended;
      console.warn(`iOS live view: screenshots instead of a stream: ${ended}`);
      return this.loop();
    }
  }

  private async loop(): Promise<void> {
    let failing = false;
    // A watcher that comes back gets the screen at once, changed or not.
    this.last = undefined;
    while (this.wanted() && !this.stopped) {
      const began = performance.now();
      let gap = MIN_GAP;
      try {
        const jpeg = await this.shoot();
        const size = jpegSize(jpeg);
        if (!size) throw new Error("the screenshot is not a JPEG");
        failing = false;
        // A still screen shoots the same bytes: the watcher has them already.
        const hash = Bun.hash(jpeg);
        if (hash !== this.last && !this.stopped) {
          this.last = hash;
          this.onFrame({ seq: ++this.seq, jpeg, width: size[0], height: size[1], atMs: Math.round(performance.now() - this.start) });
        }
      } catch (e) {
        if (!failing) console.warn(`iOS live view: a screenshot failed: ${(e as Error).message}`);
        failing = true;
        gap = FAILED_GAP;
      }
      await this.sleep(Math.max(gap - (performance.now() - began), 0));
    }
  }
}

/** Turns a person's inputs, in the screen's pixels, into agent-device commands, in points. */
export class Gestures {
  private readonly scale: number;
  private down: { x: number; y: number; at: number } | undefined;

  /** `scale`: the screen's pixels per point. */
  constructor(scale: number) {
    this.scale = scale >= 1 ? scale : 1;
  }

  private point(x: number, y: number): [string, string] {
    const p = (v: number) => String(Math.round(Math.max(v, 0) / this.scale));
    return [p(x), p(y)];
  }

  /** The command for one input, if it ends a gesture; `now` in ms. */
  feed(input: Input, now: number): string[] | undefined {
    switch (input.kind) {
      case "touch": {
        if (input.action === "down") {
          this.down = { x: input.x, y: input.y, at: now };
          return undefined;
        }
        if (input.action === "move") return undefined;
        const down = this.down;
        this.down = undefined;
        if (!down) return undefined;
        const moved = Math.hypot(input.x - down.x, input.y - down.y) / this.scale;
        const [px, py] = this.point(down.x, down.y);
        if (moved < TAP_SLOP) return [now - down.at >= LONG_PRESS ? "longpress" : "press", px, py];
        return ["swipe", px, py, ...this.point(input.x, input.y)];
      }
      case "scroll": {
        // Scrolling down drags the content up.
        return ["swipe", ...this.point(input.x, input.y), ...this.point(input.x - input.dx, input.y - input.dy)];
      }
      case "key": {
        if (!input.down) return undefined;
        switch (input.key) {
          case "Enter":
            return ["keyboard", "return"];
          case "BrowserHome":
            return ["home"];
          case "BrowserBack":
            return ["back"];
          default:
            return undefined;
        }
      }
      case "text":
        // After `--`, so text that starts with `-` is typed, not read as a flag.
        return ["type", "--", input.text];
    }
  }
}

/** A command's arguments with the simulator named: its flags right after the verb, so they come before any `--`. */
export function commandArgs(args: string[], udid: string): string[] {
  return [...args.slice(0, 1), "--platform", "ios", "--udid", udid, ...args.slice(1)];
}

/** Folds inputs that piled up into fewer: scrolls one after another into one, text into one. */
export function coalesce(inputs: Input[]): Input[] {
  const out: Input[] = [];
  for (const input of inputs) {
    const last = out.at(-1);
    if (last?.kind === "scroll" && input.kind === "scroll") out[out.length - 1] = { ...last, dx: last.dx + input.dx, dy: last.dy + input.dy };
    else if (last?.kind === "text" && input.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + input.text };
    else out.push(input);
  }
  return out;
}

/** How the person's commands run: the iOS wrapper, with the agent's environment (its daemon's home), on its udid. */
export type Runner = { wrapper: string; env: Record<string, string>; udid: string };

/** One command's end: whether it went, what it said (its errors, and its output: agent-device prints some there). */
export type Ran = { ok: boolean; said: string; ms: number };

/** One agent-device command on the simulator, given COMMAND to run. */
export async function runCommand(runner: Runner, args: string[], within = COMMAND): Promise<Ran> {
  const started = performance.now();
  let child;
  try {
    child = Bun.spawn([runner.wrapper, ...commandArgs(args, runner.udid)], { env: runner.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { ok: false, said: `cannot run agent-device: ${(e as Error).message}`, ms: 0 };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, within);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const ms = Math.round(performance.now() - started);
    if (timedOut) return { ok: false, said: `it did not finish in ${Math.round(within / 1000)} s`, ms };
    return { ok: code === 0, said: `${stderr}${stdout}`, ms };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A screen's queue of a person's inputs, run in order: straight into the simulator while `direct` says where, else
 * through agent-device. `onRan` hears each gesture (the screen's action log: agent-device's commands, and the same
 * words for one that went straight, `direct`); `stop` drops what is still queued.
 */
export class Hands {
  private readonly queue: Input[] = [];
  private readonly gestures: Gestures;
  private readonly touches = new Touches();
  /** The gestures that went straight, as agent-device would have run them: the action log's words. */
  private readonly logged: Gestures;
  /** Which way the finger down now went: its moves and lift go the same way. */
  private finger: "direct" | "agent-device" | undefined;
  private working = false;
  private stopped = false;
  /** The agent's session the inputs go to, by name, once an `open` was refused for it. */
  private session: string | undefined;
  /** Whether the inputs opened a session of their own, which hand-back closes. */
  private opened = false;
  private releasing = false;

  constructor(
    private readonly runner: Runner,
    scale: number,
    private readonly onRan: (args: string[], ran: Ran, direct?: boolean) => void = () => {},
    private readonly run: (runner: Runner, args: string[]) => Promise<Ran> = runCommand,
    private readonly direct: () => Direct | undefined = () => undefined,
  ) {
    this.gestures = new Gestures(scale);
    this.logged = new Gestures(scale);
  }

  send(input: Input): boolean {
    if (this.stopped) return false;
    this.queue.push(input);
    if (!this.working) void this.work();
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.touches.liftWheel();
  }

  /** The person handed the simulator back: after what is queued, a session the inputs opened is closed. */
  release(): void {
    if (this.stopped) return;
    this.touches.liftWheel();
    this.releasing = true;
    if (!this.working) void this.work();
  }

  /** Resolves once everything queued has run (tests). */
  async idle(): Promise<void> {
    while (this.working) await Bun.sleep(5);
  }

  private async work(): Promise<void> {
    this.working = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        for (const input of coalesce(this.queue.splice(0))) {
          if (this.stopped) return;
          if (this.straight(input)) continue;
          const args = this.gestures.feed(input, performance.now());
          if (!args) continue;
          let ran = await this.run(this.runner, inSession(args, this.session));
          if (!ran.ok && ran.said.includes(NO_SESSION)) ran = await this.reopen(args);
          if (!ran.ok) console.warn(`a person's input did not reach the iOS simulator (${args.join(" ")}): ${[...ran.said.trim()].slice(0, 300).join("")}`);
          this.onRan(args, ran);
        }
      }
      if (this.releasing && !this.stopped) {
        this.releasing = false;
        this.session = undefined;
        if (this.opened) {
          this.opened = false;
          const ran = await this.run(this.runner, ["close"]);
          if (!ran.ok) console.warn(`the person's agent-device session on the iOS simulator did not close: ${[...ran.said.trim()].slice(0, 300).join("")}`);
        }
      }
    } finally {
      this.working = false;
    }
  }

  /** Sends `input` straight into the simulator if it can go that way now: whether it went. */
  private straight(input: Input): boolean {
    const touch = input.kind === "touch" ? input.action : undefined;
    // A finger that went down through agent-device ends there, and one that went straight ends straight.
    const to = touch && touch !== "down" && this.finger === "agent-device" ? undefined : this.direct();
    if (touch === "down") this.finger = to ? "direct" : "agent-device";
    if (!to || !this.touches.feed(input, to)) return false;
    if (touch === "up") this.finger = undefined;
    // The action log's line: what agent-device would have run (no line for each turn of the wheel).
    const words = input.kind === "scroll" ? undefined : this.logged.feed(input, performance.now());
    if (words) this.onRan(words, { ok: true, said: "", ms: 0 }, true);
    return true;
  }

  /**
   * press, swipe and type each need a session, and agent-device refuses them all without one: the input's own folder
   * has none. Open one on the simulator, with no app: refused for the agent's session, go to that one by name.
   */
  private async reopen(args: string[]): Promise<Ran> {
    this.session = undefined;
    const open = await this.run(this.runner, ["open"]);
    if (open.ok) {
      this.opened = true;
      return this.run(this.runner, args);
    }
    this.session = heldBy(open.said);
    return this.session ? this.run(this.runner, inSession(args, this.session)) : open;
  }
}
