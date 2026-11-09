// One live desktop session (crates/fleetd/src/node/desktop/session.rs): the display it was lent (or the Mac's lease),
// the node's connection to its screen (x11.ts, mac/screen.ts), the screen it reads ten times a second while anything
// changes (the video, and the frames a person watches), and the action log, a line per `desktop` action and session
// tool call as a browser session keeps it (node/browser/record.ts), each scrubbed of the session's secrets.
//
// A Mac screen session that doesn't hold the Mac's lease only observes: it reads the screen only while a person
// watches it, and records no video meanwhile.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserAction, BrowserControl, BrowserFrame, BrowserInput } from "../../shared/contracts.ts";
import { RECORDING_FILES } from "../../shared/screens_wire.ts";
import { Pacer } from "../browser/fit.ts";
import { appendAction, files as recordedFiles, type Meta, scrubFile, type Steps, VideoSink, writeMeta } from "../browser/record.ts";
import { Scrub } from "../mask.ts";
import type { Launched, Lent, Screen } from "./screen.ts";
import { charKeysym, keysym } from "./x11.ts";

/** What a session's recording says without an ffmpeg to encode its video. */
export const NO_VIDEO = "no video: this machine has no ffmpeg for it";

/** The start of a result's text a step keeps. */
const RESULT_CHARS = 500;
/** How often the node looks at the screen: a look starts this long after the last one started (10 frames a second
 * while reading and encoding take less), or at once when they took longer. */
export const FRAME_EVERY = 100;
/** Without DAMAGE telling it, the node reads the whole screen at least this often. */
const FULL_EVERY = 2_000;

/** `desktop`'s call (fleetd-contracts browser.rs `DesktopCall`): its fields as the agent's tool sends them. */
export type DesktopCall = {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
};

/** `DesktopDone`: what the action did, and the screen for a screenshot. */
export type DesktopDone = { message: string; jpegB64?: string; width?: number; height?: number };

/** Where a watched session's frames go, and the budget the hub last named for it. */
export type Watcher = { send: (frame: BrowserFrame) => void; kbps: number | undefined };

export type Opened = {
  id: string;
  thread: string;
  cwd: string;
  purpose: string;
  /** The agent session's secrets (its project's, its order's, its MCP servers'), scrubbed from the recording. */
  secrets: [string, string][];
  kind: "linux_desktop" | "mac";
  /** The recording's folder, and the ffmpeg that encodes its video (none: no video). Absent: nothing is recorded. */
  dir?: string;
  ffmpeg?: string;
  /** Each session's latest step, for the heartbeat (the browsers' record.ts `Steps`). */
  steps?: Steps;
  /** A Mac screen session that starts without the lease. */
  observing?: boolean;
};

export class Session {
  readonly id: string;
  readonly thread: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly kind: "linux_desktop" | "mac";
  /** A Mac screen session without the lease: it only observes, and reads the screen only for a person watching it. */
  private observingNow: boolean;
  readonly startedAt = new Date().toISOString();
  private readonly start = performance.now();
  private lent: Lent | undefined;
  private controlNow: BrowserControl = "agent";
  private watcher: Watcher | undefined;
  private liveSeq = 0;
  private last: BrowserFrame | undefined;
  /** Whether `last` waits for the watcher's link. */
  private pending = false;
  private readonly pacer = new Pacer();
  private noteText: string | undefined;
  private seq = 0;
  private readonly scrub: Scrub;
  readonly dir: string | undefined;
  private readonly ffmpeg: string | undefined;
  private readonly latest: Steps | undefined;
  private video: VideoSink | undefined;
  private ticker: Timer | undefined;
  private videoFailed = false;
  private lastActive = performance.now();
  private closed = false;
  private capturing: Promise<void> = Promise.resolve();
  /** The latest step, for the heartbeat. */
  step: BrowserAction | undefined;
  /** Every step so far, scrubbed, as the action log has them. */
  readonly steps: BrowserAction[] = [];

  constructor(
    lent: Lent,
    readonly screen: Screen,
    opened: Opened,
  ) {
    this.lent = lent;
    this.id = opened.id;
    this.thread = opened.thread;
    this.cwd = opened.cwd;
    this.purpose = opened.purpose;
    this.kind = opened.kind;
    this.observingNow = opened.observing ?? false;
    this.scrub = new Scrub(opened.secrets);
    this.dir = opened.dir;
    this.ffmpeg = opened.ffmpeg;
    this.latest = opened.steps;
    if (this.dir && !this.ffmpeg) this.noteText = NO_VIDEO;
    this.writeMeta();
  }

  /** Starts reading the screen, and keeps a still screen's frame showing in the video. */
  open(): void {
    this.capturing = this.capture();
    this.ticker = setInterval(() => this.video?.tick(this.offsetMs()), 1_000);
  }

  meta(endedAt?: string): Meta {
    return {
      sessionId: this.id,
      kind: this.kind,
      threadId: this.thread,
      cwd: this.cwd,
      purpose: this.purpose,
      startedAt: this.startedAt,
      ...(endedAt ? { endedAt } : {}),
      credentialsFilled: 0,
      ...(this.noteText !== undefined ? { note: this.noteText } : {}),
    };
  }

  writeMeta(endedAt?: string): void {
    if (!this.dir) return;
    try {
      writeMeta(this.dir, this.meta(endedAt));
    } catch (e) {
      console.warn(`desktop ${this.id}: session file not written: ${(e as Error).message}`);
    }
  }

  offsetMs(): number {
    return Math.round(performance.now() - this.start);
  }

  touch(): void {
    this.lastActive = performance.now();
  }

  idleFor(): number {
    return performance.now() - this.lastActive;
  }

  note(): string | undefined {
    return this.noteText;
  }

  setNote(note: string): void {
    this.noteText = this.noteText ? `${this.noteText}; ${note}` : note;
  }

  control(): BrowserControl {
    return this.controlNow;
  }

  observing(): boolean {
    return this.observingNow;
  }

  /** Takes the Mac's lease (false) or gives it up (true), logged as a step. */
  setObserving(observing: boolean): void {
    if (this.observingNow === observing) return;
    this.observingNow = observing;
    this.logStep(observing ? "lease_lost" : "lease_taken", {}, true);
  }

  watched(): boolean {
    return this.watcher !== undefined;
  }

  /** Who drives the desktop: a person takes it (`human`: the agent's actions are refused until they hand it back), or
   * hands it back (`handing_back`, until the agent's next action, then `agent`). Logged as a step. */
  setControl(control: BrowserControl, by: string): void {
    const before = this.controlNow;
    if (before === control) return;
    this.controlNow = control;
    if (control === "human") this.logStep("takeover", { by }, true);
    else if (before === "human") this.logStep("handback", { by }, true);
    // The watcher's next frame says who drives now.
    if (this.last) this.last = { ...this.last, control };
    this.sendLive(true);
  }

  /** Sends this session's frames to the hub from now on, the newest at once, or no more. */
  setWatcher(watcher: Watcher | undefined): void {
    this.watcher = watcher;
    if (this.last) this.last = { ...this.last, control: this.controlNow };
    this.sendLive(true);
  }

  setBudget(kbps: number | undefined): void {
    if (this.watcher) this.watcher.kbps = kbps;
  }

  /** The newest frame to the watcher, if it waits and the link has room for it now (or `now` anyway). */
  private sendLive(now: boolean): void {
    const watcher = this.watcher;
    const last = this.last;
    if (!watcher || !last || !(this.pending || now)) return;
    if (!now && this.pacer.wait(watcher.kbps) > 0) return;
    this.pending = false;
    void this.pacer.fit(watcher.kbps, last).then((fitted) => this.watcher?.send(fitted));
  }

  /** A new screen: into the video (not while it only observes), and to the hub while it watches. */
  private frame(jpeg: Uint8Array, width: number, height: number): void {
    if (this.closed) return;
    if (this.dir && this.ffmpeg && !this.video && !this.observingNow && !this.videoFailed) {
      try {
        this.video = new VideoSink(this.ffmpeg, join(this.dir, RECORDING_FILES.video.name), [width, height]);
      } catch (e) {
        this.videoFailed = true;
        this.setNote(`no video: ${(e as Error).message}`);
      }
    }
    if (!this.observingNow) this.video?.frame(jpeg, this.offsetMs());
    this.liveSeq++;
    this.last = {
      sessionId: this.id,
      seq: this.liveSeq,
      jpegB64: Buffer.from(jpeg).toString("base64"),
      width,
      height,
      control: this.controlNow,
    };
    this.pending = true;
    this.sendLive(false);
  }

  /** Reads the screen while the session lives: a new frame whenever it changed. */
  private async capture(): Promise<void> {
    let lastHash: bigint | undefined;
    let lastFull = performance.now() - FULL_EVERY;
    while (!this.closed) {
      // An observer reads the screen only for a person watching it.
      if (this.observingNow && !this.watched()) {
        await Bun.sleep(FRAME_EVERY);
        continue;
      }
      const started = performance.now();
      const full = started - lastFull >= FULL_EVERY;
      try {
        if (this.screen.changed() || full) {
          const raw = await this.screen.serial(() => this.screen.grabRaw());
          if (full) lastFull = performance.now();
          const hash = Bun.hash.xxHash64(raw.data) ^ BigInt(raw.width * 65536 + raw.height);
          if (hash !== lastHash && !this.closed) {
            lastHash = hash;
            this.frame(await this.screen.encode(raw), raw.width, raw.height);
          }
        }
      } catch (e) {
        if (this.closed) return;
        console.warn(`desktop ${this.id}: the screen is not read: ${(e as Error).message}`);
        this.setNote(`the screen stopped being read: ${(e as Error).message}`);
        return;
      }
      this.sendLive(false);
      await Bun.sleep(Math.max(0, FRAME_EVERY - (performance.now() - started)));
    }
  }

  /** Logs one step: an action of the agent's, or fleetd's own; its number. */
  logStep(tool: string, args: unknown, ok: boolean, result?: string, durationMs = 0): number {
    this.touch();
    const seq = ++this.seq;
    const action: BrowserAction = {
      seq,
      at: new Date().toISOString(),
      offsetMs: Math.max(0, this.offsetMs() - durationMs),
      tool,
      args,
      ok,
      ...(result === undefined ? {} : { result: [...result].slice(0, RESULT_CHARS).join("") }),
      durationMs,
    };
    const clean = this.scrub.value(action);
    this.step = clean;
    this.steps.push(clean);
    if (this.dir && this.latest) {
      try {
        appendAction(this.dir, action, this.scrub, this.latest, this.id);
      } catch (e) {
        console.warn(`desktop ${this.id}: action not logged: ${(e as Error).message}`);
      }
    }
    return seq;
  }

  /** A person's input, in order, if they have control as it comes; once queued it goes, even when they hand back
   * before it is done. */
  queueInput(input: BrowserInput): void {
    if (this.controlNow !== "human") return;
    void this.screen.serial(() => personInput(this.screen, input)).catch(() => {});
  }

  /** Does one `desktop` action of the agent's, and logs it. */
  async act(call: DesktopCall): Promise<DesktopDone> {
    const started = performance.now();
    let done: DesktopDone;
    try {
      done =
        call.action === "launch"
          ? await this.launchApp(call)
          : call.action === "agent_desktop"
            ? await this.agentDesktop(call)
            : await this.screen.serial(() => act(this.screen, call));
    } catch (e) {
      const why = (e as Error).message;
      this.logStep("desktop", call, false, why, Math.round(performance.now() - started));
      throw new Error(this.scrub.text(why));
    }
    this.logStep("desktop", call, true, done.message, Math.round(performance.now() - started));
    return { ...done, message: this.scrub.text(done.message) };
  }

  /** `launch`: starts an app on the display and says how it looks a moment later. */
  private async launchApp(call: DesktopCall): Promise<DesktopDone> {
    const command = call.text;
    if (!command) throw new Error("launch needs text: the command");
    const launched = await this.launch(command);
    if (!launched.exited) return { message: `Started \`${command}\` (pid ${launched.pid}). Take a screenshot to see its window.` };
    const { code, output } = launched.exited;
    return { message: `\`${command}\` exited at once${code === null ? "" : ` with code ${code}`}: ${output || "it printed nothing"}` };
  }

  /** `agent_desktop`: one agent-desktop command on the Mac's screen. */
  private async agentDesktop(call: DesktopCall): Promise<DesktopDone> {
    if (!call.text) throw new Error("agent_desktop needs text: its arguments, the command first");
    if (!this.lent) throw new Error("the session has ended");
    if (!this.lent.agentDesktop) {
      throw new Error("agent_desktop drives the agents' Mac's screen (session_start kind mac); on a Linux desktop use the other actions");
    }
    return { message: await this.lent.agentDesktop(call.text) };
  }

  /** Starts an app on the display. */
  launch(command: string): Promise<Launched> {
    if (!this.lent) throw new Error("the session has ended");
    return this.lent.launch(command, this.cwd);
  }

  /**
   * Stops reading the screen, finishes the video and throws the display away with everything on it. Returns the
   * recording's files there are.
   */
  async close(): Promise<[string, number][]> {
    if (this.closed) return this.dir ? recordedFiles(this.dir) : [];
    this.closed = true;
    this.watcher = undefined;
    clearInterval(this.ticker);
    await this.capturing;
    this.screen.close();
    const sink = this.video;
    this.video = undefined;
    if (sink && this.dir) {
      const why = await sink.finish(this.offsetMs());
      if (why) {
        rmSync(join(this.dir, RECORDING_FILES.video.name), { force: true });
        this.setNote(`no video: ${why}`);
      }
    }
    const lent = this.lent;
    this.lent = undefined;
    await lent?.drop();
    if (!this.dir) return [];
    // The action log was scrubbed line by line as it was written; scrubbed once more whole, with every secret known.
    const actions = join(this.dir, RECORDING_FILES.actions.name);
    try {
      scrubFile(actions, this.scrub);
    } catch (e) {
      console.warn(`desktop ${this.id}: recording not scrubbed: ${(e as Error).message}`);
      rmSync(actions, { force: true });
    }
    this.writeMeta(new Date().toISOString());
    return recordedFiles(this.dir);
  }
}

const point = (c: [number, number] | undefined) => (c ? ([c[0], c[1]] as [number, number]) : undefined);

/** One `desktop` action on the screen. */
export async function act(x: Screen, call: DesktopCall): Promise<DesktopDone> {
  const said = (message: string): DesktopDone => ({ message });
  const needText = () => {
    if (!call.text) throw new Error(`${call.action} needs text`);
    return call.text;
  };
  const at = async (what: string): Promise<[number, number]> => {
    const p = point(call.coordinate);
    if (p) return p;
    try {
      return await x.pointer();
    } catch (e) {
      throw new Error(`${what}: ${(e as Error).message}`);
    }
  };
  switch (call.action) {
    case "screenshot": {
      await x.sync();
      const shot = await x.grab();
      return {
        message: `The screen, ${shot.width}x${shot.height}.`,
        jpegB64: Buffer.from(shot.jpeg).toString("base64"),
        width: shot.width,
        height: shot.height,
      };
    }
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const [button, count] = ({ right_click: [3, 1], middle_click: [2, 1], double_click: [1, 2], triple_click: [1, 3] } as Record<string, [number, number]>)[call.action] ?? [1, 1];
      const [px, py] = await at("click");
      await x.click(px, py, button, count);
      return said(`${call.action} at (${px}, ${py}).`);
    }
    case "mouse_move": {
      const p = point(call.coordinate);
      if (!p) throw new Error("mouse_move needs coordinate");
      await x.moveTo(p[0], p[1]);
      await x.sync();
      return said(`Moved the mouse to (${p[0]}, ${p[1]}).`);
    }
    case "left_click_drag": {
      const from = point(call.start_coordinate);
      if (!from) throw new Error("left_click_drag needs start_coordinate");
      const to = point(call.coordinate);
      if (!to) throw new Error("left_click_drag needs coordinate");
      await x.drag(from, to);
      return said(`Dragged from (${from[0]}, ${from[1]}) to (${to[0]}, ${to[1]}).`);
    }
    case "type": {
      const text = needText();
      await x.typeText(text);
      return said(`Typed ${[...text].length} characters.`);
    }
    case "key": {
      const keys = needText();
      await x.chord(keys);
      return said(`Pressed ${keys}.`);
    }
    case "scroll": {
      const [px, py] = await at("scroll");
      const n = call.scroll_amount ?? 3;
      const [dx, dy] = { up: [0, -n], down: [0, n], left: [-n, 0], right: [n, 0] }[call.scroll_direction ?? "down"];
      await x.scroll(px, py, dx!, dy!);
      return said(`Scrolled ${n} at (${px}, ${py}).`);
    }
    case "wait": {
      const secs = call.duration ?? 1;
      await Bun.sleep(secs * 1000);
      return said(`Waited ${secs} s.`);
    }
    case "cursor_position": {
      const [px, py] = await x.pointer();
      return said(`The mouse is at (${px}, ${py}).`);
    }
    case "agent_desktop":
      throw new Error("agent_desktop drives the agents' Mac's screen (session_start kind mac); on a Linux desktop use the other actions");
    default:
      throw new Error(`${call.action} is not a desktop action`);
  }
}

/** A person's input from the live view, in the frame's pixels, which are the screen's. */
export async function personInput(x: Screen, input: BrowserInput): Promise<void> {
  switch (input.kind) {
    case "mouse": {
      const [px, py] = [Math.round(input.x), Math.round(input.y)];
      const button = { left: 1, middle: 2, right: 3, none: 0 }[input.button ?? "none"] ?? 0;
      switch (input.action) {
        case "moved":
          await x.moveTo(px, py);
          break;
        case "pressed":
        case "released":
          if (button > 0) {
            await x.moveTo(px, py);
            await x.button(button, input.action === "pressed");
          }
          break;
        case "wheel": {
          // A wheel notch is about 100 pixels in a browser's deltas.
          const notches = (d: number) => (d === 0 ? 0 : Math.sign(d) * Math.max(1, Math.abs(Math.round(d / 100))));
          await x.scroll(px, py, notches(input.deltaX ?? 0), notches(input.deltaY ?? 0));
          break;
        }
      }
      return x.sync();
    }
    case "key": {
      // A key that types goes by its character; the rest by name. Modifiers come as keys of their own.
      const chars = input.text === undefined ? [] : [...input.text];
      const typed = chars.length === 1 && !/\p{Cc}/u.test(chars[0]!) ? charKeysym(chars[0]!) : undefined;
      const sym = typed ?? keysym(input.key);
      if (sym === undefined) throw new Error(`no key ${input.key}`);
      await x.keySym(sym, input.action === "down", false);
      return x.sync();
    }
    case "text":
      return x.typeText(input.text);
    default:
      // A browser's address bar: a desktop has none.
      return;
  }
}
