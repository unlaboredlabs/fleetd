// One live android session: the emulator copy it was lent, scrcpy's stream
// of its screen (the video, and the frames a person watches), and the action log, a line per tool call of the agent's
// that drove the device (its `agent-device` commands, fleetd's session tools), kept as a browser session's is
// (node/browser/record.ts).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserAction, BrowserControl } from "../../shared/contracts.ts";
import { RECORDING_FILES } from "../../shared/screens_wire.ts";
import { appendAction, files as recordedFiles, type Meta, Scrub, type Steps, VideoSink, writeMeta } from "../browser/record.ts";
import { mkdirPrivate } from "../config.ts";
import { controlPath, release } from "./agent_device.ts";
import type { Lent } from "./emulator.ts";
import { type Frame, type Input, Stream } from "./scrcpy.ts";
import { deviceDir, type Sdk } from "./sdk.ts";

/** The start of a result's text the action log keeps. */
const RESULT_CHARS = 500;

/** Where the node keeps device recordings until the hub has them. */
export const recordingsDir = (home: string) => join(deviceDir(home), "recordings");

export type Opened = {
  id: string;
  thread: string;
  cwd: string;
  purpose: string;
  dir: string;
  /** The node's home: the control file the agent's wrapper checks is there. */
  home: string;
  /** The agent session's secrets, scrubbed from everything recorded. */
  secrets: [string, string][];
  steps: Steps;
};

/** How a session's stream starts: scrcpy's, or a test's. */
export type StreamStarter = typeof Stream.start;

export class Session {
  readonly id: string;
  readonly thread: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly dir: string;
  readonly startedAt = new Date().toISOString();
  readonly start = performance.now();
  private readonly home: string;
  private lent: Lent | undefined;
  private stream: Stream | undefined;
  private video: VideoSink | undefined;
  private ticker: Timer | undefined;
  /** Set by close: a stream or frame that comes late starts nothing. */
  private closed = false;
  private noteText: string | undefined;
  private seq = 0;
  private controlNow: BrowserControl = "agent";
  private readonly scrub: Scrub;
  private readonly steps: Steps;
  private lastActive = Date.now();
  /** The newest frame, and who wants each new one (live view). */
  newest: Frame | undefined;
  private readonly watchers = new Set<(frame: Frame) => void>();

  private constructor(lent: Lent, opened: Opened) {
    this.id = opened.id;
    this.thread = opened.thread;
    this.cwd = opened.cwd;
    this.purpose = opened.purpose;
    this.dir = opened.dir;
    this.home = opened.home;
    this.lent = lent;
    this.scrub = new Scrub(opened.secrets);
    this.steps = opened.steps;
  }

  /**
   * Takes a lent emulator and starts recording it. The stream connects in the background (about a second): the
   * agent's first command needn't wait for it, and the video starts with its first frame.
   */
  static open(lent: Lent, sdk: Sdk, opened: Opened, startStream: StreamStarter = Stream.start): Session {
    mkdirSync(opened.dir, { recursive: true, mode: 0o700 });
    const session = new Session(lent, opened);
    session.writeMeta();
    const onFrame = (frame: Frame) => {
      if (session.closed) return;
      if (!session.video && session.noteText === undefined) {
        try {
          session.video = new VideoSink(sdk.ffmpeg, join(session.dir, RECORDING_FILES.video.name), [frame.width, frame.height]);
        } catch (e) {
          session.noteText = `no video: ${(e as Error).message}`;
        }
      }
      session.video?.frame(frame.jpeg, frame.atMs);
      session.newest = frame;
      for (const watcher of session.watchers) watcher(frame);
    };
    void startStream(sdk, lent.emulator.serial, lent.emulator.pushed, sdk.ffmpeg, session.start, onFrame).then(
      (stream) => {
        if (session.closed) {
          // The session ended while the stream connected: it goes, with the server and decoder.
          stream.stop();
          return;
        }
        session.stream = stream;
        session.ticker = setInterval(() => session.video?.tick(session.offsetMs()), 1_000);
      },
      (e: Error) => {
        console.warn(`device ${session.id}: stream not started: ${e.message}`);
        session.setNote(`no video or live view: ${e.message}`);
      },
    );
    return session;
  }

  offsetMs(): number {
    return Math.round(performance.now() - this.start);
  }

  touch(): void {
    this.lastActive = Date.now();
  }

  idleFor(now = Date.now()): number {
    return now - this.lastActive;
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
      kind: "android",
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
    try {
      writeMeta(this.dir, this.meta(endedAt));
    } catch (e) {
      console.warn(`device ${this.id}: session file not written: ${(e as Error).message}`);
    }
  }

  /** Each new frame of the screen to `fn` (the newest so far at once), until the returned function is called. */
  watch(fn: (frame: Frame) => void): () => void {
    this.watchers.add(fn);
    if (this.newest) fn(this.newest);
    return () => void this.watchers.delete(fn);
  }

  /** A person's input, while they have control: false when it can't go (no control, or no stream yet). */
  input(input: Input): boolean {
    if (this.controlNow !== "human") return false;
    return this.stream?.send(input) ?? false;
  }

  control(): BrowserControl {
    return this.controlNow;
  }

  /**
   * Who drives the device: a person takes it (`human`: the agent's `agent-device` refuses until they hand it back), or
   * hands it back (`handing_back`, until the agent's next command, then `agent`). Logged as a step.
   */
  setControl(control: BrowserControl, by: string): void {
    const before = this.controlNow;
    this.controlNow = control;
    if (before === control) return;
    const file = controlPath(this.home, this.thread);
    if (control === "human") {
      try {
        mkdirPrivate(dirname(file));
        writeFileSync(file, "human\n");
      } catch (e) {
        console.warn(`device ${this.id}: control file not written: ${(e as Error).message}`);
      }
      this.step("takeover", { by }, true, undefined, 0);
    } else {
      rmSync(file, { force: true });
      if (before === "human") this.step("handback", { by }, true, undefined, 0);
    }
  }

  /** Logs one step: a tool call of the agent's, or fleetd's own, and returns its number. */
  step(tool: string, args: unknown, ok: boolean, result: string | undefined, durationMs: number): number {
    this.touch();
    const seq = ++this.seq;
    const action: BrowserAction = {
      seq,
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
      console.warn(`device ${this.id}: action not logged: ${(e as Error).message}`);
    }
    return seq;
  }

  /**
   * Stops the stream, finishes the video and throws the emulator away with everything done in it. Returns the files
   * there are.
   */
  async close(): Promise<[string, number][]> {
    this.closed = true;
    const sink = this.video;
    this.video = undefined;
    this.stream?.stop();
    this.stream = undefined;
    clearInterval(this.ticker);
    this.watchers.clear();
    if (sink) {
      const why = await sink.finish(this.offsetMs());
      if (why) {
        rmSync(join(this.dir, RECORDING_FILES.video.name), { force: true });
        this.setNote(`no video: ${why}`);
      }
    }
    this.lent?.release();
    this.lent = undefined;
    release(this.home, this.thread);
    // The action log was scrubbed line by line as it was written; scrubbed once more whole, with every secret known.
    const actions = join(this.dir, RECORDING_FILES.actions.name);
    try {
      writeFileSync(actions, this.scrub.text(readFileSync(actions, "utf8")));
    } catch {
      // No steps logged.
    }
    this.writeMeta(new Date().toISOString());
    return recordedFiles(this.dir);
  }
}
