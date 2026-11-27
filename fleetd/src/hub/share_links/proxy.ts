// A visitor's request to a share link, spoken as HTTP/1.1 to the dev server over a byte stream to its port (the
// machine's dial-back on a workspace, a computer's port on fleetd's cloud), and the visitor's WebSocket (a dev
// server's hot reload) carried over the same kind of stream. node:* only, for the cloud at its pin
// (`fleetd/hub/share_links/proxy`).
//
// To the dev server a visit looks like one from its own machine: Host is `localhost:<port>` and an Origin or Referer
// of the preview's own becomes `http://localhost:<port>`, as dev servers (Vite's host and origin checks) allow, and a
// redirect it sends to localhost goes back as the preview's. The preview's own cookie never reaches it.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { Duplex } from "node:stream";
import { strip } from "./cookie.ts";

/** A new byte stream to the dev server's port. */
export type Open = () => Promise<Duplex>;

export type Limits = {
  /** The most a request's body may hold; past it the visitor gets a 413. */
  maxRequestBytes: number;
  /** How long an HTTP answer may go quiet before it is cut. WebSockets aren't timed: hot reload sits idle for hours. */
  idleMs: number;
  /** Each piece of bytes either way, request and answer, WebSocket frames too: for counting. */
  onBytes?: (n: number) => void;
};

/** The dev server's port, and the preview's own origin (`https://<name>.<preview domain>`). */
export type Target = { port: number; origin: string };

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
const WS_OWN = new Set(["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept"]);

/** The page a visitor sees when the dev server can't be reached or answered wrong. */
export function plainPage(status: number, title: string, line: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#1b1b1f}
main{max-width:26rem;padding:2rem}h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0 0 1rem;color:#55555c}
a.b{display:inline-block;background:#1b1b1f;color:#fff;border-radius:8px;padding:.55rem 1rem;text-decoration:none;font-weight:500}
@media(prefers-color-scheme:dark){body{background:#141416;color:#ececef}p{color:#a0a0a8}a.b{background:#ececef;color:#141416}}</style>
<main><h1>${esc(title)}</h1>${line}</main>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}

// fleetd's own pages answer 503, never 502: Cloudflare's front on the cloud swaps an origin's 502 for its own "Bad
// gateway" page, so a visitor would never read why.
const unreachable = (port: number) =>
  plainPage(503, "The dev server isn't answering", `<p>Nothing answered on port ${port} of the machine this link shares. Start the dev server again, then reload.</p>`);

/** A stream as node:http's Agent takes a socket; it opens when first asked, holding writes until then. */
function lazySocket(open: Open, onBytes?: (n: number) => void): Duplex {
  let real: Duplex | undefined;
  let ended = false;
  const held: [Buffer, (e?: Error | null) => void][] = [];
  const d = new Duplex({
    write(chunk: Buffer, _enc, cb) {
      onBytes?.(chunk.length);
      if (real) real.write(chunk, cb);
      else held.push([chunk, cb]);
    },
    read() {
      real?.resume();
    },
    final(cb) {
      if (real) real.end();
      else ended = true;
      cb();
    },
    destroy(error, cb) {
      real?.destroy();
      cb(error);
    },
  });
  Object.assign(d, { setKeepAlive: () => d, setNoDelay: () => d, setTimeout: () => d, ref: () => d, unref: () => d });
  open().then(
    (r) => {
      if (d.destroyed) return void r.destroy();
      real = r;
      r.on("data", (c: Buffer) => {
        onBytes?.(c.length);
        if (!d.push(c)) r.pause();
      });
      r.on("end", () => d.push(null));
      r.on("error", (e) => d.destroy(e));
      r.on("close", () => d.destroy());
      for (const [chunk, cb] of held.splice(0)) r.write(chunk, cb);
      if (ended) r.end();
    },
    (e: Error) => d.destroy(e),
  );
  return d;
}

/** The visitor's headers as the dev server gets them. */
function toDev(from: Headers, t: Target): Record<string, string> {
  const local = `http://localhost:${t.port}`;
  const out: Record<string, string> = {};
  from.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP.has(k) || WS_OWN.has(k) || k === "cookie") return;
    if ((k === "origin" || k === "referer") && (value === t.origin || value.startsWith(`${t.origin}/`))) value = local + value.slice(t.origin.length);
    out[k] = value;
  });
  const cookie = strip(from.get("cookie"));
  if (cookie !== undefined) out.cookie = cookie;
  out.host = `localhost:${t.port}`;
  out["x-forwarded-host"] = new URL(t.origin).host;
  out["x-forwarded-proto"] = new URL(t.origin).protocol.slice(0, -1);
  return out;
}

/** The dev server's answer headers as the visitor gets them. */
function fromDev(raw: string[], t: Target): Headers {
  const out = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i]!.toLowerCase();
    let v = raw[i + 1]!;
    if (HOP.has(k)) continue;
    if (k === "location") {
      for (const local of [`http://localhost:${t.port}`, `http://127.0.0.1:${t.port}`]) if (v === local || v.startsWith(`${local}/`)) v = t.origin + v.slice(local.length);
    }
    out.append(k, v);
  }
  return out;
}

/** One link's way to its dev server: HTTP requests on a few kept-open streams. */
export class Upstream {
  private readonly agent: http.Agent;

  constructor(
    private readonly open: Open,
    private readonly limits: Limits,
    private readonly target: Target,
  ) {
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
    (this.agent as unknown as { createConnection: () => Duplex }).createConnection = () => lazySocket(this.open, this.limits.onBytes);
  }

  /** The dev server's answer to `req`, streamed; a 503 page when it can't be reached, a 413 past maxRequestBytes. */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const t = this.target;
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > this.limits.maxRequestBytes) return new Response("Request too large for a preview", { status: 413 });
    return await new Promise<Response>((resolve) => {
      let settled = false;
      const done = (r: Response) => {
        if (!settled) (settled = true), resolve(r);
      };
      let timer: Timer | undefined;
      const out = http.request(
        { agent: this.agent, method: req.method, path: url.pathname + url.search, headers: toDev(req.headers, t), setHost: false },
        (res) => {
          const idle = () => {
            clearTimeout(timer);
            timer = setTimeout(() => res.destroy(new Error("idle")), this.limits.idleMs);
          };
          idle();
          const empty = req.method === "HEAD" || res.statusCode === 204 || res.statusCode === 304;
          const body = empty
            ? null
            : new ReadableStream<Uint8Array>({
                start(c) {
                  res.on("data", (chunk: Buffer) => {
                    idle();
                    c.enqueue(new Uint8Array(chunk));
                    if ((c.desiredSize ?? 1) <= 0) res.pause();
                  });
                  res.on("end", () => (clearTimeout(timer), c.close()));
                  res.on("error", (e) => (clearTimeout(timer), c.error(e)));
                },
                pull() {
                  res.resume();
                },
                cancel() {
                  clearTimeout(timer);
                  res.destroy();
                },
              });
          if (empty) res.resume().on("end", () => clearTimeout(timer));
          done(new Response(body, { status: res.statusCode ?? 502, statusText: res.statusMessage ?? "", headers: fromDev(res.rawHeaders, t) }));
        },
      );
      out.on("error", () => (clearTimeout(timer), done(unreachable(t.port))));
      timer = setTimeout(() => (out.destroy(), done(unreachable(t.port))), this.limits.idleMs);
      void (async () => {
        if (!req.body) return void out.end();
        let total = 0;
        try {
          for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
            total += chunk.length;
            if (total > this.limits.maxRequestBytes) {
              out.destroy();
              return done(new Response("Request too large for a preview", { status: 413 }));
            }
            if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          }
          out.end();
        } catch {
          out.destroy();
        }
      })();
    });
  }

  /** Closes the kept-open streams. */
  close(): void {
    this.agent.destroy();
  }
}

/**
 * Sends the visitor's WebSocket upgrade to the dev server over a stream of its own, and reads its answer: the
 * upgraded stream (its first bytes in `head`) and the subprotocol it chose, which the visitor's 101 must echo; or its
 * refusal, to give the visitor as it is. No permessage-deflate is asked for, so the frames stay plain.
 */
export function upgradeToDev(
  req: Request,
  open: Open,
  limits: Limits,
  target: Target,
): Promise<{ refused: Response } | { socket: Duplex; head: Buffer; protocol?: string }> {
  const url = new URL(req.url);
  const key = randomBytes(16).toString("base64");
  const headers = { ...toDev(req.headers, target), connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key };
  return new Promise((resolve) => {
    const timer = setTimeout(() => (out.destroy(), resolve({ refused: unreachable(target.port) })), limits.idleMs);
    const out = http.request({ method: "GET", path: url.pathname + url.search, headers, setHost: false, createConnection: (() => lazySocket(open, limits.onBytes)) as never });
    out.on("upgrade", (res, socket: Duplex, head: Buffer) => {
      clearTimeout(timer);
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) {
        socket.destroy();
        return resolve({ refused: plainPage(503, "The dev server's WebSocket answered wrong", "<p>Its handshake didn't match.</p>") });
      }
      const protocol = res.headers["sec-websocket-protocol"];
      resolve({ socket, head, ...(typeof protocol === "string" ? { protocol } : {}) });
    });
    out.on("response", (res) => {
      clearTimeout(timer);
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= 1 << 20) chunks.push(c);
      });
      res.on("end", () => resolve({ refused: new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: fromDev(res.rawHeaders, target) }) }));
      res.on("error", () => resolve({ refused: unreachable(target.port) }));
    });
    out.on("error", () => (clearTimeout(timer), resolve({ refused: unreachable(target.port) })));
    out.end();
  });
}

/** The visitor's side of a bridged WebSocket: a server socket's `send` and `close`. */
export type VisitorSocket = { send(data: string | Uint8Array): unknown; close(code?: number, reason?: string): unknown };

/** The most one WebSocket message from the dev server may hold. */
export const MAX_WS_MESSAGE = 64 << 20;

/** A close code a peer may send (RFC 6455 7.4): 1000 to 4999, less the ones that only say none came. */
const sendable = (code: number | undefined) =>
  code !== undefined && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) && (code >= 3000 || code <= 1014);

/** A client frame (masked, as a client's must be): `opcode` with `payload`. */
export function clientFrame(opcode: number, payload: Uint8Array): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  } else if (n >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, mask, body]);
}

/**
 * Pipes a visitor's WebSocket and the dev server's upgraded stream, frame for frame, until either closes: the
 * visitor's messages go as client frames, the dev server's (whole, its fragments joined) to the visitor, a ping is
 * answered, and a close goes across with its code. Returns what the visitor's socket handler calls.
 */
export function bridge(
  visitor: VisitorSocket,
  socket: Duplex,
  head: Buffer = Buffer.alloc(0),
  onBytes?: (n: number) => void,
): { message(data: string | Uint8Array): void; close(code?: number, reason?: string): void } {
  let buf: Buffer = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let partsOp = 0;
  let partsLen = 0;
  let closed = false;
  const end = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    visitor.close(sendable(code) ? code : 1000, reason?.slice(0, 120));
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref?.();
  };
  const take = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0]! & 0x80) !== 0;
      const op = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_MESSAGE)) return end(1009, "message too big");
        len = Number(big);
        at = 10;
      }
      if (len > MAX_WS_MESSAGE) return end(1009, "message too big");
      const maskAt = at;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      let payload = buf.subarray(at, at + len);
      if (masked) {
        const m = buf.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ m[i & 3]!));
      }
      buf = buf.subarray(at + len);
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
        return end(code, payload.length > 2 ? payload.subarray(2).toString("utf8") : undefined);
      }
      if (op === 0x9) {
        socket.write(clientFrame(0xa, payload));
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) {
        parts = [];
        partsLen = 0;
        partsOp = op;
      } else if (op !== 0x0) return end(1002, "unknown opcode");
      parts.push(Buffer.from(payload));
      partsLen += payload.length;
      if (partsLen > MAX_WS_MESSAGE) return end(1009, "message too big");
      if (!fin) continue;
      const whole = Buffer.concat(parts);
      parts = [];
      partsLen = 0;
      visitor.send(partsOp === 0x1 ? whole.toString("utf8") : new Uint8Array(whole));
    }
  };
  socket.on("data", (chunk: Buffer) => {
    onBytes?.(chunk.length);
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    take();
  });
  socket.on("close", () => end(1001, "the dev server went away"));
  socket.on("error", () => end(1011, "the dev server's stream failed"));
  if (head.length > 0) {
    buf = Buffer.from(head);
    take();
  }
  return {
    message(data) {
      if (closed) return;
      const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      onBytes?.(payload.length);
      socket.write(clientFrame(typeof data === "string" ? 0x1 : 0x2, payload));
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      const r = Buffer.from((reason ?? "").slice(0, 120), "utf8");
      const body = sendable(code) ? Buffer.concat([Buffer.from([(code! >> 8) & 0xff, code! & 0xff]), r]) : Buffer.alloc(0);
      socket.write(clientFrame(0x8, body));
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref?.();
    },
  };
}
