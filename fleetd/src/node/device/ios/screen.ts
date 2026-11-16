// What a person watching an agent's iOS simulator sees, and what they do to
// it (the Rust node's ios/screen.rs, ported). `simctl io` records video files but can't stream, so the live view is a
// loop of `simctl io screenshot` JPEGs, run only while someone watches, at most one every MIN_GAP. They are the same
// Frames an Android screen gives, in the screen's pixels.
//
// A person's input goes through agent-device on the agent's own home, so through its daemon and the XCTest runner it
// already started: a tap is `press`, a drag `swipe`, a held tap `longpress`, the wheel a `swipe`, typing `type`, and
// Enter, Home and Back their own commands. Inputs queue and run one at a time; scrolls and typing that pile up behind a
// slow command go as one. agent-device runs them only in a session of its own: on a simulator no agent opened one on,
// the first input it refuses opens one (`open`, no app), then goes again.
import type { Frame, Input } from "../scrcpy.ts";
import { jpegSize } from "../../browser/fit.ts";

/** The live view's frames come no closer together than this. */
export const MIN_GAP = 100;
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

/** Takes one screenshot of the simulator as JPEG. */
export type Shoot = () => Promise<Uint8Array>;

/**
 * The screenshot loop for one simulator: it runs while `wanted` says someone watches, a new frame to `onFrame` only
 * when the screen changed. `run` starts it, once; it stops by itself when nobody watches, or for good on `stop`.
 */
export class Shooter {
  private looping = false;
  private stopped = false;
  private seq = 0;
  private last: bigint | number | undefined;

  constructor(
    private readonly shoot: Shoot,
    /** The screen's start, in performance.now() ms: a frame's `atMs` counts from it. */
    private readonly start: number,
    private readonly wanted: () => boolean,
    private readonly onFrame: (frame: Frame) => void,
    private readonly sleep: (ms: number) => Promise<unknown> = Bun.sleep,
  ) {}

  run(): void {
    if (this.looping || this.stopped) return;
    this.looping = true;
    void this.loop().finally(() => (this.looping = false));
  }

  stop(): void {
    this.stopped = true;
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
 * A screen's queue of a person's inputs, run in order through agent-device. `onRan` hears each command that ran (the
 * screen's action log); `stop` drops what is still queued.
 */
export class Hands {
  private readonly queue: Input[] = [];
  private readonly gestures: Gestures;
  private working = false;
  private stopped = false;

  constructor(
    private readonly runner: Runner,
    scale: number,
    private readonly onRan: (args: string[], ran: Ran) => void = () => {},
    private readonly run: (runner: Runner, args: string[]) => Promise<Ran> = runCommand,
  ) {
    this.gestures = new Gestures(scale);
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
          const args = this.gestures.feed(input, performance.now());
          if (!args) continue;
          let ran = await this.run(this.runner, args);
          // A simulator no agent opened a session on: press, swipe and type each need one, and agent-device refuses
          // them all. Open one on the simulator, with no app, and go again.
          if (!ran.ok && ran.said.includes(NO_SESSION) && (await this.run(this.runner, ["open"])).ok) ran = await this.run(this.runner, args);
          if (!ran.ok) console.warn(`a person's input did not reach the iOS simulator (${args.join(" ")}): ${[...ran.said.trim()].slice(0, 300).join("")}`);
          this.onRan(args, ran);
        }
      }
    } finally {
      this.working = false;
    }
  }
}
