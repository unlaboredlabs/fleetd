// An emulator's screen and input, through scrcpy's server: the node pushes the
// pinned jar, starts it over adb and speaks its protocol itself (no scrcpy client, no window). Its H.264 stream is
// decoded by ffmpeg into JPEG frames, which feed both the session's video (record.ts's VP9 encoder, as for a browser)
// and whoever watches it live; a person's input goes back on its control socket as touches, scrolls, keys and text.
//
// The protocol is scrcpy's own and changes between versions, so the server is pinned with it (sdk.ts). It runs with
// `raw_stream` (bare H.264, no headers) but a dummy byte, so the node knows a forwarded connection reached it.
import type { Socket, Subprocess } from "bun";
import { jpegSize } from "../browser/fit.ts";
import { DECODER_ARGS, type Frame, type Input, Jpegs, messages, SERVER_PATH, serverArgs } from "./scrcpy_wire.ts";
import { adb, type Sdk, sdkEnv } from "./sdk.ts";

export { DECODER_ARGS, type Frame, type Input, Jpegs, keycode, MAX_SIZE, messages, metaState, SERVER_PATH, serverArgs } from "./scrcpy_wire.ts";

/** Puts scrcpy's server on the device: done by the pool while a copy waits, so a session's stream starts without it. */
export async function pushServer(sdk: Sdk, serial: string): Promise<void> {
  const pushed = await adb(sdk, serial, ["push", sdk.scrcpyServer, SERVER_PATH]);
  if (pushed.code !== 0) throw new Error(`adb could not push scrcpy's server: ${pushed.stderr.trim()}`);
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
    // The forward is the adb server's: where that runs elsewhere (a hosted box), a port here reaches it.
    const here = sdk.reach ? await sdk.reach(port) : port;
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
      const { video, control, rest } = await connect(here);
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
