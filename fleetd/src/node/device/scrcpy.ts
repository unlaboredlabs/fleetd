// An emulator's screen and input, through scrcpy's server: the node pushes the
// pinned jar, starts it over adb and speaks its protocol itself (no scrcpy client, no window). Its H.264 passes
// through as it comes, each frame whole: into the session's video (copied into MP4, never encoded again) and to whoever
// watches it with H.264. ffmpeg decodes it only where a JPEG is wanted: every frame while a watcher can't decode H.264,
// or a still (a new watcher's first picture, a lost frame's): the frames since the last keyframe, kept for it, decoded
// to the screen now. The device's encoder is reset with each still, so the next frame is a keyframe; a still screen
// sends none until it changes, which is why the still doesn't wait for it. A person's input goes back on its control
// socket as touches, scrolls, keys and text.
//
// The protocol is scrcpy's own and changes between versions, so the server is pinned with it (sdk.ts). Each packet
// comes with its header (scrcpy_wire.ts `Packets`), after a dummy byte, so the node knows a forwarded connection
// reached it.
import type { Socket, Subprocess } from "bun";
import { jpegSize } from "../browser/fit.ts";
import { type Frame, type Input, JPEG_ARGS, Jpegs, messages, Packets, RESET_VIDEO, SERVER_PATH, serverArgs, stillArgs } from "./scrcpy_wire.ts";
import { adb, type Sdk, sdkEnv } from "./sdk.ts";

export { DECODER_ARGS, type Frame, type Input, Jpegs, keycode, MAX_SIZE, messages, metaState, Packets, SERVER_PATH, serverArgs } from "./scrcpy_wire.ts";

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
 * the connection and closes it at once: no dummy byte, so try again. Returns the video bytes that came after the dummy,
 * those that came while the control socket connected too: each packet's header says where the next begins, so none
 * may go missing.
 */
async function connect(port: number): Promise<{ video: Sock; control: Sock; rest: Uint8Array }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const video = await open(port);
    if (video) {
      const first = await firstData(video, 2_000);
      if (first && first.length >= 1) {
        const came: Uint8Array[] = [Uint8Array.from(first.subarray(1))];
        video.data.onData = (chunk) => void came.push(Uint8Array.from(chunk));
        const control = await open(port);
        if (!control) {
          video.end();
          throw new Error("scrcpy's control socket did not connect");
        }
        video.setNoDelay(true);
        control.setNoDelay(true);
        return { video, control, rest: Buffer.concat(came) };
      }
      video.end();
    }
    if (Date.now() > deadline) throw new Error("scrcpy's server did not answer in 10 s");
    await Bun.sleep(CONNECT_RETRY);
  }
}

/** How long a still's decode may take before the frames it holds back go without it. */
const STILL_MS = 1_000;
/** The frames since the last keyframe are kept for a still up to this many bytes (the device makes one each 10 s, at
 * 2.5 Mbit/s at most: about 3 MB); past it, none until the next. */
const GOP_BYTES = 4 << 20;
const NO_JPEG = new Uint8Array(0);

type Decoder = Subprocess<"pipe", "pipe", "ignore">;

/**
 * A running server for one emulator: its frames go to `onFrame`, H.264 always, JPEG while `jpegs` is on and for a
 * still `key` asks; `send` takes input; `stop` ends it all.
 */
export class Stream {
  private sizeNow: [number, number] | undefined;
  private pending: Uint8Array[] = [];
  private stopped = false;
  private readonly packets = new Packets();
  /** The encoder's parameter sets, put before each keyframe so it decodes alone. */
  private config: Uint8Array | undefined;
  private seq = 0;
  /** Every frame as JPEG, while a watcher can't decode H.264: fed from a keyframe on. */
  private decoder: { proc: Decoder; fed: boolean } | undefined;
  /** The frames since the last keyframe (that one first), for a still or a decoder that starts. */
  private gop: { units: Uint8Array[]; bytes: number } | undefined;
  /** Whether a frame came yet. */
  private framed = false;
  /** A still was asked for before any keyframe came: the first one's JPEG goes before it. */
  private stillNext = false;
  /** The frames that wait for a still's JPEG, in order. */
  private held: Omit<Frame, "seq">[] | undefined;
  private readonly stills = new Set<Decoder>();

  private constructor(
    private readonly sdk: Sdk,
    private readonly serial: string,
    private readonly forward: number,
    private readonly server: Subprocess,
    private readonly video: Sock,
    private readonly control: Sock,
    private readonly ffmpeg: string,
    private readonly start: number,
    private readonly onFrame: (frame: Frame) => void,
  ) {}

  /**
   * Starts the server on `serial` (pushing it first unless it is `pushed` there); `ffmpeg` decodes what JPEG is wanted.
   * Resolves once both sockets are connected; `start` is the session's start, in performance.now() ms.
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
    try {
      server = Bun.spawn([sdk.adb, "-s", serial, "shell", ...serverArgs(scid, true)], {
        env: { ...process.env, ...sdkEnv(sdk) },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const { video, control, rest } = await connect(here);
      const stream = new Stream(sdk, serial, port, server, video, control, ffmpeg, start, onFrame);
      stream.pump(rest);
      control.data.onClose = () => {};
      return stream;
    } catch (e) {
      server?.kill("SIGKILL");
      removeForward();
      throw e;
    }
  }

  /** The video socket, packet by packet. */
  private pump(rest: Uint8Array): void {
    this.video.data.onData = (chunk) => this.read(chunk);
    this.video.data.onClose = () => this.endDecoder();
    if (rest.length) this.read(rest);
  }

  private read(chunk: Uint8Array): void {
    if (this.stopped) return;
    let packets;
    try {
      packets = this.packets.push(chunk);
    } catch (e) {
      console.warn(`scrcpy ${this.serial}: ${(e as Error).message}`);
      return this.stop();
    }
    for (const p of packets) {
      if (p.kind === "size") this.sizeNow = [p.width, p.height];
      else if (p.kind === "config") this.config = p.data;
      else this.frame(p.data, p.key);
    }
  }

  private frame(data: Uint8Array, key: boolean): void {
    const size = this.sizeNow;
    if (!size) return;
    this.framed = true;
    const au = key && this.config ? Buffer.concat([this.config, data]) : data;
    if (key) this.gop = { units: [au], bytes: au.length };
    else if (this.gop) {
      this.gop.units.push(au);
      this.gop.bytes += au.length;
      if (this.gop.bytes > GOP_BYTES) this.gop = undefined;
    }
    this.toDecoder(au, key);
    const frame = { jpeg: NO_JPEG, width: size[0], height: size[1], atMs: this.atMs(), video: { data: au, key } };
    if (key && this.stillNext) {
      this.stillNext = false;
      this.stillOf([au]);
    }
    if (this.held) this.held.push(frame);
    else this.emit(frame);
  }

  private emit(frame: Omit<Frame, "seq">): void {
    if (!this.stopped) this.onFrame({ seq: ++this.seq, ...frame });
  }

  private atMs(): number {
    return Math.round(performance.now() - this.start);
  }

  /** A still's JPEG (if it decoded), then the frames that waited for it. */
  private release(jpeg: Uint8Array | undefined, [width, height]: [number, number], atMs: number): void {
    const held = this.held ?? [];
    this.held = undefined;
    if (jpeg) this.emit({ jpeg, width, height, atMs });
    for (const f of held) this.emit(f);
  }

  /** The last of `units` (a keyframe first) as a JPEG, by an ffmpeg of its own; undefined if it can't in STILL_MS. */
  private async still(units: Uint8Array[]): Promise<Uint8Array | undefined> {
    let proc: Decoder;
    try {
      proc = Bun.spawn([this.ffmpeg, ...stillArgs(units.length)], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch (e) {
      console.warn(`scrcpy ${this.serial}: no still: ${(e as Error).message}`);
      return undefined;
    }
    this.stills.add(proc);
    try {
      const out = new Response(proc.stdout).bytes();
      for (const u of units) proc.stdin.write(u);
      void proc.stdin.end();
      const done = await Promise.race([out, Bun.sleep(STILL_MS).then(() => undefined)]);
      return done ? new Jpegs().push(done)[0] : undefined;
    } catch {
      return undefined;
    } finally {
      proc.kill("SIGKILL");
      this.stills.delete(proc);
    }
  }

  /** JPEGs of every frame from now on (a watcher that can't decode H.264), or no more. */
  jpegs(on: boolean): void {
    if (this.stopped || on === (this.decoder !== undefined)) return;
    if (!on) return this.endDecoder(true);
    let proc: Decoder;
    try {
      proc = Bun.spawn([this.ffmpeg, ...JPEG_ARGS], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch (e) {
      console.warn(`scrcpy ${this.serial}: no JPEGs: cannot start ${this.ffmpeg}: ${(e as Error).message}`);
      return;
    }
    const decoder = { proc, fed: false };
    this.decoder = decoder;
    void this.decoded(decoder);
    // It starts from the last keyframe, as far as the screen is now; with none kept, from the next, asked for now.
    const units = this.gop?.units;
    if (!units) return this.reset();
    units.forEach((u, i) => this.toDecoder(u, i === 0));
  }

  private toDecoder(au: Uint8Array, key: boolean): void {
    const d = this.decoder;
    if (!d || (!d.fed && !key)) return;
    d.fed = true;
    try {
      d.proc.stdin.write(au);
      void d.proc.stdin.flush();
    } catch {
      // The decoder is gone.
    }
  }

  /** The decoder's JPEGs, each a frame but the same picture again. */
  private async decoded(decoder: { proc: Decoder }): Promise<void> {
    const jpegs = new Jpegs();
    let last: number | bigint | undefined;
    try {
      for await (const chunk of decoder.proc.stdout) {
        for (const jpeg of jpegs.push(chunk)) {
          const size = jpegSize(jpeg);
          const hash = Bun.hash(jpeg);
          if (!size || hash === last || this.decoder !== decoder) continue;
          last = hash;
          this.emit({ jpeg, width: size[0], height: size[1], atMs: this.atMs() });
        }
      }
    } catch {
      // The decoder is gone.
    }
    if (this.decoder === decoder) this.decoder = undefined;
  }

  private endDecoder(kill = false): void {
    const d = this.decoder;
    this.decoder = undefined;
    if (!d) return;
    try {
      void d.proc.stdin.end();
    } catch {
      // Ended already.
    }
    if (kill) d.proc.kill("SIGKILL");
  }

  /**
   * The screen now as a JPEG, sent before any frame that comes meanwhile, and the next frame a keyframe: a new
   * watcher's first picture, or a lost frame's. A still under way already stands for one asked again.
   */
  key(): void {
    if (this.stopped) return;
    this.reset();
    const units = this.gop?.units;
    if (units) this.stillOf([...units]);
    else this.stillNext = true;
  }

  /** The last of `units` as a still, the frames that come meanwhile held back until it goes. */
  private stillOf(units: Uint8Array[]): void {
    const size = this.sizeNow;
    if (this.held || !size) return;
    this.held = [];
    const atMs = this.atMs();
    void this.still(units).then((jpeg) => this.release(jpeg, size, atMs));
  }

  /** Restarts the device's encoder: its size, parameter sets and a keyframe come next. Not before its first frame,
   * which is a keyframe anyway: a reset while the server starts its encoder leaves it sending nothing at all. */
  private reset(): void {
    if (!this.gop && !this.framed) return;
    this.pending.push(RESET_VIDEO);
    this.flush();
  }

  /** The stream's size now, once the encoder said it. */
  size(): [number, number] | undefined {
    return this.sizeNow;
  }

  /**
   * Sends a person's input; positions are in the stream's pixels. False when there is no size yet to place a touch in,
   * or the server is gone.
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

  /** Stops the server, the decoders and the forward. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.held = undefined;
    this.video.end();
    this.control.end();
    this.server.kill("SIGKILL");
    this.endDecoder(true);
    for (const p of this.stills) p.kill("SIGKILL");
    void adb(this.sdk, this.serial, ["forward", "--remove", `tcp:${this.forward}`]).catch(() => undefined);
  }
}
