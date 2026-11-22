// H.264 for a live view where the machine has no hardware encoder at hand (a Linux desktop's grabs, a browser's
// screencast JPEGs): x264 in the static ffmpeg the node pins for Android (../device/pins.ts), fetched as the node
// starts where it has screens, or the first time a screen needs it. A desktop's grabs come as NV12 (./nv12.ts), only
// their changed part converted, so ffmpeg only encodes: ≈ 2.6 ms of CPU a 1280×800 frame, from 7.6 with its own
// conversion. It runs while someone watches with H.264, and for a Linux desktop's recording all along, one frame in,
// one frame out at once (`zerolatency`, no B-frames, a keyframe each KEY_EVERY frames so a recording seeks without
// decoding from its start), and comes out as FLV: its tags say their length, so each frame is whole as soon as it is
// written (raw Annex B would be whole only once the next one starts). A keyframe on demand is a new encoder: ~90 ms.

import { type Encoded, type Input, kbpsFor, type LiveEncoding, type MakeEncoder } from "./live.ts";

export { type Encoded, type Input, kbpsFor, LINK_SHARE, MAX_KBPS } from "./live.ts";

const START = [0, 0, 0, 1];

/** Splits ffmpeg's FLV into frames as it comes: chunks in, whole video tags out (as Annex B), the rest kept. */
export class FlvReader {
  private buf: Uint8Array = new Uint8Array(0);
  private headerDone = false;
  /** SPS and PPS from the stream's AVC sequence header, put before each keyframe. */
  private params: Uint8Array[] = [];

  constructor(private readonly onFrame: (frame: Encoded) => void) {}

  push(chunk: Uint8Array): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.headerDone) {
      // "FLV", version, flags, the header's length (9), then PreviousTagSize0.
      if (this.buf.length < 13) return;
      if (this.buf[0] !== 0x46 || this.buf[1] !== 0x4c || this.buf[2] !== 0x56) throw new Error("ffmpeg's output is not FLV");
      const size = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(5);
      this.buf = this.buf.subarray(size + 4);
      this.headerDone = true;
    }
    for (;;) {
      if (this.buf.length < 11) return;
      const type = this.buf[0]!;
      const size = (this.buf[1]! << 16) | (this.buf[2]! << 8) | this.buf[3]!;
      if (this.buf.length < 11 + size + 4) return;
      const data = this.buf.subarray(11, 11 + size);
      this.buf = this.buf.subarray(11 + size + 4);
      if (type === 9 && data.length > 5) this.video(data);
    }
  }

  private video(data: Uint8Array): void {
    const key = data[0]! >> 4 === 1;
    const body = data.subarray(5);
    if (data[1] === 0) return void (this.params = paramSets(body));
    if (data[1] !== 1) return;
    const parts: number[][] = key ? this.params.map((p) => [...START, ...p]) : [];
    const out: Uint8Array[] = parts.map((p) => Uint8Array.from(p));
    const v = new DataView(body.buffer, body.byteOffset, body.length);
    for (let at = 0; at + 4 <= body.length; ) {
      const n = v.getUint32(at);
      at += 4;
      if (at + n > body.length) break;
      out.push(Uint8Array.from(START), body.subarray(at, at + n));
      at += n;
    }
    this.onFrame({ data: Buffer.concat(out), key });
  }
}

/** The SPS and PPS of an AVCDecoderConfigurationRecord: after 5 bytes, the SPS count (low 5 bits) and each SPS (a
 * 16-bit length, then it), then the PPS count and each PPS the same way. */
export function paramSets(record: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 5;
  const sets = (count: number) => {
    for (let i = 0; i < count && at + 2 <= record.length; i++) {
      const len = (record[at]! << 8) | record[at + 1]!;
      out.push(record.subarray(at + 2, at + 2 + len));
      at += 2 + len;
    }
  };
  if (record.length <= at) return out;
  sets(record[at++]! & 0x1f);
  if (record.length > at) sets(record[at++]!);
  return out;
}

/** A keyframe at least each this many frames: a recording seeks to any point by decoding at most this many (≈ 0.4 s of
 * 1280×800), and a screen that moves costs one more keyframe each 5 s of motion; a still one makes no frames at all. */
export const KEY_EVERY = 150;

/** Pixels past which x264 takes a second thread, where the machine has cores to spare: one encodes 1280×800 in
 * ~2.3 ms (≈ 2.6 ms of CPU), two in ~1.7 ms for ≈ 13% more CPU, worth it only where a frame would take long alone. */
export const ONE_THREAD_PIXELS = 2_100_000;

/** x264's threads for a picture of `pixels` on a machine of `cores`. */
export const threadsFor = (pixels: number, cores: number) => (pixels > ONE_THREAD_PIXELS && cores > 2 ? 2 : 1);

/** ffmpeg's arguments for `input` at `kbps` at most, on a machine of `cores`. NV12 goes in as it is (no conversion in
 * ffmpeg); BGRA is converted there, and JPEGs decoded and converted. */
export function encoderArgs(input: Input, kbps: number, cores = navigator.hardwareConcurrency): string[] {
  const [w, h] = "raw" in input ? input.raw : "nv12" in input ? input.nv12 : input.jpeg;
  const from =
    "jpeg" in input
      ? ["-f", "mjpeg", "-framerate", "30"]
      : ["-f", "rawvideo", "-pix_fmt", "raw" in input ? "bgra" : "nv12", "-s", `${w}x${h}`, "-framerate", "30"];
  return [
    "-hide_banner", "-loglevel", "error", ...from, "-i", "pipe:0", "-an",
    "-c:v", "libx264", "-preset", "superfast", "-tune", "zerolatency",
    // Even sizes, as 4:2:0 needs them: NV12 is made so.
    ...("nv12" in input ? [] : ["-pix_fmt", "yuv420p", "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2"]),
    "-g", String(KEY_EVERY), "-bf", "0", "-crf", "26", "-maxrate", `${kbps}k`, "-bufsize", `${Math.max(Math.round(kbps / 2), 50)}k`,
    "-threads", String(threadsFor(w * h, cores)), "-flush_packets", "1", "-f", "flv", "pipe:1",
  ];
}

/** One encoder: frames in with `put`, out to `onFrame` as they are made, one for one and in order, each with the time
 * it was put at. `stop` ends it. */
export class X264 {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private stopped = false;
  /** The times of the frames put and not yet out. */
  private readonly times: number[] = [];
  readonly ended: Promise<string | undefined>;

  constructor(ffmpeg: string, input: Input, kbps: number, onFrame: (frame: Encoded, atMs: number) => void) {
    const proc = Bun.spawn([ffmpeg, ...encoderArgs(input, kbps)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    const reader = new FlvReader((f) => onFrame(f, this.times.shift() ?? 0));
    const said = new Response(proc.stderr).text();
    this.ended = (async () => {
      try {
        for await (const chunk of proc.stdout) reader.push(chunk);
      } catch {}
      const code = await proc.exited;
      if (this.stopped) return undefined;
      return (await said).trim() || `ffmpeg exited (${code})`;
    })();
  }

  /** One frame of the screen: its pixels as the input says, `atMs` its time. */
  put(frame: Uint8Array, atMs = 0): void {
    if (this.stopped) return;
    this.times.push(atMs);
    try {
      this.proc.stdin.write(frame);
      void this.proc.stdin.flush();
    } catch {}
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill();
  }
}

/**
 * A live view's encoder over its life: ffmpeg fetched the first time (JPEG until it's here), and a new X264 for a
 * keyframe (`key`), a new size, a kind of input that changed or a bit rate half again off. Once one fails, it stays
 * off: `put` answers false and the screen sends JPEG.
 */
export class LiveEncoder implements LiveEncoding {
  private x: { x: X264; input: string; kbps: number } | undefined;
  private path: string | undefined;
  private keyNext = true;
  failed: string | undefined;

  private fetching: Promise<boolean> | undefined;

  constructor(
    private readonly ffmpeg: () => Promise<string>,
    private readonly onFrame: (frame: Encoded, input: Input, atMs: number) => void,
    private readonly onFail: (why: string) => void,
  ) {}

  /** The next frame starts a new encoder, with a keyframe. */
  key(): void {
    this.keyNext = true;
  }

  /** Whether it can encode: true once its ffmpeg is here (fetched the first time), false if it never will. */
  ready(): Promise<boolean> {
    if (this.failed !== undefined) return Promise.resolve(false);
    if (this.path !== undefined) return Promise.resolve(true);
    this.fetching ??= this.ffmpeg().then(
      (path) => {
        this.path = path;
        return true;
      },
      (e: Error) => {
        this.fail(`no ffmpeg for it: ${e.message}`);
        return false;
      },
    );
    return this.fetching;
  }

  /** One frame in, at `kbps` at most for the watchers' links, `atMs` its time: false when it didn't go (no encoder:
   * send JPEG). */
  put(input: Input, data: Uint8Array, kbps: number | undefined, atMs = 0): boolean {
    if (this.failed !== undefined) return false;
    if (this.path === undefined) {
      void this.ready();
      return false;
    }
    const rate = kbpsFor(kbps);
    const id = JSON.stringify(input);
    const now = this.x;
    if (!now || this.keyNext || now.input !== id || rate > now.kbps * 1.5 || rate < now.kbps / 1.5) {
      this.stop();
      this.keyNext = false;
      const x = new X264(this.path, input, rate, (f, at) => this.onFrame(f, input, at));
      const made = { x, input: id, kbps: rate };
      this.x = made;
      void x.ended.then((why) => {
        if (why !== undefined && this.x === made) this.fail(why);
      });
    }
    this.x!.x.put(data, atMs);
    return true;
  }

  private fail(why: string): void {
    this.failed = why;
    this.stop();
    this.onFail(why);
  }

  stop(): void {
    this.x?.x.stop();
    this.x = undefined;
    this.keyNext = true;
  }
}

/** A session's encoders, made with the ffmpeg `ffmpeg` answers (fetched the first time): what the node's entry points
 * hand its sessions. */
export const liveEncoder =
  (ffmpeg: () => Promise<string>): MakeEncoder =>
  (onFrame, onFail) =>
    new LiveEncoder(ffmpeg, onFrame, onFail);
