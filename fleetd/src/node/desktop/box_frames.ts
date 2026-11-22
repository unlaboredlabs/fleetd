// A box display's picture, read and encoded in the box (`fleetd box-frames`), so only frames cross its link. The
// session that drives the display (./session.ts) stays where it was, outside the box: who drives it, its action log,
// the agent's actions and a person's input. What reads the screen moves next to it: fleetd's own session code (the
// capture loop with DAMAGE, only what changed converted to NV12, x264, the fixed frame-rate rules, the JPEG fallback),
// run here against the display's socket in the box. Before this, a holder read the display over the box's link, a
// whole 1280×800 screen 4 MB at a time, and the person's input waited behind each read.
//
// The holder starts one per session (../place/box_screens.ts `BoxDisplay.picture`) in the display's own process
// session, so the display's sweep ends it too. It listens on a port of the box's loopback and serves one connection,
// the first that sends the display's cookie: only a holder that may open the display takes its frames. It ends when
// that connection does, or when none came within WAIT_MS. A next holder (DesktopSessions `adopt`) starts its own.
//
// Its wire (the holder's side: ./picture_link.ts) is a JSON line each way. Down: `watch` (the watchers' budget, whether they decode H.264 and their frame
// rate; null for nobody), `key`, `control`, `videoJpeg` and `shot` (a screenshot, by its number). Up: `ready` once the
// display answered (or `error` with why), `live` (a frame for the watchers, as the hub takes it), `video` (one for
// the session's video) and `shot`'s answer.
//
// Box side (docs/CONTRIBUTING.md "The package"): the binary the box already runs, never a copy of it.
import { existsSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { BrowserControl, BrowserFrame } from "../../shared/contracts.ts";
import type { Recording, Video } from "../browser/recording.ts";
import { machineLoad } from "../screen/load.ts";
import { liveEncoder } from "../screen/x264.ts";
import { lines, send } from "./picture_link.ts";
import type { LiveFrame, Lent, VideoKind, Watching } from "./screen.ts";
import { Session } from "./session.ts";
import { X } from "./x11.ts";

/** Where the box's template keeps an ffmpeg with x264 (sandbox/image/Dockerfile): without one, frames are JPEG. */
export const BOX_FFMPEG = "/usr/local/bin/fleetd-ffmpeg";
/** How long it waits for its holder's connection. */
export const WAIT_MS = 30_000;
/** Frames for the video wait in the connection's buffer up to this much, then drop: a holder that stopped reading
 * never grows the box's memory. */
const VIDEO_BACKLOG = 8 << 20;

const USAGE = "usage: fleetd box-frames --display :N --port P --video h264|jpeg|none (the display's cookie in FLEETD_FRAMES_COOKIE)";

/** What `serve` needs: the display's socket and cookie, where it listens (a port on the loopback, or a socket file: a
 * test's), what the video takes, and an ffmpeg with x264 (absent: JPEG only). */
export type ServeOptions = { socket: string; cookie: Uint8Array; listen: number | string; video: VideoKind; ffmpeg?: string; waitMs?: number };

/** The box's side: listens for its holder, and serves it the display's picture until its connection ends. Resolves
 * then, or with nobody once WAIT_MS passed. */
export async function serve(o: ServeOptions): Promise<void> {
  const want = Buffer.from(o.cookie).toString("hex");
  // What the video takes: H.264 until the holder's says it started as JPEG.
  let videoKind = o.video;
  let taken = false;
  const done = Promise.withResolvers<void>();
  const server = createServer((s) => {
    if (taken) return void s.destroy();
    let authed = false;
    let session: Session | undefined;
    const end = () => {
      if (!authed) return;
      void session?.close().finally(() => done.resolve());
      if (!session) done.resolve();
    };
    s.on("close", end);
    s.on("error", () => s.destroy());
    lines(s, (line) => {
      if (!authed) {
        // Only the holder's connection takes it: any other is closed, and leaves it waiting for the holder's.
        if (line.cookie !== want || taken) return void s.destroy();
        authed = true;
        taken = true;
        clearTimeout(nobody);
        server.close();
        void open(s).then(
          (made) => {
            session = made;
            if (s.destroyed) end();
          },
          (e: Error) => {
            send(s, { error: e.message });
            s.end();
          },
        );
        return;
      }
      if (session) command(s, session, line);
    });
  });
  const nobody = setTimeout(() => {
    server.close();
    done.resolve();
  }, o.waitMs ?? WAIT_MS);
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    if (typeof o.listen === "string") server.listen(o.listen, () => resolve());
    else server.listen(o.listen, "127.0.0.1", () => resolve());
  });

  /** The display, connected, and a session reading it whose frames go to `s`. */
  async function open(s: Socket): Promise<Session> {
    const x = await X.connect(o.socket, o.cookie);
    const video: Video = {
      frame: (jpeg) => {
        if (s.writableLength < VIDEO_BACKLOG) send(s, { video: { kind: "jpeg", b64: Buffer.from(jpeg).toString("base64") } });
      },
      ...(o.video === "h264"
        ? {
            h264: (au: Uint8Array, key: boolean, size: [number, number]) => {
              if (videoKind !== "h264") return false;
              // A keyframe always goes: what follows it decodes only from one.
              if (key || s.writableLength < VIDEO_BACKLOG) send(s, { video: { kind: "h264", key, size, b64: Buffer.from(au).toString("base64") } });
              return true;
            },
          }
        : {}),
      tick: () => {},
      finish: async () => undefined,
    };
    // Only its video: the action log is the holder's, never the box's.
    const recording: Recording | undefined =
      o.video === "none"
        ? undefined
        : { append: () => {}, video, filled: () => {}, end: async () => ({ files: [] }) };
    // The display's apps are the holder's to launch; this one only reads it.
    const lent: Lent = { launch: () => Promise.reject(new Error("box-frames only reads the display")), drop: async () => {} };
    const session = new Session(lent, x, {
      id: "box-frames",
      thread: "",
      cwd: "/",
      purpose: "",
      secrets: [],
      kind: "linux_desktop",
      ...(recording ? { recording } : {}),
      ...(o.ffmpeg ? { encoder: liveEncoder(async () => o.ffmpeg!) } : {}),
      load: machineLoad,
    });
    session.open();
    send(s, { ready: true, h264: o.ffmpeg !== undefined });
    return session;
  }

  /** One line of the holder's. */
  function command(s: Socket, session: Session, line: Record<string, unknown>): void {
    if ("watch" in line) {
      const w = line.watch as Watching | null;
      const watching = w ? { kbps: typeof w.kbps === "number" ? w.kbps : undefined, video: w.video === true, ...(typeof w.fps === "number" ? { fps: w.fps } : {}) } : undefined;
      if (!watching) return session.setWatcher(undefined);
      if (!session.watched()) return session.setWatcher({ ...watching, send: (f) => send(s, { live: liveOf(f) }) });
      return session.setBudget(watching.kbps, watching.video, watching.fps);
    }
    if (line.key) return session.key();
    if (typeof line.control === "string") return session.setControl(line.control as BrowserControl, "holder");
    if (line.videoJpeg) return void (videoKind = "jpeg");
    if (typeof line.shot === "number") {
      const id = line.shot;
      void session.screen.serial(() => session.screen.grab()).then(
        (shot) => send(s, { shot: id, jpegB64: Buffer.from(shot.jpeg).toString("base64"), width: shot.width, height: shot.height }),
        (e: Error) => send(s, { shot: id, error: e.message }),
      );
    }
  }

  await done.promise;
}

/** A frame of the box's session as the holder's watchers take it: the picture alone. */
function liveOf(f: BrowserFrame): LiveFrame {
  return {
    width: f.width,
    height: f.height,
    ...(f.jpegB64 !== undefined ? { jpegB64: f.jpegB64 } : {}),
    ...(f.h264B64 !== undefined ? { h264B64: f.h264B64, key: f.key === true } : {}),
  };
}

/** `fleetd box-frames`, in a box: its arguments, the cookie from the environment. */
export async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const display = arg("--display");
  const port = Number(arg("--port"));
  const video = arg("--video");
  const cookieHex = process.env.FLEETD_FRAMES_COOKIE ?? "";
  if (!display || !/^:\d+$/.test(display) || !Number.isInteger(port) || port <= 0 || port > 65535 || (video !== "h264" && video !== "jpeg" && video !== "none")) {
    process.stderr.write(`fleetd box-frames: ${USAGE}\n`);
    return 2;
  }
  if (!/^[0-9a-f]{32}$/.test(cookieHex)) {
    process.stderr.write("fleetd box-frames: FLEETD_FRAMES_COOKIE holds no display cookie\n");
    return 2;
  }
  const ffmpeg = process.env.FLEETD_FFMPEG || (existsSync(BOX_FFMPEG) ? BOX_FFMPEG : undefined);
  try {
    await serve({ socket: `/tmp/.X11-unix/X${display.slice(1)}`, cookie: new Uint8Array(Buffer.from(cookieHex, "hex")), listen: port, video, ...(ffmpeg ? { ffmpeg } : {}) });
  } catch (e) {
    process.stderr.write(`fleetd box-frames: ${(e as Error).message}\n`);
    return 1;
  }
  return 0;
}
