// The one screen player: live view and replay draw into the same canvas (surface.ts's ScreenSurface, which a device
// frame takes), each picture at its own size, so nothing is letterboxed and the canvas never shows blank.
//
// A replay decodes its recording's H.264 (mp4.ts) with WebCodecs on its own clock: at 1×, 2× or 4× it feeds the
// decoder a little ahead of the clock and draws, at each animation frame, the newest picture due. A seek decodes from
// the keyframe before the time asked (2 s at most back in the node's own recordings) and draws only the picture due
// then, never those it decoded on the way: the canvas keeps the picture it had until the new one is ready, so a seek
// or a change of speed never flashes. Every frame of the recording is decoded, in order, so none is missing.
import { chunkData, type Sample, shownAt, type Track } from "./mp4";
import type { ScreenSurface } from "./surface";

/** How far ahead of the clock the decoder is fed, in ms of the recording at 1× (times the speed). */
const LEAD_MS = 500;
/** Pictures decoded and not yet drawn, at most: the feed waits past it. */
const QUEUE = 12;
/** Chunks in the decoder, at most. */
const DECODING = 8;
/** How far the clock may run past a picture due that is still decoding: past it, the clock waits for it (a 4× replay on
 * a slow machine plays as fast as it decodes, never frozen while its time runs on). It never goes back: a still
 * stretch of the recording (the node writes a frame only when the screen changes) waits for nothing. */
const STALL_MS = 150;
/** A picture the decoder hasn't given this long after it was fed (wall ms) is given up on: the clock goes on. */
const GIVE_UP_MS = 2_000;

/** A decoded picture: what VideoFrame gives, as the player uses it. */
export type Picture = { readonly timestamp: number; readonly displayWidth: number; readonly displayHeight: number; close(): void };

/** WebCodecs' VideoDecoder, as the player uses it (a test's stand-in in tests). */
export type Decoder = {
  readonly decodeQueueSize: number;
  readonly state: string;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: { type: "key" | "delta"; timestamp: number; data: Uint8Array }): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
};
export type MakeDecoder = (output: (p: Picture) => void, error: (e: Error) => void) => Decoder;

const webCodecs: MakeDecoder = (output, error) => {
  const d = new VideoDecoder({ output, error });
  return {
    get decodeQueueSize() {
      return d.decodeQueueSize;
    },
    get state() {
      return d.state;
    },
    configure: (c) => d.configure(c),
    decode: (c) => d.decode(new EncodedVideoChunk(c)),
    flush: () => d.flush(),
    reset: () => d.reset(),
    close: () => d.close(),
  };
};

/** Where pictures are drawn: a canvas, sized to each picture. */
export type Canvas = { width: number; height: number; getContext(kind: "2d"): { drawImage(image: never, x: number, y: number): void } | null };

/**
 * The surface: a canvas that takes each picture at its size, and says so to whoever listens (a 3D device frame's
 * texture updates on it, on demand).
 */
export class Surface implements ScreenSurface {
  private readonly listeners = new Set<() => void>();
  width = 0;
  height = 0;
  panel?: "inner" | "outer";

  constructor(readonly element: HTMLCanvasElement) {}

  /** Draws `image` (a VideoFrame, an ImageBitmap) at its size: the canvas is resized only when the size changes, in the
   * same task as the drawing, so it never shows cleared. */
  draw(image: CanvasImageSource, width: number, height: number): void {
    const c = this.element as unknown as Canvas;
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    c.getContext("2d")?.drawImage(image as never, 0, 0);
    this.width = width;
    this.height = height;
    for (const fn of this.listeners) fn();
  }

  /** Whether anyone takes its pictures (a 3D frame's texture): a hidden canvas nobody takes needs none drawn. */
  taken(): boolean {
    return this.listeners.size > 0;
  }

  onPicture(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Puts the canvas in `host` (the page's place in a frame); the returned function takes it out. */
  mount(host: HTMLElement | null): (() => void) | undefined {
    if (host === null) return undefined;
    host.append(this.element);
    return () => this.element.remove();
  }

  /** The canvas's class, and whether it shows (`on`: the live view's canvas over its JPEG; undefined, always). */
  look(className: string | undefined, on?: boolean): void {
    this.element.className = className ?? "";
    if (on === true || on === undefined) this.element.dataset["on"] = "";
    else delete this.element.dataset["on"];
  }
}

/** A clock that runs at a speed: the recording's time from `at` (ms) as of `since` (the page's ms). */
type Clock = { at: number; since: number; speed: number; playing: boolean };

/**
 * Plays a recording's track into a surface. `onTime` hears the time as it plays and where a seek lands; `onEnd` when
 * it reaches its end. `now` and `frame` are the page's clock and animation frames (a test's stand-ins in tests).
 */
export class Replay {
  private readonly decoder: Decoder;
  private clock: Clock;
  /** The next sample to feed, in decode order. */
  private fed = 0;
  /** Pictures decoded, by time, not yet drawn. */
  private queue: Picture[] = [];
  /** No picture before this time is drawn: the one a seek asked for, and none of those decoded on the way to it. */
  private floor = Number.NEGATIVE_INFINITY;
  /** The picture to draw once it comes, when paused: a seek's. */
  private wanted: number | undefined;
  /** The time of the picture on the canvas: decoded again (play after a paused seek), it isn't drawn again. */
  private onCanvas: number | undefined;
  /** Samples fed and not yet decoded, since the last seek: their times, and when each was fed (wall ms). */
  private decoding: { pts: number; at: number }[] = [];
  /** The time the last animation frame showed: the clock never goes back from it but by a seek. */
  private shownTime = 0;
  /** Bumped at each seek: a flush of the one before draws nothing. */
  private generation = 0;
  /** The decoder was flushed (a paused seek, the end): the next chunk it takes must be a keyframe. */
  private flushed = false;
  private ticking = false;
  private closed = false;
  private failed = false;

  constructor(
    private readonly file: Uint8Array,
    private readonly track: Track,
    private readonly surface: Pick<Surface, "draw">,
    private readonly hooks: { onTime?: (ms: number) => void; onEnd?: () => void; onError?: (why: string) => void; onDraw?: (pts: number) => void } = {},
    private readonly env: { make?: MakeDecoder; now?: () => number; frame?: (fn: () => void) => void } = {},
  ) {
    this.decoder = (env.make ?? webCodecs)(
      (p) => this.output(p),
      (e) => this.fail(e.message),
    );
    this.configure();
    this.clock = { at: 0, since: this.now(), speed: 1, playing: false };
  }

  private now(): number {
    return (this.env.now ?? (() => performance.now()))();
  }

  private configure(): void {
    const { codec, description } = this.track;
    // Annex B (avc3: no description) decodes under the avc1 name WebCodecs knows.
    this.decoder.configure({ codec: codec.replace(/^avc3\./, "avc1."), optimizeForLatency: true, ...(description ? { description } : {}) });
  }

  /** The recording's time now. */
  time(): number {
    const c = this.clock;
    return Math.min(this.track.endMs, c.playing ? c.at + (this.now() - c.since) * c.speed : c.at);
  }

  playing(): boolean {
    return this.clock.playing;
  }

  play(): void {
    if (this.clock.playing || this.closed || this.failed) return;
    const from = this.time() >= this.track.endMs ? 0 : this.time();
    // After a paused seek the decoder was flushed: it starts again at the keyframe before.
    if (this.flushed || this.wanted !== undefined || from === 0) this.restart(from);
    this.clock = { at: from, since: this.now(), speed: this.clock.speed, playing: true };
    this.shownTime = from;
    this.tick();
  }

  pause(): void {
    if (!this.clock.playing) return;
    this.clock = { ...this.clock, at: this.time(), since: this.now(), playing: false };
  }

  /** 1×, 2×, 4×: the clock goes on from where it is, nothing is decoded again, nothing redrawn. */
  speed(speed: number): void {
    this.clock = { ...this.clock, at: this.time(), since: this.now(), speed };
  }

  /** Shows `ms`: decoded from the keyframe before it, only its picture drawn; the canvas keeps the last until then. */
  seek(ms: number): void {
    const t = Math.max(0, Math.min(ms, this.track.endMs));
    // At the end (a session longer than its video): its last picture, paused there.
    const playing = this.clock.playing && t < this.track.endMs;
    if (this.clock.playing && !playing) this.hooks.onEnd?.();
    this.clock = { ...this.clock, at: t, since: this.now(), playing };
    this.shownTime = t;
    this.hooks.onTime?.(t);
    if (this.failed) return;
    this.restart(t);
    if (this.clock.playing) return this.tick();
    // Paused: decode up to the picture shown at `t` (and past it while frames reorder), DECODING chunks at a time, then
    // flush it out.
    const at = shownAt(this.track.samples, t);
    if (!at) return;
    this.wanted = at.pts;
    const generation = this.generation;
    const step = () => {
      if (generation !== this.generation || this.closed || this.failed) return;
      const more = () => this.fed < this.track.samples.length && (this.fed <= at.shown || this.dtsOf(this.fed) <= at.pts);
      while (more() && this.decoder.decodeQueueSize < DECODING) this.feed();
      if (more()) return this.frame(step);
      this.flushed = true;
      this.decoder.flush().then(
        () => {
          if (generation === this.generation) this.drawWanted();
        },
        () => {},
      );
    };
    step();
  }

  private frame(fn: () => void): void {
    (this.env.frame ?? ((f) => requestAnimationFrame(f)))(fn);
  }

  /** Feeding starts again at the keyframe before `t`; pictures before the one shown at `t` are decoded, never drawn. */
  private restart(t: number): void {
    this.generation += 1;
    if (this.decoder.state === "closed") return this.fail("the decoder closed");
    if (this.decoder.state === "configured") this.decoder.reset();
    this.configure();
    for (const p of this.queue) p.close();
    this.queue = [];
    this.flushed = false;
    this.wanted = undefined;
    this.decoding = [];
    const at = shownAt(this.track.samples, t);
    this.fed = at?.from ?? 0;
    this.floor = at ? at.pts : Number.NEGATIVE_INFINITY;
  }

  /** The decode time of the sample at `i` (past the end: never). */
  private dtsOf(i: number): number {
    return this.track.samples[i]?.dts ?? Number.POSITIVE_INFINITY;
  }

  private feed(): void {
    const s: Sample | undefined = this.track.samples[this.fed++];
    if (s === undefined) return;
    this.decoding.push({ pts: s.pts, at: this.now() });
    try {
      this.decoder.decode({ type: s.key ? "key" : "delta", timestamp: Math.round(s.pts * 1000), data: chunkData(this.file, this.track, s) });
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private output(p: Picture): void {
    const pts = p.timestamp / 1000;
    const i = this.decoding.findIndex((d) => Math.abs(d.pts - pts) < 0.5);
    if (i >= 0) this.decoding.splice(i, 1);
    if (this.closed || pts < this.floor - 0.5) return p.close();
    this.queue.push(p);
    this.queue.sort((a, b) => a.timestamp - b.timestamp);
    if (!this.clock.playing && this.wanted !== undefined) return;
    if (!this.clock.playing) this.present(this.time());
  }

  /** The paused seek's picture, once flushed out: the newest at or before the time asked. */
  private drawWanted(): void {
    // Before the recording's first picture, that picture: never a blank canvas.
    this.present(Math.max(this.clock.at, this.wanted ?? 0));
    this.wanted = undefined;
  }

  /** Draws the newest picture due at `t` (none before the floor) and lets go of those before it. */
  private present(t: number): void {
    let pick = -1;
    this.queue.forEach((q, i) => {
      if (q.timestamp / 1000 <= t + 0.5) pick = i;
    });
    const p = this.queue[pick];
    if (p === undefined) return;
    for (const old of this.queue.slice(0, pick)) old.close();
    this.queue = this.queue.slice(pick + 1);
    if (p.timestamp === this.onCanvas) return p.close();
    this.onCanvas = p.timestamp;
    this.surface.draw(p as unknown as CanvasImageSource, p.displayWidth, p.displayHeight);
    p.close();
    this.hooks.onDraw?.(p.timestamp / 1000);
  }

  private tick(): void {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    const step = () => {
      this.ticking = false;
      if (this.closed || !this.clock.playing || this.failed) return;
      const samples = this.track.samples;
      let t = this.time();
      // A picture due and still decoding: the clock waits for it, never going back from what it last showed.
      const now = this.now();
      this.decoding = this.decoding.filter((d) => now - d.at < GIVE_UP_MS);
      const due = this.decoding.reduce((m, d) => (d.pts <= t ? Math.min(m, d.pts) : m), Number.POSITIVE_INFINITY);
      if (t > due + STALL_MS) {
        t = Math.max(this.shownTime, due + STALL_MS);
        this.clock = { ...this.clock, at: t, since: now };
      }
      this.shownTime = t;
      while (this.dtsOf(this.fed) <= t + LEAD_MS * this.clock.speed && this.decoder.decodeQueueSize < DECODING && this.queue.length < QUEUE) this.feed();
      // The last pictures held back by reordering come out at the end.
      if (this.fed >= samples.length && !this.flushed) {
        this.flushed = true;
        void this.decoder.flush().catch(() => {});
      }
      this.present(t);
      if (t >= this.track.endMs) {
        // Paused first, so the end's time reaches the scrubber whole, not throttled as a playing one is.
        this.pause();
        this.hooks.onTime?.(t);
        this.hooks.onEnd?.();
        return;
      }
      this.hooks.onTime?.(t);
      this.ticking = true;
      this.frame(step);
    };
    this.frame(step);
  }

  private fail(why: string): void {
    if (this.failed) return;
    this.failed = true;
    this.hooks.onError?.(why);
  }

  close(): void {
    this.closed = true;
    for (const p of this.queue) p.close();
    this.queue = [];
    try {
      this.decoder.close();
    } catch {
      // Closed already.
    }
  }
}
