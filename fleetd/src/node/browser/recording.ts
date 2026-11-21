// A screen session's recording, with nothing of the machine's: what it says of its session (`Meta`), the seam a broker
// writes it through (`Recording`, from a `RecordingStore`), the heartbeat's latest steps, the video as an MJPEG
// Matroska stream for an ffmpeg (`MkvVideo`), and the `browser_session` report of it. The node's store keeps it in a
// folder under its home and sends it to the hub (./record.ts); a service with no node passes its own.
import type { BrowserAction, BrowserControl, BrowserSessionState } from "../../shared/contracts.ts";
import type { Scrub } from "../mask.ts";
import { SCREEN_STEPS_MAX, STEP_ARGS_BYTES, STEP_RESULT_CHARS } from "../../shared/screens_wire.ts";

export const FPS = 25;
const framesAt = (ms: number) => Math.floor((ms * FPS) / 1000);
/** Seven days of tries, then the recording is reported lost. */
export const GIVE_UP_MS = 7 * 24 * 3600_000;

/** What a recording's folder says of its session, for an upload after a node restart too. */
export type Meta = {
  sessionId: string;
  kind: string;
  threadId: string;
  cwd: string;
  purpose: string;
  startedAt: string;
  endedAt?: string;
  credentialsFilled: number;
  note?: string;
  /** A session a new holder took over (BrowserBroker `adopt`): its recording goes on from where the last one left. */
  resumed?: boolean;
};

/** One session's recording as it is made. Every line comes scrubbed with what the session knew then. */
export interface Recording {
  /** What the heartbeat's latest steps know it by while it is kept (the node's: its folder); else the session's id. */
  readonly key?: string;
  /** One JSON line onto the action log or the DOM trace. */
  append(file: "actions" | "dom", line: string): void;
  /** Its video, where it keeps one; else `note` says why not. */
  readonly video?: Video;
  readonly note?: string;
  /** The session filled `count` values so far. */
  filled(count: number): void;
  /**
   * The session ended: the text files are scrubbed whole once more with `scrub` (a value filled later is in it), before
   * any of them goes anywhere a person reads, and the video is finished at `atMs`. Then it goes where recordings go,
   * reported `uploading`, `recorded` (or `lost`) by the store itself. Its files, and why it has no video if it hasn't.
   */
  end(ended: { endedAt: string; credentialsFilled: number; note?: string }, scrub: Scrub, atMs: number): Promise<{ files: { file: string; bytes: number }[]; note?: string }>;
}

/** Where a broker's recordings go: the node's folder under its home, sent to the hub (./record.ts), or a service's. */
export interface RecordingStore {
  /** A session's recording, as it starts (or as a new holder takes it over: `meta.resumed`). */
  open(meta: Meta): Recording | Promise<Recording>;
  /** Each minute: sends what is still to go, but the recordings of `live` sessions (ids). */
  sweep?(live: string[], now: number): Promise<void>;
}

/** A step as the heartbeat carries it: its args only when short, its result cut. */
export function brief(step: BrowserAction): BrowserAction {
  const args = JSON.stringify(step.args ?? {}).length > STEP_ARGS_BYTES ? {} : step.args;
  return { ...step, args, ...(step.result === undefined ? {} : { result: [...step.result].slice(0, STEP_RESULT_CHARS).join("") }) };
}

/** Each session's latest step, newest first, as the heartbeat carries them (record.rs `steps`). */
export class Steps {
  private readonly latest = new Map<string, { at: number; dir: string; step: BrowserAction }>();

  /** `stillThere`: whether a session's recording is still kept, by the key its steps were noted under (the node's:
   * its folder, which goes once the hub has it). */
  constructor(private readonly stillThere: (dir: string) => boolean = () => true) {}

  note(dir: string, sessionId: string, step: BrowserAction): void {
    this.latest.set(sessionId, { at: Date.now(), dir, step: brief(step) });
  }
  list(): { sessionId: string; step: BrowserAction }[] {
    for (const [id, s] of this.latest) if (Date.now() - s.at > 24 * 3600_000 || !this.stillThere(s.dir)) this.latest.delete(id);
    return [...this.latest.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, SCREEN_STEPS_MAX)
      .map(([sessionId, s]) => ({ sessionId, step: s.step }));
  }
}

// ---- the video: MJPEG in Matroska, for an ffmpeg ----

/** An EBML element's size, in the fewest bytes its marker allows. */
function size(n: number, out: number[]): void {
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const marked = BigInt(n) | (1n << BigInt(7 * len));
  for (let i = len - 1; i >= 0; i--) out.push(Number((marked >> BigInt(8 * i)) & 0xffn));
}
function element(id: number[], body: ArrayLike<number>, out: number[]): void {
  out.push(...id);
  size(body.length, out);
  for (let i = 0; i < body.length; i++) out.push(body[i]!);
}
function uint(id: number[], n: number, out: number[]): void {
  const bytes: number[] = [];
  let v = BigInt(n);
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  element(id, bytes, out);
}

/** The stream's header: EBML, an endless segment, its timescale (1 ms) and one MJPEG track of `width` x `height`. */
export function mkvHeader(width: number, height: number): Uint8Array {
  const out: number[] = [];
  const ebml: number[] = [];
  element([0x42, 0x82], [...Buffer.from("matroska")], ebml);
  uint([0x42, 0x87], 4, ebml);
  uint([0x42, 0x85], 2, ebml);
  element([0x1a, 0x45, 0xdf, 0xa3], ebml, out);
  out.push(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const info: number[] = [];
  uint([0x2a, 0xd7, 0xb1], 1_000_000, info);
  element([0x15, 0x49, 0xa9, 0x66], info, out);
  const video: number[] = [];
  uint([0xb0], width, video);
  uint([0xba], height, video);
  const track: number[] = [];
  uint([0xd7], 1, track);
  uint([0x73, 0xc5], 1, track);
  uint([0x83], 1, track);
  element([0x86], [...Buffer.from("V_MJPEG")], track);
  element([0xe0], video, track);
  const entry: number[] = [];
  element([0xae], track, entry);
  element([0x16, 0x54, 0xae, 0x6b], entry, out);
  return Uint8Array.from(out);
}

/** One frame as a cluster at `atMs`, shown for `showsMs`. */
export function mkvFrame(jpeg: Uint8Array, atMs: number, showsMs: number): Uint8Array {
  const head: number[] = [];
  const blockLen = jpeg.length + 4;
  // BlockGroup > Block, written around the JPEG without copying it into an array of numbers.
  const blockHead: number[] = [0xa1];
  size(blockLen, blockHead);
  blockHead.push(0x81, 0, 0, 0);
  const duration: number[] = [];
  uint([0x9b], showsMs, duration);
  const groupLen = blockHead.length + jpeg.length + duration.length;
  const time: number[] = [];
  uint([0xe7], atMs, time);
  const groupHead: number[] = [0xa0];
  size(groupLen, groupHead);
  const clusterLen = time.length + groupHead.length + groupLen;
  head.push(0x1f, 0x43, 0xb6, 0x75);
  size(clusterLen, head);
  return Buffer.concat([Uint8Array.from([...head, ...time, ...groupHead, ...blockHead]), jpeg, Uint8Array.from(duration)]);
}

/** Where the Matroska stream goes (an ffmpeg's stdin, here or in a box), and its end: why the video failed, if it did. */
export type VideoWriter = { write(bytes: Uint8Array): void; end(): Promise<string | undefined> };

/** A session's video as frames come: what the broker feeds, whatever makes the file. */
export interface Video {
  /** A frame of the screencast, `atMs` into the session. */
  frame(jpeg: Uint8Array, atMs: number): void;
  /** Called each second: a still page's frame keeps showing. */
  tick(atMs: number): void;
  /** Ends the stream at `atMs`; why the video failed, else undefined. */
  finish(atMs: number): Promise<string | undefined>;
}

/** The session's video as an MJPEG Matroska stream: each screencast frame held until the next, so the stream keeps FPS
 * frames a second. `continued`: the stream goes on one a holder before wrote the header of (an adopted session's),
 * so this one writes frames only. */
export class MkvVideo implements Video {
  private held: { jpeg: Uint8Array; tick: number } | undefined;
  private started: boolean;
  private broken: string | undefined;

  constructor(
    private readonly sizeOf: [number, number],
    private readonly out: VideoWriter,
    options: { continued?: boolean } = {},
  ) {
    this.started = options.continued === true;
  }

  private write(until: number, own: number): void {
    const held = this.held;
    if (!held) return;
    const ms = (tick: number) => Math.floor((tick * 1000) / FPS);
    const parts: Uint8Array[] = this.started ? [] : [mkvHeader(...this.sizeOf)];
    const cut = Math.max(until - own, held.tick + 1);
    parts.push(mkvFrame(held.jpeg, ms(held.tick), ms(cut - held.tick)));
    for (let tick = cut; tick < until; tick++) parts.push(mkvFrame(held.jpeg, ms(tick), ms(1)));
    try {
      for (const p of parts) this.out.write(p);
      this.started = true;
    } catch (e) {
      this.broken = `ffmpeg stopped taking frames (${(e as Error).message})`;
    }
  }

  frame(jpeg: Uint8Array, atMs: number): void {
    if (this.broken) return;
    const tick = framesAt(atMs);
    const from = this.held?.tick ?? 0;
    if (from < tick) {
      this.held ??= { jpeg, tick: 0 };
      this.write(tick, 1);
    }
    this.held = { jpeg, tick: Math.max(from, tick) };
  }

  tick(atMs: number): void {
    const due = framesAt(atMs);
    if (this.held && this.held.tick + FPS < due) {
      this.write(due - 1, 1);
      this.held.tick = due - 1;
    }
  }

  async finish(atMs: number): Promise<string | undefined> {
    if (this.broken) return this.broken;
    if (this.held) this.write(Math.max(framesAt(atMs), this.held.tick + 1), 2);
    return this.out.end();
  }
}

export type HubCall = (thread: string, cwd: string, op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function report(meta: Meta, state: BrowserSessionState, control: BrowserControl, sent: [string, number][]): Record<string, unknown> {
  return {
    sessionId: meta.sessionId,
    kind: meta.kind,
    threadId: meta.threadId,
    purpose: [...meta.purpose].slice(0, 200).join(""),
    state,
    control,
    startedAt: meta.startedAt,
    ...(meta.endedAt ? { endedAt: meta.endedAt } : {}),
    files: sent.map(([file, bytes]) => ({ file, bytes })),
    credentialsFilled: meta.credentialsFilled,
    ...(meta.note ? { note: [...meta.note].slice(0, 500).join("") } : {}),
  };
}
