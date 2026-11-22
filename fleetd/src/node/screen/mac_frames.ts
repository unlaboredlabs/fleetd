// A screen of the agents' Mac as live frames, from fleetd-frames (./frames.swift): an iOS simulator's framebuffer, or
// the Mac's own display, each read only when it changes and sent as JPEG or as H.264 from the Mac's hardware encoder.
// The node builds the helper with the Mac's own swiftc the first time a screen needs it (Xcode is there for the
// simulators anyway), keyed by its source's hash, and runs one per watched screen while someone watches it.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import source from "./frames.swift" with { type: "file" };
import type { Command, StreamFrame, StreamRun } from "./live.ts";

/** One frame as the helper sends it. `screen` is the screen's own size (input coordinates are in it); `picture` the
 * frame's, which may be smaller. */
export type MacFrame = {
  kind: "jpeg" | "h264";
  key: boolean;
  screen: [number, number];
  picture: [number, number];
  seq: number;
  data: Uint8Array;
};

const HEAD = 28;

/** Splits the helper's stdout into frames as they come: chunks in, whole frames out, the rest kept for the next. */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private have = 0;

  constructor(private readonly onFrame: (frame: MacFrame) => void) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.have += chunk.length;
    for (;;) {
      if (this.have < HEAD) return;
      const head = this.peek(HEAD);
      const v = new DataView(head.buffer, head.byteOffset, HEAD);
      const length = v.getUint32(20, true);
      if (this.have < HEAD + length) return;
      const all = this.take(HEAD + length);
      const kind = all[0];
      if (kind !== 1 && kind !== 2) throw new Error(`fleetd-frames sent a frame of kind ${kind}`);
      this.onFrame({
        kind: kind === 1 ? "jpeg" : "h264",
        key: all[1] === 1,
        screen: [v.getUint32(4, true), v.getUint32(8, true)],
        picture: [v.getUint32(12, true), v.getUint32(16, true)],
        seq: v.getUint32(24, true),
        data: all.subarray(HEAD),
      });
    }
  }

  private peek(n: number): Uint8Array {
    if (this.chunks[0]!.length < n) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0]!.subarray(0, n);
  }

  private take(n: number): Uint8Array {
    // Joined once, when the whole frame is here.
    const joined = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const rest = joined.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.have -= n;
    return joined.subarray(0, n);
  }
}

export type { Command, StreamFrame, StreamRun } from "./live.ts";

/** Where the helper is built, for its source as it is in this build. */
export function helperPath(dir: string, text: string = readFileSync(source, "utf8")): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return join(dir, `fleetd-frames-${hash}`);
}

/** Builds under way, by the helper's path. */
const building = new Map<string, Promise<string>>();

/** The helper, built with the Mac's swiftc into `dir` the first time (~10 s), then kept. */
export function ensureHelper(dir: string, swiftc: string[] = ["xcrun", "swiftc"]): Promise<string> {
  const text = readFileSync(source, "utf8");
  const bin = helperPath(dir, text);
  if (existsSync(bin)) return Promise.resolve(bin);
  const under = building.get(bin);
  if (under) return under;
  const build = (async () => {
    mkdirSync(dir, { recursive: true });
    const src = join(dir, `frames-${process.pid}.swift`);
    const tmp = `${bin}.${process.pid}`;
    writeFileSync(src, text);
    try {
      const p = Bun.spawn([...swiftc, "-O", "-swift-version", "5", src, "-o", tmp], { stdout: "ignore", stderr: "pipe" });
      const [code, said] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      if (code !== 0) throw new Error(`fleetd-frames did not build: ${[...said.trim()].slice(-400).join("")}`);
      chmodSync(tmp, 0o755);
      renameSync(tmp, bin);
      return bin;
    } finally {
      rmSync(src, { force: true });
      rmSync(tmp, { force: true });
      building.delete(bin);
    }
  })();
  building.set(bin, build);
  return build;
}

/** One running helper: its frames to `onFrame`, commands with `tell`, `stop` ends it. */
export class MacFrames {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private stopped = false;
  /** Why it ended by itself, once it has. */
  readonly ended: Promise<string | undefined>;

  constructor(bin: string, args: string[], onFrame: (frame: MacFrame) => void) {
    const proc = Bun.spawn([bin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    const reader = new FrameReader(onFrame);
    const stderr = new Response(proc.stderr).text();
    this.ended = (async () => {
      let broken: string | undefined;
      try {
        for await (const chunk of proc.stdout) reader.push(chunk);
      } catch (e) {
        // A frame that doesn't read: the stream can't be trusted from here, so it ends (the screen falls back).
        broken = (e as Error).message;
        proc.kill();
      }
      const code = await proc.exited;
      if (this.stopped) return undefined;
      if (broken !== undefined) return broken;
      const said = (await stderr).trim();
      return said || `fleetd-frames exited (${code})`;
    })();
  }

  tell(command: Command): void {
    if (this.stopped) return;
    try {
      this.proc.stdin.write(`${command}\n`);
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


/** Frames a second at most: JPEG's a phone-sized picture of ~40-100 KB (~1.5 MB/s while it moves), H.264's a few KB. */
export const JPEG_FPS = 20;
export const H264_FPS = 30;

/**
 * A screen as frames, one as it changes, JPEG until told `h264`, each with the screen's own size: `args` say which
 * screen (`sim <set> <udid>`, `screen`). The helper is built into `dir` first if it isn't there.
 */
export async function stream(dir: string, args: string[], onFrame: (frame: StreamFrame) => void): Promise<StreamRun> {
  const helper = new MacFrames(await ensureHelper(dir), args, onFrame);
  helper.tell(`fps ${JPEG_FPS}`);
  return {
    still: () => helper.tell("still"),
    tell: (command: Command) => {
      helper.tell(command);
      if (command === "h264" || command === "jpeg") helper.tell(`fps ${command === "h264" ? H264_FPS : JPEG_FPS}`);
    },
    stop: () => helper.stop(),
    ended: helper.ended,
  };
}
