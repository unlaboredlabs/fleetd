// A minimal client of the hub's /app socket, as the desktop and phone apps speak it (app/desktop/src/main/hub): the
// key on the upgrade request and again as the first `auth` frame, `snapshot`, `call`s by id. With `deflate` it offers
// the feature and reads the hub's permessage-deflate Binary frames (one raw DEFLATE stream per connection, each frame
// sync-flushed with its 00 00 ff ff cut off), as transport.ts does. Counts the bytes it receives on the wire.
import { constants, createInflateRaw, type InflateRaw } from "node:zlib";

export type Frame = Record<string, any> & { t: string };
const SYNC_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

const inflater = () => {
  let stream: InflateRaw | null = null;
  return (data: Buffer) =>
    new Promise<string>((resolve, reject) => {
      stream ??= createInflateRaw({ windowBits: 15 });
      const s = stream;
      const chunks: Array<Buffer> = [];
      const onData = (chunk: Buffer) => chunks.push(chunk);
      s.on("data", onData);
      s.once("error", reject);
      s.write(Buffer.concat([data, SYNC_TAIL]));
      s.flush(constants.Z_SYNC_FLUSH, () => {
        s.off("data", onData);
        s.off("error", reject);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
};

export interface AppClient {
  /** Every frame so far, with the time (performance.now()) it was read. */
  readonly frames: Array<{ at: number; frame: Frame }>;
  /** Resolves with the first frame (from now, or from `since`) that matches. */
  readonly next: (match: (f: Frame) => boolean, ms?: number, since?: number) => Promise<{ at: number; frame: Frame }>;
  readonly call: (tool: string, input?: unknown, ms?: number) => Promise<{ ok: boolean; output: any; frame: Frame }>;
  readonly send: (frame: unknown) => void;
  readonly opened: Promise<number>;
  readonly bytes: () => number;
  readonly close: () => void;
}

export const appUrl = (hubUrl: string) => `${hubUrl.replace(/^http/u, "ws").replace(/\/+$/u, "")}/app`;

/**
 * Opens /app on `hubUrl` and authenticates; `ready` and `snapshot` arrive as frames (see `next`). Events stream from
 * the snapshot's cursor on, or from `cursor` (0: every event the hub keeps).
 */
export const connectApp = (hubUrl: string, key: string, opts: { deflate?: boolean; cursor?: number } = {}): AppClient => {
  const features = opts.deflate === true ? ["deflate"] : [];
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (features.length > 0) headers["x-fleetd-features"] = features.join(",");
  const socket = new WebSocket(appUrl(hubUrl), { headers } as unknown as Array<string>);
  socket.binaryType = "arraybuffer";
  const frames: AppClient["frames"] = [];
  const waiters: Array<{ match: (f: Frame) => boolean; since: number; resolve: (x: { at: number; frame: Frame }) => void }> = [];
  let bytes = 0;
  let streaming = false;
  let ids = 0;
  const inflate = inflater();
  let order = Promise.resolve();
  const deliver = (text: string) => {
    const at = performance.now();
    const frame = JSON.parse(text) as Frame;
    frames.push({ at, frame });
    // As the apps do: the event stream from the snapshot's cursor on (or the one asked for).
    if (frame.t === "snapshot" && !streaming) {
      streaming = true;
      socket.send(JSON.stringify({ t: "events", cursor: opts.cursor ?? frame.cursor }));
    }
    for (const w of [...waiters]) {
      if (w.match(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve({ at, frame });
      }
    }
  };
  socket.addEventListener("message", (e) => {
    const data = e.data as string | ArrayBuffer;
    bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    // Frames reach the reader in the order they came: a Text frame waits for the Binary ones before it.
    order = order.then(async () => deliver(typeof data === "string" ? data : await inflate(Buffer.from(data))));
  });
  const opened = new Promise<number>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve(performance.now());
      socket.send(JSON.stringify({ t: "auth", key, features }));
      socket.send(JSON.stringify({ t: "snapshot" }));
    });
    socket.addEventListener("error", () => reject(new Error(`/app on ${hubUrl}: the socket failed`)));
  });
  opened.catch(() => undefined);
  const next: AppClient["next"] = (match, ms = 30_000, since = performance.now()) => {
    const seen = frames.find((f) => f.at >= since && match(f.frame));
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matching /app frame within ${ms} ms`)), ms);
      waiters.push({ match, since, resolve: (x) => (clearTimeout(timer), resolve(x)) });
    });
  };
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  return {
    frames,
    next,
    send,
    opened,
    bytes: () => bytes,
    close: () => socket.close(),
    call: async (tool, input = {}, ms = 60_000) => {
      const id = `c${++ids}`;
      const answer = next((f) => (f.t === "result" || f.t === "error") && f.id === id, ms);
      send({ t: "call", id, tool, input });
      const { frame } = await answer;
      return { ok: frame.t === "result", output: frame.t === "result" ? frame.output : frame, frame };
    },
  };
};
