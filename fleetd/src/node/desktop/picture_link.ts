// The wire between a box display's `fleetd box-frames` (./box_frames.ts, in the box) and the session that drives the
// display from outside it (../place/box_screens.ts `BoxDisplay.picture`): a JSON line each way, as box_frames.ts says.
// This is the holder's side, with nothing of the machine's (docs/CONTRIBUTING.md "The package").
import type { Duplex } from "node:stream";
import type { BrowserRtcReport } from "../../shared/screens_wire.ts";
import type { PictureRun, PictureSink, Shot } from "./screen.ts";

/** How long a holder waits for box-frames to answer once connected (the display's first connection). */
export const READY_MS = 15_000;
/** How long a screenshot may take. */
const SHOT_MS = 10_000;

/** One JSON line at a time from a stream, as it comes. */
export function lines(s: Duplex, onLine: (line: Record<string, unknown>) => void): void {
  let held: Buffer[] = [];
  s.on("data", (chunk: Buffer) => {
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10)) {
      held.push(chunk.subarray(0, at));
      const text = Buffer.concat(held).toString("utf8");
      held = [];
      chunk = chunk.subarray(at + 1);
      if (!text) continue;
      try {
        onLine(JSON.parse(text) as Record<string, unknown>);
      } catch {
        s.destroy();
        return;
      }
    }
    if (chunk.length) held.push(chunk);
  });
}

export const send = (s: Duplex, line: Record<string, unknown>) => {
  if (!s.destroyed) s.write(`${JSON.stringify(line)}\n`);
};

/**
 * The holder's side, on a connection to a box's `fleetd box-frames`: sends the display's cookie, waits for it to say
 * the display answered, then hands its frames to `on`. Throws why it can't serve (the session reads the screen
 * itself then).
 */
export async function openPicture(s: Duplex, cookie: Uint8Array, session: string, on: PictureSink): Promise<PictureRun> {
  let stopped = false;
  let shots = 0;
  const waiting = new Map<number, { resolve: (shot: Shot) => void; reject: (e: Error) => void }>();
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<string | undefined>();
  let why: string | undefined;
  lines(s, (line) => {
    if (line.ready) return ready.resolve();
    if (typeof line.error === "string") {
      why = line.error;
      return ready.reject(new Error(line.error));
    }
    const live = line.live as Record<string, unknown> | undefined;
    if (live) {
      const width = Number(live.width) || 0;
      const height = Number(live.height) || 0;
      const seq = typeof live.seq === "number" ? { seq: live.seq } : {};
      if (typeof live.h264B64 === "string") return on.live({ ...seq, width, height, h264B64: live.h264B64, key: live.key === true });
      if (typeof live.jpegB64 === "string") return on.live({ ...seq, width, height, jpegB64: live.jpegB64 });
      return;
    }
    const rtc = line.rtc as BrowserRtcReport | undefined;
    if (rtc && typeof rtc.peer === "string") {
      const { sessionId: _id, ...report } = rtc;
      return on.rtc(report);
    }
    const video = line.video as Record<string, unknown> | undefined;
    if (video && typeof video.b64 === "string") {
      const data = new Uint8Array(Buffer.from(video.b64, "base64"));
      if (video.kind === "jpeg") return on.video({ kind: "jpeg", data });
      const size = Array.isArray(video.size) ? ([Number(video.size[0]) || 0, Number(video.size[1]) || 0] as [number, number]) : ([0, 0] as [number, number]);
      return on.video({ kind: "h264", key: video.key === true, size, data });
    }
    if (typeof line.shot === "number") {
      const w = waiting.get(line.shot);
      if (!w) return;
      waiting.delete(line.shot);
      if (typeof line.error === "string") return w.reject(new Error(line.error));
      w.resolve({ jpeg: new Uint8Array(Buffer.from(String(line.jpegB64 ?? ""), "base64")), width: Number(line.width) || 0, height: Number(line.height) || 0 });
    }
  });
  const closed = () => {
    const said = why ?? "the box's picture stopped";
    ready.reject(new Error(said));
    for (const w of waiting.values()) w.reject(new Error(said));
    waiting.clear();
    ended.resolve(stopped ? undefined : said);
  };
  s.on("close", closed);
  s.on("end", () => s.destroy());
  s.on("error", (e: Error) => {
    why ??= e.message;
    s.destroy();
  });
  send(s, { cookie: Buffer.from(cookie).toString("hex"), session });
  let timer: Timer | undefined;
  try {
    await Promise.race([ready.promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`it didn't answer within ${READY_MS / 1000} s`)), READY_MS)))]);
  } catch (e) {
    stopped = true;
    s.destroy();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return {
    watch: (w) => send(s, { watch: w ?? null }),
    key: () => send(s, { key: true }),
    control: (control) => send(s, { control }),
    videoJpeg: () => send(s, { videoJpeg: true }),
    rtc: (frame) => send(s, { rtc: frame }),
    shot: () => {
      const id = ++shots;
      const shot = Promise.withResolvers<Shot>();
      if (s.destroyed) return Promise.reject(new Error(why ?? "the box's picture stopped"));
      waiting.set(id, shot);
      send(s, { shot: id });
      const timer = setTimeout(() => {
        if (waiting.delete(id)) shot.reject(new Error(`the screenshot didn't come within ${SHOT_MS / 1000} s`));
      }, SHOT_MS);
      return shot.promise.finally(() => clearTimeout(timer));
    },
    stop: () => {
      stopped = true;
      s.destroy();
    },
    ended: ended.promise,
  };
}

