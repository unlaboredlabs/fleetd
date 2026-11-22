// scrcpy's wire, with nothing of the machine's: the server's arguments, its packets, the decoder's arguments, the JPEGs
// out of ffmpeg's MJPEG and a person's input as scrcpy's control messages. The node's stream (./scrcpy.ts) and a hosted box's own
// part (../place/box_emulator.ts, ./android_part.mjs) speak it alike. Pure (docs/CONTRIBUTING.md "The package").
import { SCRCPY_VERSION } from "./pins.ts";

/** Where the jar goes on the device. */
export const SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
/** The longer side of the stream: a 720×1600 screen comes as 576×1280. */
export const MAX_SIZE = 1280;
/** Frames a second the device's encoder may make: the emulator's own H.264 makes ~26–31 of them while the screen moves
 * at no more emulator CPU than at 30 (its encoder, not the cap, is the bound), so the cap is 60. */
export const MAX_FPS = 60;
/** scrcpy refuses longer text in one message. */
const TEXT_MAX_BYTES = 300;

/** One frame of the screen, as JPEG: `seq` 1, 2, … per stream, `atMs` from the session's start. A screen that streams
 * H.264 (an emulator's own, ./scrcpy.ts; an iOS simulator's, ../screen/mac_frames.ts) sends it as `video` (Annex B, a
 * keyframe with its parameter sets first), its `jpeg` empty. */
export type Frame = { seq: number; jpeg: Uint8Array; width: number; height: number; atMs: number; video?: { data: Uint8Array; key: boolean } };

/**
 * What a person does to a device, in the last frame's pixels. The app's mouse maps to one finger (a press is `down`, a
 * move while pressed `move`, a release `up`), its wheel to `scroll`, its keys to `key` (a key that types goes as
 * `text`). Key names are the browser's `KeyboardEvent.key` ("BrowserBack" and "BrowserHome" are Android's Back and
 * Home); `modifiers` as CDP sums them (Alt 1, Ctrl 2, Meta 4, Shift 8).
 */
export type Input =
  | { kind: "touch"; action: "down" | "up" | "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; down: boolean; key: string; modifiers: number }
  | { kind: "text"; text: string };

/** The H.264 bit rate the node's own stream asks of the device, in bit/s: what passes through to a watcher that
 * decodes it (../screen/live.ts MAX_KBPS, as a Linux desktop's x264 has it) and goes into the recording. */
export const VIDEO_BIT_RATE = 2_500_000;

/**
 * The server's arguments, in order: `send_dummy_byte` after `raw_stream`, which turns it off. `packets`: each packet
 * comes with its header (`Packets` reads them) instead of as bare H.264, at VIDEO_BIT_RATE: what the node's own stream
 * passes through. A hosted box's part decodes the bare stream (./android_part.mjs).
 */
export function serverArgs(scid: string, packets = false): string[] {
  const stream = packets
    ? [`video_bit_rate=${VIDEO_BIT_RATE}`, "send_device_meta=false", "send_stream_meta=true", "send_frame_meta=true"]
    : ["raw_stream=true"];
  return [
    `CLASSPATH=${SERVER_PATH}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    SCRCPY_VERSION,
    `scid=${scid}`,
    "log_level=warn",
    "tunnel_forward=true",
    "audio=false",
    "control=true",
    "video_codec=h264",
    `max_size=${MAX_SIZE}`,
    `max_fps=${MAX_FPS}`,
    ...stream,
    "send_dummy_byte=true",
    "clipboard_autosync=false",
  ];
}

/** What scrcpy's video socket says, packet by packet (with `serverArgs(…, true)`): the encoder's size each time it
 * starts (the first time, after a reset, on a rotation), its parameter sets (`config`), and each frame, as Annex B. */
export type Packet = { kind: "size"; width: number; height: number } | { kind: "config"; data: Uint8Array } | { kind: "frame"; data: Uint8Array; key: boolean };

/**
 * Splits the video socket into packets as it comes. First the codec's id (4 bytes); then a session header (12 bytes:
 * a 32-bit word whose top bit is set, the width, the height) each time the encoder starts, and a frame header before
 * each packet (12 bytes: 64 bits of presentation time, its top bits saying `config` (62) and `key` (61), then the
 * length).
 */
export class Packets {
  private buf: Uint8Array = new Uint8Array(0);
  private codec = false;

  push(chunk: Uint8Array): Packet[] {
    // Its own copy: a socket may reuse the chunk's memory, and the packets point into it.
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Uint8Array.from(chunk);
    const out: Packet[] = [];
    for (;;) {
      const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.length);
      if (!this.codec) {
        if (this.buf.length < 4) return out;
        if (v.getUint32(0) !== H264_ID) throw new Error(`scrcpy's stream is not H.264 (codec ${v.getUint32(0)})`);
        this.codec = true;
        this.buf = this.buf.subarray(4);
        continue;
      }
      if (this.buf.length < 12) return out;
      const word = v.getUint32(0);
      if (word & 0x8000_0000) {
        out.push({ kind: "size", width: v.getUint32(4), height: v.getUint32(8) });
        this.buf = this.buf.subarray(12);
        continue;
      }
      const length = v.getUint32(8);
      if (this.buf.length < 12 + length) return out;
      const data = this.buf.subarray(12, 12 + length);
      out.push(word & 0x4000_0000 ? { kind: "config", data } : { kind: "frame", data, key: (word & 0x2000_0000) !== 0 });
      this.buf = this.buf.subarray(12 + length);
    }
  }
}
/** scrcpy's id for H.264: "h264". */
const H264_ID = 0x68_32_36_34;

/** The control message that restarts the device's encoder: its size, parameter sets and a keyframe come next. */
export const RESET_VIDEO = Uint8Array.of(17);

/** ffmpeg's arguments for one picture: `frames` access units in, from a keyframe (with its parameter sets) on, the
 * last one's JPEG out. */
export function stillArgs(frames: number): string[] {
  return [
    ...["-loglevel", "error", "-f", "h264", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0"],
    ...["-vf", `select=eq(n\\,${Math.max(frames - 1, 0)})`, "-fps_mode", "vfr", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1"],
  ];
}

/**
 * What drops a frame that hardly differs from the last one kept: no 8×8 block changed by more than 4 levels a pixel on
 * average, nor a third of them by 2. scrcpy's server repeats the screen every 100 ms while it is still, and its encoder
 * sharpens it a little each time; none of that is worth a JPEG. `max` sends a dropped change after 30 frames anyway.
 */
const SKIP_REPEATS = "mpdecimate=hi=256:lo=128:frac=0.33:max=30";

/** ffmpeg's arguments for the decoder: H.264 in, a JPEG per changed frame out (`vfr`, or it fills dropped ones in). */
export const DECODER_ARGS = [
  ...["-loglevel", "error", "-f", "h264", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0"],
  ...["-vf", SKIP_REPEATS, "-fps_mode", "vfr", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1"],
];

/**
 * ffmpeg's arguments for the node's own decoder (./scrcpy.ts), fed from a keyframe: a JPEG per frame out. A frame
 * scrcpy repeats on a still screen decodes to the same JPEG, which the stream drops; mpdecimate would drop it here, but
 * it holds back the last frame until a different one comes, so a screen that stops would show late or never.
 */
export const JPEG_ARGS = [
  ...["-loglevel", "error", "-f", "h264", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0"],
  ...["-fps_mode", "passthrough", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1"],
];

/** Splits ffmpeg's MJPEG output into whole JPEGs (start FF D8, end FF D9; the data in between never holds FF D9). */
export class Jpegs {
  private buf: Buffer = Buffer.alloc(0);

  push(data: Uint8Array): Uint8Array[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : Buffer.from(data);
    const out: Uint8Array[] = [];
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        return out;
      }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) {
        this.buf = this.buf.subarray(start);
        return out;
      }
      out.push(Uint8Array.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** Android's keycode for a browser key name; undefined for one that types (it goes as text) or that Android lacks. */
export function keycode(key: string): number | undefined {
  const codes: Record<string, number> = {
    Enter: 66,
    Backspace: 67,
    Delete: 112,
    Tab: 61,
    Escape: 111,
    ArrowUp: 19,
    ArrowDown: 20,
    ArrowLeft: 21,
    ArrowRight: 22,
    Home: 122,
    End: 123,
    PageUp: 92,
    PageDown: 93,
    BrowserBack: 4,
    BrowserHome: 3,
    ContextMenu: 82,
    AudioVolumeUp: 24,
    AudioVolumeDown: 25,
  };
  return Object.hasOwn(codes, key) ? codes[key] : undefined;
}

/** Android's meta state for CDP's modifiers. */
export function metaState(modifiers: number): number {
  let meta = 0;
  if (modifiers & 1) meta |= 0x02; // ALT_ON
  if (modifiers & 2) meta |= 0x1000; // CTRL_ON
  if (modifiers & 4) meta |= 0x10000; // META_ON
  if (modifiers & 8) meta |= 0x01; // SHIFT_ON
  return meta;
}

/** scrcpy's control messages for one input, given the stream's size. */
export function messages(input: Input, [width, height]: [number, number]): Uint8Array[] {
  const position = (view: DataView, at: number, x: number, y: number) => {
    view.setInt32(at, Math.trunc(Math.min(Math.max(x, 0), width)));
    view.setInt32(at + 4, Math.trunc(Math.min(Math.max(y, 0), height)));
    view.setUint16(at + 8, width & 0xffff);
    view.setUint16(at + 10, height & 0xffff);
  };
  switch (input.kind) {
    case "touch": {
      const m = new Uint8Array(32);
      const v = new DataView(m.buffer);
      m[0] = 2;
      m[1] = input.action === "down" ? 0 : input.action === "up" ? 1 : 2;
      // A finger, not the mouse pointer (-1), so apps see a touch.
      v.setBigInt64(2, -2n);
      position(v, 10, input.x, input.y);
      v.setUint16(22, input.action === "up" ? 0 : 0xffff);
      // The action button and the buttons stay 0.
      return [m];
    }
    case "scroll": {
      // scrcpy takes -16..16 notches as a signed 16-bit fraction of 16; a wheel notch is about 100 px, and a positive
      // vertical notch scrolls up.
      const fixed = (notches: number) => Math.trunc(Math.min(Math.max(notches / 16, -1), 1) * 32767);
      const m = new Uint8Array(21);
      const v = new DataView(m.buffer);
      m[0] = 3;
      position(v, 1, input.x, input.y);
      v.setInt16(13, fixed(input.dx / 100));
      v.setInt16(15, fixed(-input.dy / 100));
      return [m];
    }
    case "key": {
      const code = keycode(input.key);
      if (code === undefined) return [];
      const m = new Uint8Array(14);
      const v = new DataView(m.buffer);
      m[0] = 0;
      m[1] = input.down ? 0 : 1;
      v.setUint32(2, code);
      // Repeat stays 0.
      v.setUint32(10, metaState(input.modifiers));
      return [m];
    }
    case "text": {
      const out: Uint8Array[] = [];
      const bytes = new TextEncoder().encode(input.text);
      let at = 0;
      while (at < bytes.length) {
        let cut = Math.min(bytes.length, at + TEXT_MAX_BYTES);
        // Never inside a character: back up past its continuation bytes.
        while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut--;
        const piece = bytes.subarray(at, cut);
        const m = new Uint8Array(5 + piece.length);
        new DataView(m.buffer).setUint32(1, piece.length);
        m[0] = 1;
        m.set(piece, 5);
        out.push(m);
        at = cut;
      }
      return out;
    }
  }
}

