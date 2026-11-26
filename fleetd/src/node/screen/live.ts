// What a live view's screen and its encoders say to each other, with nothing of the machine's: the frames of a
// screen's own stream (./mac_frames.ts, fleetd-frames on the agents' Mac), the commands it takes, and an H.264
// encoder's shape (./x264.ts) as a session is handed one. Pure (docs/CONTRIBUTING.md "The package"): the sessions
// the package exports import it, and the node's own entry points make the encoders and streams.

/** A command to a screen's stream: frames as JPEG, H.264, or both (H.264, and JPEG at a lower rate for watchers that
 * take only JPEG), a keyframe next, a still now, the H.264 bit rate, the frame rate, the picture's longer side, which
 * display a simulator shows (`panel <name>`, `panel -` the one that changed last); and on a stream that takes input
 * (StreamRun `input`), a person's: a finger in
 * the screen's pixels (`edge` 0, or the edge it starts at: 1 top, 2 left, 3 bottom, 4 right), a key by its USB HID
 * usage, the home button. */
export type Command =
  | "jpeg"
  | "h264"
  | "both"
  | "key"
  | "still"
  | `kbps ${number}`
  | `fps ${number}`
  | `side ${number}`
  | `panel ${string}`
  | `touch ${"down" | "move" | "up"} ${number} ${number} ${number}`
  | `keyboard ${number} ${"down" | "up"}`
  | "button home";

/** A frame of a screen's stream. `screen` is the screen's own size (input coordinates are in it); the picture
 * (`picture`, where the stream says it) may be smaller. */
export type StreamFrame = { kind: "jpeg" | "h264"; key: boolean; screen: [number, number]; picture?: [number, number]; data: Uint8Array };

/** A running stream: `still` asks for the screen now (a JPEG), changed or not; `tell` gives it a command; `ended`
 * says why it stopped by itself; `input` whether it takes a person's input itself now, `inputPending` whether a
 * simulator's helper hasn't said yet if it will. */
export type StreamRun = {
  still(): void;
  tell(command: Command): void;
  stop(): void;
  ended: Promise<string | undefined>;
  input?: () => boolean;
  inputPending?: () => boolean;
};

/** One encoded frame: an access unit in Annex B, its parameter sets first on a keyframe; `ms`, the encoder's time
 * from the frame in to it out, where the node encoded it. */
export type Encoded = { data: Uint8Array; key: boolean; ms?: number };

/** What frames go into an encoder: a screen's raw pixels (32 bits each, BGRA in memory) at its size, its picture as
 * NV12 (./nv12.ts, an even size), or JPEGs of a size. */
export type Input = { raw: [number, number] } | { nv12: [number, number] } | { jpeg: [number, number] };

/** A live view's encoder over its life (x264.ts's LiveEncoder): `put` answers false when the frame didn't go (none
 * yet, or none at all: the screen sends JPEG); `atMs`, the frame's time, comes back with what it is made into.
 * `ready` says whether it can encode, once it knows (its ffmpeg fetched, or not). */
export type LiveEncoding = {
  key(): void;
  put(input: Input, data: Uint8Array, kbps: number | undefined, atMs?: number): boolean;
  stop(): void;
  ready?(): Promise<boolean>;
};

/** Makes a session's encoder, its frames to `onFrame` with the time each was put at; `onFail` once it can't encode. */
export type MakeEncoder = (onFrame: (frame: Encoded, input: Input, atMs: number) => void, onFail: (why: string) => void) => LiveEncoding;

/** The H.264 bit rate at most, in kbit/s: 1280×800 at 30 fps, text sharp. */
export const MAX_KBPS = 2_500;

/** The share of the watchers' links H.264 takes when they are its bound. */
export const LINK_SHARE = 0.7;

/** The bit rate for watchers whose links carry `kbps` (undefined: they keep up). */
export const kbpsFor = (kbps: number | undefined) => (kbps === undefined ? MAX_KBPS : Math.min(MAX_KBPS, Math.max(100, Math.round(kbps * LINK_SHARE))));

/** Frames a second at most where the screen encodes in hardware (VideoToolbox on the Mac and its simulators). */
export const HARDWARE_FPS = 60;

/** The H.264 bits a frame gets at least, in kbit, before the frame rate drops for a slow link: a frame starved of bits
 * comes out blurred, and fewer sharp ones read better. */
export const KBIT_PER_FRAME = 40;
/** The frame rates a screen steps between, so the same link and load always give the same rate. */
const STEPS = [60, 30, 20, 15, 10, 5];
/** The machine's load per core (the 1-minute load average over its cores) past which a screen takes half its frames,
 * and past which a third: it gives way to the work the machine is busy with. */
export const BUSY = 1.5;
export const VERY_BUSY = 3;

/**
 * Frames a second at most, by fixed rules: what the screen's encoder makes (`max`), the H.264 bit rate the watchers'
 * links carry (`kbps`, undefined for JPEG: its frames are fitted to the link as they go), the machine's load per core,
 * and what the watcher asked for (`asked`). Each cut takes the next step down at or under it.
 */
export function fpsFor(max: number, kbps: number | undefined, load: number, asked?: number): number {
  let fps = max;
  if (kbps !== undefined) fps = Math.min(fps, kbps / KBIT_PER_FRAME);
  if (load >= VERY_BUSY) fps = Math.min(fps, max / 3);
  else if (load >= BUSY) fps = Math.min(fps, max / 2);
  if (asked !== undefined && asked > 0) fps = Math.min(fps, asked);
  return STEPS.find((s) => s <= fps) ?? STEPS.at(-1)!;
}

/** What holds a screen at fpsFor's rate under `max`: the bound alone at the rate, the machine's load before the link
 * before the watcher's ask when two give it; undefined at `max`. */
export function capBy(max: number, kbps: number | undefined, load: number, asked?: number): "busy" | "link" | "asked" | undefined {
  const fps = fpsFor(max, kbps, load, asked);
  if (fps >= max) return undefined;
  if (fpsFor(max, undefined, load) === fps) return "busy";
  if (fpsFor(max, kbps, 0) === fps) return "link";
  return asked !== undefined && asked > 0 ? "asked" : undefined;
}

/** Frames a screen may send at once after a quiet spell (a key's echo, a click and its menu) before its frame rate
 * paces them: a change that comes alone goes at once, and only a run of them waits. */
export const BURST = 2;

/**
 * Paces a screen's frames at a rate with BURST in reserve (screen-relay's capture bucket): credit refills with time up
 * to BURST frames' worth, and only a frame sent spends it, so a read that found nothing new costs no wait. Times are
 * ms (performance.now()).
 */
export class Pace {
  private credit: number;
  private at: number;

  constructor(now: number, gapMs: number) {
    this.credit = BURST * gapMs;
    this.at = now;
  }

  private refill(now: number, gapMs: number): void {
    this.credit = Math.min(BURST * gapMs, this.credit + Math.max(0, now - this.at));
    this.at = Math.max(this.at, now);
  }

  /** A frame went at `now`, at `gapMs` between frames. */
  spend(now: number, gapMs: number): void {
    this.refill(now, gapMs);
    this.credit = Math.max(0, this.credit - gapMs);
  }

  /** How long from `now` until the next frame may go. */
  waitMs(now: number, gapMs: number): number {
    this.refill(now, gapMs);
    return Math.max(0, gapMs - this.credit);
  }
}
