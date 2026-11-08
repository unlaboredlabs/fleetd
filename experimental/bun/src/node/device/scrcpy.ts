// An emulator's screen and input, through scrcpy's server (crates/fleetd/src/node/device/scrcpy.rs): the node pushes the
// pinned jar, starts it over adb and speaks its protocol itself (no scrcpy client, no window). Its H.264 stream is
// decoded by ffmpeg into JPEG frames, which feed both the session's video (record.ts's VP9 encoder, as for a browser)
// and whoever watches it live; a person's input goes back on its control socket as touches, scrolls, keys and text.
//
// The protocol is scrcpy's own and changes between versions, so the server is pinned with it (sdk.ts). It runs with
// `raw_stream` (bare H.264, no headers) but a dummy byte, so the node knows a forwarded connection reached it.
import type { Socket, Subprocess } from "bun";
import { jpegSize } from "../browser/fit.ts";
import { adb, SCRCPY_VERSION, type Sdk, sdkEnv } from "./sdk.ts";

/** Where the jar goes on the device. */
const SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
/** The longer side of the stream: a 720×1600 screen comes as 576×1280. */
export const MAX_SIZE = 1280;
const MAX_FPS = 30;
/** scrcpy refuses longer text in one message. */
const TEXT_MAX_BYTES = 300;

/** One frame of the screen, as JPEG: `seq` 1, 2, … per stream, `atMs` from the session's start. */
export type Frame = { seq: number; jpeg: Uint8Array; width: number; height: number; atMs: number };

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

/** Puts scrcpy's server on the device: done by the pool while a copy waits, so a session's stream starts without it. */
export async function pushServer(sdk: Sdk, serial: string): Promise<void> {
  const pushed = await adb(sdk, serial, ["push", sdk.scrcpyServer, SERVER_PATH]);
  if (pushed.code !== 0) throw new Error(`adb could not push scrcpy's server: ${pushed.stderr.trim()}`);
}

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

/** How soon a connect the server didn't take yet is tried again: it listens within a second of its start. */
const CONNECT_RETRY = 20;

type Sock = Socket<{ onData: (chunk: Uint8Array) => void; onClose: () => void }>;

/** One TCP connection to 127.0.0.1:`port`, its data and close handed to whoever sets them. */
async function open(port: number): Promise<Sock | undefined> {
  try {
    return await Bun.connect<{ onData: (chunk: Uint8Array) => void; onClose: () => void }>({
      hostname: "127.0.0.1",
      port,
      data: { onData: () => {}, onClose: () => {} },
      socket: {
        data: (s, chunk) => s.data.onData(chunk),
        close: (s) => s.data.onClose(),
        error: (s) => s.data.onClose(),
      },
    });
  } catch {
    return undefined;
  }
}

/** The first bytes on a socket, or undefined when it closes first or `ms` pass. */
function firstData(socket: Sock, ms: number): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    socket.data.onData = (chunk) => {
      clearTimeout(timer);
      socket.data.onData = () => {};
      resolve(chunk);
    };
    socket.data.onClose = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
  });
}

/**
 * Connects the video socket, then the control socket, as the server accepts them. Until the server listens, adb takes
 * the connection and closes it at once: no dummy byte, so try again. Returns the video bytes that came with the dummy.
 */
async function connect(port: number): Promise<{ video: Sock; control: Sock; rest: Uint8Array }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const video = await open(port);
    if (video) {
      const first = await firstData(video, 2_000);
      if (first && first.length >= 1) {
        const control = await open(port);
        if (!control) {
          video.end();
          throw new Error("scrcpy's control socket did not connect");
        }
        video.setNoDelay(true);
        control.setNoDelay(true);
        return { video, control, rest: first.subarray(1) };
      }
      video.end();
    }
    if (Date.now() > deadline) throw new Error("scrcpy's server did not answer in 10 s");
    await Bun.sleep(CONNECT_RETRY);
  }
}

/** A running server for one emulator: its frames go to `onFrame`; `send` takes input; `stop` ends it all. */
export class Stream {
  private sizeNow: [number, number] | undefined;
  private pending: Uint8Array[] = [];
  private stopped = false;

  private constructor(
    private readonly sdk: Sdk,
    private readonly serial: string,
    private readonly forward: number,
    private readonly server: Subprocess,
    private readonly decoder: Subprocess<"pipe", "pipe", "ignore">,
    private readonly video: Sock,
    private readonly control: Sock,
  ) {}

  /**
   * Starts the server on `serial` (pushing it first unless it is `pushed` there) and decodes its stream with
   * `ffmpeg`. Resolves once both sockets are connected; `start` is the session's start, in performance.now() ms.
   */
  static async start(sdk: Sdk, serial: string, pushed: boolean, ffmpeg: string, start: number, onFrame: (frame: Frame) => void): Promise<Stream> {
    if (!pushed) await pushServer(sdk, serial);
    const scid = (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff).toString(16).padStart(8, "0");
    const forwarded = await adb(sdk, serial, ["forward", "tcp:0", `localabstract:scrcpy_${scid}`]);
    const port = Number(forwarded.stdout.trim());
    if (!Number.isInteger(port) || port <= 0 || forwarded.stdout.trim() === "") {
      throw new Error(`adb did not forward a port: ${forwarded.stderr.trim()}`);
    }
    const removeForward = () => void adb(sdk, serial, ["forward", "--remove", `tcp:${port}`]).catch(() => undefined);
    let server: Subprocess | undefined;
    let decoder: Subprocess<"pipe", "pipe", "ignore"> | undefined;
    try {
      server = Bun.spawn([sdk.adb, "-s", serial, "shell", ...serverArgs(scid)], {
        env: { ...process.env, ...sdkEnv(sdk) },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const { video, control, rest } = await connect(port);
      try {
        decoder = Bun.spawn([ffmpeg, ...DECODER_ARGS], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      } catch (e) {
        video.end();
        control.end();
        throw new Error(`cannot start ${ffmpeg}: ${(e as Error).message}`);
      }
      const stream = new Stream(sdk, serial, port, server, decoder, video, control);
      stream.pump(rest);
      void stream.frames(start, onFrame);
      control.data.onClose = () => {};
      return stream;
    } catch (e) {
      server?.kill("SIGKILL");
      decoder?.kill("SIGKILL");
      removeForward();
      throw e;
    }
  }

  /** The video socket into the decoder. */
  private pump(rest: Uint8Array): void {
    const sink = this.decoder.stdin;
    const write = (chunk: Uint8Array) => {
      if (this.stopped) return;
      try {
        sink.write(chunk);
        void sink.flush();
      } catch {
        // The decoder is gone.
      }
    };
    if (rest.length) write(rest);
    this.video.data.onData = write;
    this.video.data.onClose = () => {
      try {
        void sink.end();
      } catch {
        // Ended already.
      }
    };
  }

  /** The decoder's JPEGs, each a frame. */
  private async frames(start: number, onFrame: (frame: Frame) => void): Promise<void> {
    const jpegs = new Jpegs();
    let seq = 0;
    try {
      for await (const chunk of this.decoder.stdout) {
        for (const jpeg of jpegs.push(chunk)) {
          const size = jpegSize(jpeg);
          if (!size) continue;
          this.sizeNow = size;
          onFrame({ seq: ++seq, jpeg, width: size[0], height: size[1], atMs: Math.round(performance.now() - start) });
        }
      }
    } catch {
      // The decoder is gone.
    }
  }

  /** The stream's size now, once a frame came. */
  size(): [number, number] | undefined {
    return this.sizeNow;
  }

  /**
   * Sends a person's input; positions are in the last frame's pixels. False when there is no frame yet to place a
   * touch in, or the server is gone.
   */
  send(input: Input): boolean {
    if (!this.sizeNow || this.stopped) return false;
    for (const m of messages(input, this.sizeNow)) this.pending.push(m);
    return this.flush();
  }

  private flush(): boolean {
    while (this.pending.length) {
      const head = this.pending[0]!;
      const wrote = this.control.write(head);
      if (wrote < 0) return false;
      if (wrote < head.length) {
        this.pending[0] = head.subarray(wrote);
        // The rest goes as the socket drains.
        setTimeout(() => this.flush(), 5);
        return true;
      }
      this.pending.shift();
    }
    return true;
  }

  /** Stops the server, the decoder and the forward. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.video.end();
    this.control.end();
    this.server.kill("SIGKILL");
    this.decoder.kill("SIGKILL");
    void adb(this.sdk, this.serial, ["forward", "--remove", `tcp:${this.forward}`]).catch(() => undefined);
  }
}
