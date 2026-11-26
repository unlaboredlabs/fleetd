// One live desktop session: the display it was lent (or the Mac's lease),
// the node's connection to its screen (x11.ts, mac/screen.ts), the screen it reads as it changes (the video, and the
// frames a person watches), and the action log, a line per `desktop` action and session
// tool call as a browser session keeps it, each scrubbed of the session's secrets. Both go to the `Recording` it is
// given (node/browser/recording.ts): the node's keeps them on its disk (disk_recordings.ts), a service's its own.
//
// A Linux desktop with an H.264 encoder (x264) encodes each grab once: its frames are the video's (copied into MP4)
// and those of a watcher that decodes H.264. Only a watcher whose link carries clearly less than the video's rate gets
// an encode of its own, so a slow viewer doesn't blur the recording. Each grab goes in as NV12, only the part that
// changed converted (../screen/nv12.ts). A JPEG is made only for what needs one: a watcher that can't decode H.264, a
// new watcher's first picture or a lost frame's (from the last grab, when asked), or a video that can't take H.264.
//
// Frames come as the screen changes, at most at a rate fixed rules give (../screen/live.ts fpsFor): 30 a second while
// someone watches, 10 for the video alone, fewer when the watchers' link or the machine's load says so; none while the
// screen is still. Two frames are kept in reserve (../screen/live.ts Pace): a change that comes alone, a key's echo,
// goes at once, and only a run of changes is paced.
//
// A display that reads itself where it runs (a box's: ./box_frames.ts, `Lent.picture`) does all of that there, with
// this very code: the session then sends its frames on, to the watchers and the video, and asks it for screenshots.
// Only input and the action log stay here. If it can't start or stops, the session reads the screen itself.
//
// A Mac screen session that holds neither the Mac's lease nor an app's claim only observes: it reads the screen only
// while a person watches it, and records no video meanwhile.
import type { BrowserAction, BrowserControl, BrowserFrame, BrowserInput } from "../../shared/contracts.ts";
import { Pacer } from "../browser/fit.ts";
import type { Meta, Recording, Steps } from "../browser/recording.ts";
import { Scrub } from "../mask.ts";
import { capBy, type Encoded, fpsFor, HARDWARE_FPS, type Input, kbpsFor, type LiveEncoding, type MakeEncoder, MAX_KBPS, Pace, type StreamFrame, type StreamRun } from "../screen/live.ts";
import { Nv12 } from "../screen/nv12.ts";
import * as perf from "../screen/perf.ts";
import type { BrowserRtcFrame } from "../../shared/screens_wire.ts";
import type { App, Launched, Lent, LiveFrame, PeerReport, PictureRun, Raw, Screen, Target, VideoFrame, VideoKind, Watching } from "./screen.ts";
import { charKeysym, keysym } from "./x11.ts";

/** What a session's recording says without an ffmpeg to encode its video. */
export const NO_VIDEO = "no video: this machine has no ffmpeg for it";

/** The start of a result's text a step keeps. */
const RESULT_CHARS = 500;
/** How often the node looks at a screen that can't say when it changed (the Mac's): a look starts this long after the
 * last one started, or at once when it took longer. */
export const FRAME_EVERY = 100;
/** A screen that says when it changes (an X display's DAMAGE) is read as soon as it does, at most this many frames a
 * second while someone watches (x264's: the frames are encoded in software), and this many for the video alone. */
export const LIVE_FPS = 30;
export const RECORD_FPS = 10;
/** Reading and encoding take at most this share of the time, so a screen changing all over (a video) costs a third of
 * a core, at fewer frames, rather than a whole one. */
const WORK_SHARE = 1 / 3;
/** How long the first grab waits to know whether the video can be H.264 (the encoder's ffmpeg fetched): past it, the
 * video is JPEG's for the session. */
const READY_MS = 10_000;
/** The node reads the whole screen at least this often, whatever DAMAGE says. */
const FULL_EVERY = 2_000;
/** Once the screen is still this long after a read of only what changed, it is read whole: what DAMAGE doesn't tell
 * (the X server's own cursor, a window manager's popup) shows a quarter second after things stop moving. */
export const SETTLE = 250;

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

/** Where a watched session's frames go, the budget the hub last named for it, whether every watcher decodes H.264, and
 * the frame rate they asked for at most. */
export type Watcher = { send: (frame: BrowserFrame) => void; kbps: number | undefined; video?: boolean; fps?: number; relay?: boolean };

export type Opened = {
  id: string;
  thread: string;
  cwd: string;
  purpose: string;
  /** The agent session's secrets (its project's, its order's, its MCP servers'), scrubbed from the recording. */
  secrets: [string, string][];
  kind: "linux_desktop" | "mac";
  /** Where it is recorded, opened for it; absent: nothing is. */
  recording?: Recording;
  /** Each session's latest step, for the heartbeat (the browsers' `Steps`). */
  steps?: Steps;
  /** A Mac screen session that starts holding neither the lease nor a claim. */
  observing?: boolean;
  /** Why the agent may not launch an app on this display, when it may not: a hosted agent on this machine's display,
   * whose apps would run outside its box. */
  launchRefusal?: () => string | undefined;
  /** It goes on from a holder before (DesktopSessions `adopt`): when it started, its steps so far, who drove it. */
  resumed?: { startedAt: string; seq: number; control: BrowserControl; note?: string };
  /** What turns the grabs into H.264 for watchers that decode it (x264, ../screen/x264.ts); absent: JPEG only. */
  encoder?: MakeEncoder;
  /** The machine's load per core now (../screen/live.ts BUSY); absent: 0, never busy. */
  load?: () => number;
  /** Where a picture that answers screen peers itself (a box's) reports each one's answer or end: to the hub. */
  rtcReport?: (report: PeerReport) => void;
};

export class Session {
  readonly id: string;
  readonly thread: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly kind: "linux_desktop" | "mac";
  /** A Mac screen session without the lease or a claim: it only observes, and reads the screen only for a person
   * watching it. */
  private observingNow: boolean;
  readonly startedAt: string;
  private readonly start: number;
  private lent: Lent | undefined;
  private controlNow: BrowserControl = "agent";
  private watcher: Watcher | undefined;
  /** The screen's own stream (the Mac's, fleetd-frames) while someone watches: the live view's frames, not the grabs'. */
  private streaming: StreamRun | undefined;
  private starting = false;
  /** Why the stream failed, once it has: the grabs' frames from then on. */
  private streamFailed: string | undefined;
  /** The display's picture where it runs (Lent `picture`), while it serves: the live view's frames and the video's. */
  private picture: PictureRun | undefined;
  private readonly rtcReport: ((report: PeerReport) => void) | undefined;
  /** The grabs as H.264 for the video where it takes them, and for watchers that decode it (a screen without a
   * stream of its own) while their link carries the video's rate; absent: JPEG only. */
  private readonly encoder: LiveEncoding | undefined;
  private readonly makeEncoder: MakeEncoder | undefined;
  /** The watchers' encoder of their own, at their link's rate, while the video's runs at its own (slowLink); it serves
   * them once ready. */
  private slow: { enc: LiveEncoding; ready: boolean } | undefined;
  /** Why the watchers' own encoder failed, once it has: they get the video's frames from then on. */
  private slowFailed = false;
  /** The watchers' next H.264 frame must be a keyframe: they just moved to the video's encoder from their own. */
  private keyWanted = false;
  /** The grabs as NV12, for the encoders. */
  private readonly nv12 = new Nv12();
  private readonly load: () => number;
  /** The frame rate last told the screen's stream. */
  private toldFps: number | undefined;
  /** Whether the video is the encoder's H.264 (it takes it, and the encoder can), decided before the first grab. */
  private videoH264 = false;
  /** The last grab, not yet made a JPEG: `last` is made of it when a watcher needs a picture. */
  private unencoded: Raw | undefined;
  /** Grabs that changed the screen so far. */
  private grabs = 0;
  private liveSeq = 0;
  private last: BrowserFrame | undefined;
  /** Whether `last` waits for the watcher's link. */
  private pending = false;
  private readonly pacer = new Pacer();
  private noteText: string | undefined;
  private seq = 0;
  private readonly scrub: Scrub;
  private readonly recording: Recording | undefined;
  private readonly latest: Steps | undefined;
  private readonly launchRefusal: (() => string | undefined) | undefined;
  private ticker: Timer | undefined;
  private lastActive = performance.now();
  private closed = false;
  /** What `close` found, for a second call. */
  private closedFiles: [string, number][] = [];
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
    this.recording = opened.recording;
    this.latest = opened.steps;
    this.launchRefusal = opened.launchRefusal;
    this.rtcReport = opened.rtcReport;
    this.makeEncoder = opened.encoder;
    this.load = opened.load ?? (() => 0);
    this.encoder = opened.encoder?.(
      (f, input, atMs) => this.encoded(f, input, atMs, false),
      (why) => {
        console.warn(`desktop ${this.id}: the live view stays JPEG: ${why}`);
        this.videoH264 = false;
      },
    );
    const resumed = opened.resumed;
    this.startedAt = resumed?.startedAt ?? new Date().toISOString();
    // A resumed session's offsets go on from its start, as its action log and video have them.
    this.start = performance.now() - (resumed ? Math.max(0, Date.now() - Date.parse(resumed.startedAt)) : 0);
    if (resumed) {
      this.seq = resumed.seq;
      this.controlNow = resumed.control;
    }
    const note = resumed?.note ?? opened.recording?.note;
    if (note !== undefined) this.noteText = note;
  }

  /** Starts reading the screen, and keeps a still screen's frame showing in the video. */
  open(): void {
    this.capturing = this.lent?.picture ? this.readPicture() : this.capture();
    this.ticker = setInterval(() => {
      this.recording?.video?.tick(this.offsetMs());
      // The machine's load moves the stream's frame rate too.
      if (this.streaming && this.streamFps() !== this.toldFps) this.tellStream();
    }, 1_000);
  }

  /** How far its steps went: the last one's number, for a new holder. */
  lastSeq(): number {
    return this.seq;
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

  /** Starts recording, as it took the Mac's lease or a claim (false), or stops, holding neither any more (true). */
  setObserving(observing: boolean): void {
    this.observingNow = observing;
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
    this.picture?.control(control);
    if (control === "human") this.logStep("takeover", { by }, true);
    else if (before === "human") this.logStep("handback", { by }, true);
    // The watcher's next frame says who drives now.
    if (this.last) this.last = { ...this.last, control };
    this.sendLive(true);
  }

  /** Sends this session's frames to the hub from now on, the newest at once, or no more. */
  setWatcher(watcher: Watcher | undefined): void {
    this.watcher = watcher;
    if (this.picture) return this.picture.watch(this.watching());
    this.liveEncoder()?.key();
    if (!watcher) {
      this.streaming?.stop();
      this.streaming = undefined;
      this.stopSlow();
      // The video's encoding goes on.
      if (!this.videoH264) this.encoder?.stop();
      return;
    }
    if (this.streaming) {
      // Another watcher: the screen now, then (with H.264) a keyframe.
      this.tellStream();
      return this.streaming.still();
    }
    if (this.last) this.last = { ...this.last, control: this.controlNow };
    this.sendLive(true);
    void this.startStream();
  }

  /** The watchers' budget and whether they all decode H.264, as the hub says it. Only a switch between H.264 and
   * JPEG sends the screen anew: a budget told again (each few seconds on a varying link) costs nothing. */
  setBudget(kbps: number | undefined, video = this.watcher?.video, fps = this.watcher?.fps, relay = this.watcher?.relay): void {
    const w = this.watcher;
    if (!w) return;
    const switched = (w.video === true) !== (video === true);
    w.kbps = kbps;
    w.video = video;
    w.fps = fps;
    w.relay = relay;
    if (this.picture) return this.picture.watch(this.watching());
    if (!this.slowLink()) this.stopSlow();
    this.tellStream();
    if (switched) this.key();
  }

  /** A watcher lost an H.264 frame, or just came (the hub's `key`): the screen now as a whole JPEG, under a seq newer
   * than any frame sent, and the next H.264 frame a keyframe (a new encoder) whether the screen changes or not. */
  key(): void {
    if (!this.watcher) return;
    if (this.picture) return this.picture.key();
    if (this.streaming) return this.streaming.still();
    this.liveEncoder()?.key();
    if (this.last) this.last = { ...this.last, seq: ++this.liveSeq, control: this.controlNow };
    this.sendLive(true);
  }

  /** Whether a watcher's frames come from the encoder: it decodes H.264, and the screen has no stream of its own. */
  private liveH264(): boolean {
    return this.watcher?.video === true && !this.streaming;
  }

  /** Whether the grabs go into the video as H.264 now (not while the session only observes). */
  private recordsH264(): boolean {
    return this.videoH264 && !this.observingNow;
  }

  /** Whether the watchers' link carries clearly less than the video's rate (by the encoders' own margin, 1.5×), while
   * both are H.264: they get an encode of their own then. */
  private slowLink(): boolean {
    return this.liveH264() && this.recordsH264() && !this.slowFailed && kbpsFor(this.watcher!.kbps) * 1.5 < MAX_KBPS;
  }

  /** Whether the watchers' H.264 comes from their own encoder now. */
  private ownLive(): boolean {
    return this.slow?.ready === true && this.slowLink();
  }

  /** The encoder the watchers' H.264 comes from now. */
  private liveEncoder(): LiveEncoding | undefined {
    return this.ownLive() ? this.slow!.enc : this.encoder;
  }

  private stopSlow(): void {
    if (!this.slow) return;
    const wasOwn = this.slow.ready;
    this.slow.enc.stop();
    this.slow = undefined;
    // Back on the video's frames: from its next keyframe.
    if (wasOwn && this.liveH264()) {
      this.keyWanted = true;
      this.encoder?.key();
    }
  }

  /** A grab to the H.264 encoders, for a watcher that decodes it or the video: true if it went (their frames come from
   * there); false for JPEG (none wanted, no BGRA grabs, or no encoder yet or at all). The video's bit rate is its own;
   * the watchers' is their link's, from the same encoder while their link carries the video's. */
  private toEncoder(raw: Raw): boolean {
    const live = this.liveH264();
    const record = this.recordsH264();
    if ((!live && !record) || !this.encoder || this.screen.bgra !== true) {
      this.encoder?.stop();
      this.stopSlow();
      // This grab's change isn't in the picture: the next one it takes is converted whole.
      this.nv12.forget();
      return false;
    }
    const picture = this.nv12.update(raw.data, raw.width, raw.height, raw.changed ?? undefined);
    const input: Input = { nv12: [this.nv12.width, this.nv12.height] };
    const at = this.offsetMs();
    // Before the video's frame: once the watchers are back on its frames, they wait for its keyframe.
    if (!this.slowLink()) this.stopSlow();
    const went = this.encoder.put(input, picture, record ? undefined : this.watcher!.kbps, at);
    if (this.slowLink()) {
      if (!this.slow && this.makeEncoder) {
        const enc = this.makeEncoder(
          (f, i, atMs) => this.encoded(f, i, atMs, true),
          (why) => {
            console.warn(`desktop ${this.id}: the watchers share the video's H.264: ${why}`);
            this.slowFailed = true;
            this.stopSlow();
          },
        );
        const slow = { enc, ready: false };
        this.slow = slow;
        // Its first frame, a keyframe, is the watchers' first from it; the video's serve them until then.
        void (enc.ready?.() ?? Promise.resolve(true)).then((ok) => {
          if (this.slow === slow) slow.ready = ok;
        });
      }
      if (this.slow?.ready) this.slow.enc.put(input, picture, this.watcher!.kbps, at);
    }
    return went;
  }

  /** An encoded frame: the video's encoder's into the video, and to the watchers from the encoder that serves them. */
  private encoded(f: Encoded, input: Input, atMs: number, own: boolean): void {
    if (this.closed || "jpeg" in input) return;
    const [width, height] = "nv12" in input ? input.nv12 : input.raw;
    // A video that started as JPEG (the encoder came late) can't take it: from then on it is JPEG's.
    if (!own && this.recordsH264() && this.recording?.video?.h264?.(f.data, f.key, [width, height], atMs) === false) this.videoH264 = false;
    const w = this.watcher;
    if (!w || !this.liveH264() || own !== this.ownLive()) return;
    if (this.keyWanted) {
      if (!f.key) return;
      this.keyWanted = false;
    }
    if (f.ms !== undefined) perf.encoded(this.id, f.ms);
    w.send({ sessionId: this.id, seq: ++this.liveSeq, width, height, control: this.controlNow, h264B64: Buffer.from(f.data).toString("base64"), key: f.key });
  }

  /** The least time between frames now (fpsFor's rules). */
  private frameGap(): number {
    const w = this.watcher;
    const max = w ? LIVE_FPS : RECORD_FPS;
    const kbps = this.liveH264() ? kbpsFor(w!.kbps) : undefined;
    const load = this.load();
    const fps = fpsFor(max, kbps, load, w?.fps);
    if (w) perf.note(this.id, { encoder: this.liveH264() ? "x264" : "jpeg", capFps: fps, capBy: capBy(max, kbps, load, w.fps) });
    return 1000 / fps;
  }

  /** The frame rate for the screen's stream's H.264 (hardware: up to 60). */
  private streamFps(): number {
    const w = this.watcher;
    const fps = fpsFor(HARDWARE_FPS, kbpsFor(w?.kbps), this.load(), w?.fps);
    perf.note(this.id, { encoder: "hardware", capFps: fps, capBy: capBy(HARDWARE_FPS, kbpsFor(w?.kbps), this.load(), w?.fps) });
    return fps;
  }

  /** The screen's stream, where it has one, for as long as someone watches; the grabs' frames if it can't run. */
  private async startStream(): Promise<void> {
    const open = this.screen.stream;
    if (!open || this.streamFailed !== undefined || this.starting || this.closed) return;
    this.starting = true;
    let run: StreamRun;
    try {
      run = await open.call(this.screen, (f) => this.streamed(f));
    } catch (e) {
      this.streamFailed = (e as Error).message;
      console.warn(`desktop ${this.id}: the live view reads the screen itself: ${this.streamFailed}`);
      return;
    } finally {
      this.starting = false;
    }
    if (!this.watcher || this.closed) return run.stop();
    this.streaming = run;
    this.tellStream();
    void run.ended.then((why) => {
      if (this.streaming !== run) return;
      this.streaming = undefined;
      this.streamFailed = why ?? "it stopped";
      console.warn(`desktop ${this.id}: the live view reads the screen itself: ${this.streamFailed}`);
    });
  }

  private tellStream(): void {
    const run = this.streaming;
    const w = this.watcher;
    if (!run || !w) return;
    run.tell(w.video ? "h264" : "jpeg");
    run.tell(`kbps ${kbpsFor(w.kbps)}`);
    if (!w.video) return void (this.toldFps = undefined);
    this.toldFps = this.streamFps();
    run.tell(`fps ${this.toldFps}`);
  }

  /** A frame of the stream, to the watcher: with H.264 every frame at once and in order (the JPEG still before a
   * keyframe among them); JPEG alone as the grabs' go, fitted to the link. */
  private streamed(f: StreamFrame): void {
    const w = this.watcher;
    if (this.closed || !w) return;
    const [width, height] = f.screen;
    const frame: BrowserFrame = {
      sessionId: this.id,
      seq: ++this.liveSeq,
      width,
      height,
      control: this.controlNow,
      ...(f.kind === "h264" ? { h264B64: Buffer.from(f.data).toString("base64"), key: f.key } : { jpegB64: Buffer.from(f.data).toString("base64") }),
    };
    if (f.kind === "h264" || w.video) return w.send(frame);
    this.last = frame;
    this.pending = true;
    this.sendLive(false);
  }

  /** The newest frame to the watcher, if it waits and the link has room for it now (or `now` anyway): the last grab made
   * a JPEG first, if it isn't yet. */
  private sendLive(now: boolean): void {
    const raw = this.unencoded;
    if (raw && this.watcher && now) {
      this.unencoded = undefined;
      const grabs = this.grabs;
      void this.screen.encode(raw).then(
        (jpeg) => {
          if (this.closed) return;
          // A newer grab came meanwhile: that one goes instead.
          if (this.grabs !== grabs) return this.sendLive(true);
          this.last = { sessionId: this.id, seq: ++this.liveSeq, jpegB64: Buffer.from(jpeg).toString("base64"), width: raw.width, height: raw.height, control: this.controlNow };
          this.sendLive(true);
        },
        (e: Error) => console.warn(`desktop ${this.id}: ${e.message}`),
      );
      return;
    }
    const watcher = this.watcher;
    const last = this.last;
    if (!watcher || !last || !(this.pending || now)) return;
    if (!now && this.pacer.wait(watcher.kbps) > 0) return;
    this.pending = false;
    void this.pacer.fit(watcher.kbps, last).then((fitted) => this.watcher?.send(fitted));
  }

  /** A new screen: into the video (not while it only observes, nor when the video is H.264), and to the hub while it
   * watches (unless the screen's stream or the H.264 encoder sends the live view's frames: `live` false, kept only as
   * the newest picture). */
  private frame(jpeg: Uint8Array, width: number, height: number, live = true): void {
    if (this.closed) return;
    if (!this.observingNow && !this.videoH264) this.recording?.video?.frame(jpeg, this.offsetMs());
    this.unencoded = undefined;
    this.grabs++;
    if (this.streaming) return;
    this.liveSeq++;
    this.last = {
      sessionId: this.id,
      seq: this.liveSeq,
      jpegB64: Buffer.from(jpeg).toString("base64"),
      width,
      height,
      control: this.controlNow,
    };
    if (!live) return;
    this.pending = true;
    this.sendLive(false);
  }

  /** What the watchers ask for now, as the picture takes it. */
  private watching(): Watching {
    const w = this.watcher;
    return w && { kbps: w.kbps, video: w.video === true, ...(w.fps !== undefined ? { fps: w.fps } : {}), ...(w.relay === false ? { relay: false } : {}) };
  }

  /** An app's screen peer (the hub's `browser_rtc`): to the picture, which answers it where it is made. False when
   * this session takes none (it reads its screen here: the node's own peers serve it). */
  rtc(frame: BrowserRtcFrame): boolean {
    if (!this.picture) return false;
    const { sessionId: _id, ...rest } = frame;
    this.picture.rtc(rest);
    return true;
  }

  /** The display's picture, read where it runs, while the session lives; the session reads the screen itself if it
   * can't start, or once it stopped by itself. */
  private async readPicture(): Promise<void> {
    const video = this.recording?.video;
    const kind: VideoKind = !video ? "none" : video.h264 ? "h264" : "jpeg";
    let run: PictureRun;
    try {
      run = await this.lent!.picture!({ video: kind, session: this.id }, { live: (f) => this.pictured(f), video: (f) => this.videoFrame(f), rtc: (r) => this.rtcReport?.(r) });
    } catch (e) {
      if (this.closed) return;
      console.warn(`desktop ${this.id}: the screen is read from here: ${(e as Error).message}`);
      return this.capture();
    }
    if (this.closed) return run.stop();
    this.picture = run;
    // Its frames come stamped from the box: they go on as they come.
    perf.relay(this.id, true);
    run.control(this.controlNow);
    run.watch(this.watching());
    const why = await run.ended;
    this.picture = undefined;
    perf.relay(this.id, false);
    if (this.closed || why === undefined) return;
    console.warn(`desktop ${this.id}: the screen is read from here: ${why}`);
    return this.capture();
  }

  /** A frame of the picture's, to the watchers: as this session's, under its seq and who drives. */
  private pictured(f: LiveFrame): void {
    const w = this.watcher;
    if (this.closed || !w) return;
    // The picture's own seq where it gives one: its peers' frames carry the same.
    const { seq, ...picture } = f;
    this.liveSeq = Math.max(this.liveSeq + 1, seq ?? 0);
    w.send({ ...picture, sessionId: this.id, seq: this.liveSeq, control: this.controlNow });
  }

  /** A frame of the picture's, into the video (not while the session only observes). */
  private videoFrame(f: VideoFrame): void {
    const video = this.recording?.video;
    if (this.closed || this.observingNow || !video) return;
    const at = this.offsetMs();
    if (f.kind === "jpeg") return video.frame(f.data, at);
    // A video that started as JPEG can't take it: from then on it is JPEG's.
    if (video.h264?.(f.data, f.key, f.size, at) !== true) this.picture?.videoJpeg();
  }

  /** Reads the screen while the session lives: a new frame whenever it changed. */
  private async capture(): Promise<void> {
    // The video is H.264 from its first frame on when the encoder can make it: known before the first grab (at once
    // where its ffmpeg is here, a few seconds the first time it is fetched).
    if (this.recording?.video?.h264 && this.encoder?.ready && this.screen.bgra === true) {
      let timer: Timer | undefined;
      this.videoH264 = await Promise.race([this.encoder.ready(), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), READY_MS)))]);
      clearTimeout(timer);
    }
    // Where the screen doesn't say what changed: whether it did, by its pixels' hash.
    let lastHash: bigint | undefined;
    let lastFull = performance.now() - FULL_EVERY;
    // When a read of only what changed last came, until a whole read: its settle read is due SETTLE after.
    let partial: number | undefined;
    // Frames at the rate with two in reserve: a key's echo goes at once, a run of changes is paced.
    const pace = new Pace(performance.now(), this.frameGap());
    let sent = false;
    while (!this.closed) {
      // An observer reads the screen only for a person watching it, and not while the screen's stream shows it them.
      if (this.observingNow && (!this.watched() || this.streaming)) {
        await Bun.sleep(FRAME_EVERY);
        continue;
      }
      const started = performance.now();
      const changed = this.screen.changed();
      const full = started - lastFull >= FULL_EVERY || (!changed && partial !== undefined && started - partial >= SETTLE);
      try {
        if (changed || full) {
          const raw = await this.screen.serial(() => this.screen.grabRaw(full));
          if (full) {
            lastFull = performance.now();
            partial = undefined;
          } else if (this.screen.nextChange) partial = performance.now();
          let fresh = raw.changed !== null;
          if (raw.changed === undefined) {
            const hash = Bun.hash.xxHash64(raw.data) ^ BigInt(raw.width * 65536 + raw.height);
            fresh = hash !== lastHash;
            lastHash = hash;
          }
          sent = fresh;
          if (fresh && !this.closed) {
            const encoded = this.toEncoder(raw);
            const live = encoded && this.liveH264();
            // A JPEG for a watcher that can't decode H.264, or for a video that isn't H.264; else only once a watcher
            // needs a picture of it.
            const forVideo = !this.observingNow && this.recording?.video !== undefined && !(encoded && this.recordsH264());
            if (forVideo || (this.watcher !== undefined && !live)) this.frame(await this.screen.encode(raw), raw.width, raw.height, !live);
            else {
              this.unencoded = raw;
              this.grabs++;
            }
          }
        }
      } catch (e) {
        if (this.closed) return;
        console.warn(`desktop ${this.id}: the screen is not read: ${(e as Error).message}`);
        this.setNote(`the screen stopped being read: ${(e as Error).message}`);
        return;
      }
      this.sendLive(false);
      const spent = performance.now() - started;
      const next = this.screen.nextChange;
      if (!next) {
        await Bun.sleep(Math.max(0, FRAME_EVERY - spent));
        continue;
      }
      // Only a frame spends: a read that found nothing (a settle read, a still screen's) leaves the next change free.
      const gap = this.frameGap();
      const read = performance.now();
      if (sent) pace.spend(read, gap);
      await Bun.sleep(Math.max(pace.waitMs(read, gap), sent ? spent / WORK_SHARE - spent : 0));
      sent = false;
      // Then nothing until the screen changes, or a whole read is due (the settle read, or the one every FULL_EVERY).
      const now = performance.now();
      const due = Math.min(FULL_EVERY - (now - lastFull), partial === undefined ? FULL_EVERY : SETTLE - (now - partial));
      if (!this.closed) await next.call(this.screen, Math.max(0, due));
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
    if (this.recording) {
      this.latest?.note(this.recording.key ?? this.id, this.id, clean);
      try {
        this.recording.append("actions", JSON.stringify(clean));
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
            : await this.screen.serial(() => act(this.screen, call, this.picture));
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
    // A hosted agent on this machine's display: what it launches would run outside its box. One whose display is in its
    // box (../place/box_screens.ts) launches there, with its files.
    const refused = this.lent?.inBox ? undefined : this.launchRefusal?.();
    if (refused) throw new Error(refused);
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

  /** The app an agent-desktop command names, as the Mac's claims know it; undefined where the session can't tell. */
  async appOf(target: Target): Promise<App | undefined> {
    if (!this.lent?.appOf) return undefined;
    return this.lent.appOf(target);
  }

  /** Starts an app on the display. */
  launch(command: string): Promise<Launched> {
    if (!this.lent) throw new Error("the session has ended");
    return this.lent.launch(command, this.cwd);
  }

  /** Stops reading the screen and lets go of its connection, leaving the display and the recording as they are: a
   * new holder goes on with both (DesktopSessions `letGo`). */
  async detach(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher = undefined;
    clearInterval(this.ticker);
    this.picture?.stop();
    await this.capturing;
    this.encoder?.stop();
    this.stopSlow();
    this.screen.close();
    this.lent = undefined;
  }

  /**
   * Stops reading the screen, throws the display away with everything on it, and ends the recording: its video
   * finished, its action log scrubbed once more whole with every secret known. Returns the recording's files there are.
   */
  async close(): Promise<[string, number][]> {
    perf.forget(this.id);
    if (this.closed) return this.closedFiles;
    this.closed = true;
    this.watcher = undefined;
    clearInterval(this.ticker);
    this.picture?.stop();
    await this.capturing;
    this.encoder?.stop();
    this.stopSlow();
    this.screen.close();
    const lent = this.lent;
    this.lent = undefined;
    await lent?.drop();
    if (!this.recording) return [];
    try {
      const ended = { endedAt: new Date().toISOString(), credentialsFilled: 0, ...(this.noteText !== undefined ? { note: this.noteText } : {}) };
      const done = await this.recording.end(ended, this.scrub, this.offsetMs());
      if (done.note !== undefined) this.noteText = done.note;
      this.closedFiles = done.files.map((f) => [f.file, f.bytes]);
    } catch (e) {
      console.warn(`desktop ${this.id}: recording not ended: ${(e as Error).message}`);
      this.setNote(`its recording didn't end: ${(e as Error).message}`);
    }
    return this.closedFiles;
  }
}

const point = (c: [number, number] | undefined) => (c ? ([c[0], c[1]] as [number, number]) : undefined);

/** One `desktop` action on the screen; a screenshot from `picture` where the display reads itself. */
export async function act(x: Screen, call: DesktopCall, picture?: Pick<PictureRun, "shot">): Promise<DesktopDone> {
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
      // Everything sent before it lands first.
      await x.sync();
      const shot = picture ? await picture.shot() : await x.grab();
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
