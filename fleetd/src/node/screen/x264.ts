// H.264 for a live view where the machine has no hardware encoder at hand (a Linux desktop's grabs, a browser's
// screencast JPEGs): x264 in the static ffmpeg the node pins for Android (../device/pins.ts), fetched the first time a
// screen needs it. It runs while someone watches with H.264, one frame in, one frame out at once (`zerolatency`, no
// B-frames, no keyframe but the first), and comes out as FLV: its tags say their length, so each frame is whole as
// soon as it is written (raw Annex B would be whole only once the next one starts). A keyframe on demand is a new
// encoder: ~90 ms.

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

/** ffmpeg's arguments for `input` at `kbps` at most. */
export function encoderArgs(input: Input, kbps: number): string[] {
  const from = "raw" in input ? ["-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${input.raw[0]}x${input.raw[1]}`, "-framerate", "30"] : ["-f", "mjpeg", "-framerate", "30"];
  return [
    "-hide_banner", "-loglevel", "error", ...from, "-i", "pipe:0", "-an",
    "-c:v", "libx264", "-preset", "superfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    // Even sizes, as 4:2:0 needs them.
    "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2",
    "-g", "100000", "-bf", "0", "-crf", "26", "-maxrate", `${kbps}k`, "-bufsize", `${Math.max(Math.round(kbps / 2), 50)}k`,
    "-threads", "2", "-flush_packets", "1", "-f", "flv", "pipe:1",
  ];
}

/** One encoder: frames in with `put`, out to `onFrame` as they are made. `stop` ends it. */
export class X264 {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private stopped = false;
  readonly ended: Promise<string | undefined>;

  constructor(ffmpeg: string, input: Input, kbps: number, onFrame: (frame: Encoded) => void) {
    const proc = Bun.spawn([ffmpeg, ...encoderArgs(input, kbps)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    const reader = new FlvReader(onFrame);
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

  /** One frame of the screen: its pixels as the input says. */
  put(frame: Uint8Array): void {
    if (this.stopped) return;
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
  private asked = false;
  private keyNext = true;
  failed: string | undefined;

  constructor(
    private readonly ffmpeg: () => Promise<string>,
    private readonly onFrame: (frame: Encoded, input: Input) => void,
    private readonly onFail: (why: string) => void,
  ) {}

  /** The next frame starts a new encoder, with a keyframe. */
  key(): void {
    this.keyNext = true;
  }

  /** One frame in, at `kbps` at most for the watchers' links: false when it didn't go (no encoder: send JPEG). */
  put(input: Input, data: Uint8Array, kbps: number | undefined): boolean {
    if (this.failed !== undefined) return false;
    if (this.path === undefined) {
      if (!this.asked) {
        this.asked = true;
        void this.ffmpeg().then(
          (path) => (this.path = path),
          (e: Error) => this.fail(`no ffmpeg for it: ${e.message}`),
        );
      }
      return false;
    }
    const rate = kbpsFor(kbps);
    const id = JSON.stringify(input);
    const now = this.x;
    if (!now || this.keyNext || now.input !== id || rate > now.kbps * 1.5 || rate < now.kbps / 1.5) {
      this.stop();
      this.keyNext = false;
      const x = new X264(this.path, input, rate, (f) => this.onFrame(f, input));
      const made = { x, input: id, kbps: rate };
      this.x = made;
      void x.ended.then((why) => {
        if (why !== undefined && this.x === made) this.fail(why);
      });
    }
    this.x!.x.put(data);
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
