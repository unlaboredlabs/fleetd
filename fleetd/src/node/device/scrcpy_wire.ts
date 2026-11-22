// scrcpy's wire, with nothing of the machine's: the server's arguments, the decoder's, the JPEGs out of ffmpeg's
// MJPEG and a person's input as scrcpy's control messages. The node's stream (./scrcpy.ts) and a hosted box's own
// part (../place/box_emulator.ts, ./android_part.mjs) speak it alike. Pure (docs/CONTRIBUTING.md "The package").
import { SCRCPY_VERSION } from "./pins.ts";

/** Where the jar goes on the device. */
export const SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
/** The longer side of the stream: a 720×1600 screen comes as 576×1280. */
export const MAX_SIZE = 1280;
export const MAX_FPS = 30;
/** scrcpy refuses longer text in one message. */
const TEXT_MAX_BYTES = 300;

/** One frame of the screen, as JPEG: `seq` 1, 2, … per stream, `atMs` from the session's start. A screen that streams
 * H.264 (an iOS simulator's, ../screen/mac_frames.ts) sends it as `video`, its `jpeg` empty. */
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

/** The server's arguments, in order: `send_dummy_byte` after `raw_stream`, which turns it off. */
export function serverArgs(scid: string): string[] {
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
    "raw_stream=true",
    "send_dummy_byte=true",
    "clipboard_autosync=false",
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

