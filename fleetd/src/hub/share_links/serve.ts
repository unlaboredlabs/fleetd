// Share links as the workspace serves them, on its own address under its preview name (`<name>.<preview address>`):
// every request whose Host is a preview's comes here and never to the workspace's own routes.
//
// The gate: a visitor needs the link's cookie, which only a one-time code at `/.fleetd/preview` sets, and a code only
// a signed-in member's device gets (`share_link_open`). Each visit checks the link (open, the switch on) and the person
// (still a member). A visitor without the cookie gets a page that sends them to the fleetd app to sign in.
//
// The traffic: the workspace asks the link's machine to dial back (`preview_dial`, as a screen's relay asks its
// runner), and the machine's node connects that stream to the port on its own loopback: raw bytes both ways on
// `/preview/<token>`, a one-time token. Each link keeps a few such streams open for its HTTP requests (proxy.ts
// Upstream), and each WebSocket (hot reload) gets one of its own.
import type { Server } from "bun";
import { Duplex } from "node:stream";
import type { Hub } from "../api/hub.ts";
import { auditLog } from "../audit/store.ts";
import type { RouteContext, Socket, SocketData, SocketHandler } from "../http/route.ts";
import { link } from "../link/index.ts";
import { people } from "../people/store.ts";
import { cookieEnd, header, read, refreshDue, sign, verify } from "./cookie.ts";
import { bridge, type Limits, plainPage, Upstream, upgradeToDev } from "./proxy.ts";
import { DIAL_WAIT, ENTER_PATH, isToken, newToken, previewHostName, previewUrl, safePath } from "./rules.ts";
import { type Held, isOpen, shareLinks } from "./store.ts";

/** What a preview may carry on a workspace: a request's body, and how long an answer may go quiet. */
export const LIMITS: Limits = { maxRequestBytes: 64 << 20, idleMs: 60_000 };
/** A link's kept-open streams close after this long unused. */
const UPSTREAM_IDLE_MS = 5 * 60_000;

/** One-time codes a signed-in device took for a link, by code. */
export class Codes {
  private readonly byCode = new Map<string, { name: string; personId: string; untilMs: number }>();
  put(code: string, c: { name: string; personId: string; untilMs: number }, now: number): void {
    for (const [k, v] of this.byCode) if (v.untilMs < now) this.byCode.delete(k);
    this.byCode.set(code, c);
  }
  /** The code's link and person, once. */
  take(code: string, now: number): { name: string; personId: string } | undefined {
    const c = this.byCode.get(code);
    this.byCode.delete(code);
    return c && c.untilMs > now ? c : undefined;
  }
  dropLink(name: string): void {
    for (const [k, v] of this.byCode) if (v.name === name) this.byCode.delete(k);
  }
}
export const codes = (hub: Hub) => hub.area("share_links.codes", () => new Codes());

/** Streams asked of machines, by their one-time token, and each link's way to its dev server. */
class Dials {
  readonly waiting = new Map<string, { resolve: (s: Duplex) => void; reject: (e: Error) => void; timer: Timer }>();
  readonly upstreams = new Map<string, { up: Upstream; port: number; machineId: string; usedMs: number }>();
  /** Each link's open WebSockets, closed when it is stopped. */
  readonly sockets = new Map<string, Set<Socket>>();
}

/** A stopped link's streams and WebSockets close at once, and its codes go. */
export function cut(hub: Hub, name: string): void {
  const d = dials(hub);
  d.upstreams.get(name)?.up.close();
  d.upstreams.delete(name);
  for (const ws of d.sockets.get(name) ?? []) ws.close(1001, "the share link was stopped");
  d.sockets.delete(name);
  codes(hub).dropLink(name);
}
const dials = (hub: Hub) => hub.area("share_links.dials", () => new Dials());

/** A server websocket (a machine's side of a stream) as a byte stream. */
function wsStream(ws: Socket): Duplex {
  let drained: ((e?: Error | null) => void) | undefined;
  const d = new Duplex({
    write(chunk: Buffer, _enc, cb) {
      const sent = ws.send(chunk);
      if (sent === 0) cb(new Error("the machine's stream closed"));
      else if (sent === -1) drained = cb;
      else cb();
    },
    read() {},
    final(cb) {
      ws.close();
      cb();
    },
    destroy(error, cb) {
      try {
        ws.close();
      } catch {}
      cb(error);
    },
  });
  ws.data.state = {
    drain: () => {
      const cb = drained;
      drained = undefined;
      cb?.();
    },
    stream: d,
  };
  return d;
}

const streamHandler: SocketHandler = {
  message(ws, message) {
    const s = (ws.data.state as { stream: Duplex }).stream;
    s.push(typeof message === "string" ? Buffer.from(message) : message);
  },
  close(ws) {
    const s = (ws.data.state as { stream: Duplex }).stream;
    s.push(null);
    s.destroy();
  },
  drain(ws) {
    (ws.data.state as { drain: () => void }).drain();
  },
};

/** `/preview/<token>`: a machine's side of a stream the workspace asked it for; `?refused=1` when its port took none. */
export function previewDialRoute(req: Request, ctx: RouteContext): Response | undefined {
  const token = ctx.params.token ?? "";
  if (!isToken(token)) return new Response("not a fleetd preview stream", { status: 403 });
  const d = dials(ctx.hub);
  const waiting = d.waiting.get(token);
  if (!waiting) return new Response("no preview stream asked for at this token", { status: 410 });
  d.waiting.delete(token);
  clearTimeout(waiting.timer);
  if (new URL(req.url).searchParams.get("refused") === "1" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    waiting.reject(new Error("nothing listens on that port"));
    return new Response(null, { status: 204 });
  }
  const ok = ctx.server.upgrade(req, { data: { handler: { ...streamHandler, open: (ws: Socket) => waiting.resolve(wsStream(ws)) }, state: undefined } });
  if (ok) return undefined;
  waiting.reject(new Error("the stream didn't open"));
  return new Response("Expected a WebSocket upgrade", { status: 426 });
}

/** A new stream to `port` on `machineId`, through the machine's own dial back. */
export function openStream(hub: Hub, machineId: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const token = newToken();
    const d = dials(hub);
    const timer = setTimeout(() => {
      d.waiting.delete(token);
      reject(new Error("the machine didn't dial back"));
    }, DIAL_WAIT);
    d.waiting.set(token, { resolve, reject, timer });
    if (!link(hub).send(machineId, { t: "preview_dial", token, port })) {
      clearTimeout(timer);
      d.waiting.delete(token);
      reject(new Error("the machine is offline"));
    }
  });
}

function upstreamOf(hub: Hub, l: Held, origin: string): Upstream {
  const d = dials(hub);
  const now = Date.now();
  for (const [name, u] of d.upstreams) {
    if (now - u.usedMs > UPSTREAM_IDLE_MS) {
      u.up.close();
      d.upstreams.delete(name);
    }
  }
  let u = d.upstreams.get(l.name);
  if (!u) {
    u = { up: new Upstream(() => openStream(hub, l.machineId, l.port), LIMITS, { port: l.port, origin }), port: l.port, machineId: l.machineId, usedMs: now };
    d.upstreams.set(l.name, u);
  }
  u.usedMs = now;
  return u.up;
}

/** The link name a request is for, when its Host is a preview's of this workspace. */
export function previewNameOf(hub: Hub, req: Request): string | undefined {
  const base = shareLinks(hub).cachedPreviewUrl();
  if (!base) return undefined;
  return previewHostName(req.headers.get("host"), new URL(base).hostname);
}

const ended = () => plainPage(410, "This preview link has ended", "<p>Share links last a few hours. Ask for a new one in the chat.</p>");
const off = () => plainPage(403, "Share links are off in this workspace", "<p>An owner or admin of the workspace turns them on in Settings.</p>");
const notMember = () =>
  plainPage(403, "This preview is for the workspace's members", "<p>You aren't a member of the workspace this preview belongs to. Ask its owner to invite you.</p>");

function signIn(url: string): Response {
  const app = `fleetd://preview?url=${encodeURIComponent(url)}`;
  return plainPage(
    401,
    "Sign in to open this preview",
    `<p>Only the workspace's members open its previews. Open this link in the fleetd app, on a device signed in to the workspace.</p><p><a class="b" href="${app.replace(/&/g, "&amp;")}">Open in fleetd</a></p>`,
  );
}

/** A request on a preview host: the gate, then the dev server. */
export async function servePreview(hub: Hub, req: Request, server: Server<SocketData>, name: string): Promise<Response | undefined> {
  const sl = shareLinks(hub);
  const now = hub.clock.now();
  const l = sl.get(name);
  if (!l || !isOpen(l, now)) return ended();
  if (!sl.enabled()) return off();
  const base = sl.cachedPreviewUrl()!;
  const origin = previewUrl(base, name);
  const secure = base.startsWith("https:");
  const url = new URL(req.url);
  if (url.pathname === ENTER_PATH) {
    const code = url.searchParams.get("code") ?? "";
    const taken = codes(hub).take(code, now);
    if (!taken || taken.name !== name) return signIn(origin + safePath(url.searchParams.get("to")));
    const person = people(hub).get(taken.personId);
    if (!person || person.removedAt !== undefined) return notMember();
    const exp = cookieEnd(now, l.expiresMs);
    auditLog(hub).record({
      kind: "share_link.open",
      actor: { kind: "person", name: person.name, personId: person.personId },
      target: l.name,
      summary: `Opened the share link of port ${l.port} on ${l.machineId}`,
      data: { machine: l.machineId, port: l.port, expiresAt: new Date(l.expiresMs).toISOString() },
    });
    return new Response(null, {
      status: 302,
      headers: { location: safePath(url.searchParams.get("to")), "set-cookie": header(signCookie(l, person.personId, exp), exp, now, secure), "cache-control": "no-store" },
    });
  }
  const value = read(req.headers.get("cookie"), secure);
  const pass = value === undefined ? undefined : verify(l.secret, name, value, now);
  if (!pass) return signIn(origin + url.pathname + url.search);
  const person = people(hub).get(pass.personId);
  if (!person || person.removedAt !== undefined) return notMember();
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const dev = await upgradeToDev(req, () => openStream(hub, l.machineId, l.port), LIMITS, { port: l.port, origin });
    if ("refused" in dev) return dev.refused;
    let b: ReturnType<typeof bridge> | undefined;
    const handler: SocketHandler = {
      open(ws) {
        const all = dials(hub).sockets;
        if (!all.has(name)) all.set(name, new Set());
        all.get(name)!.add(ws);
        b = bridge({ send: (m) => ws.send(m), close: (code, reason) => ws.close(code, reason) }, dev.socket, dev.head);
      },
      message(_ws, message) {
        b?.message(message);
      },
      close(ws, code, reason) {
        dials(hub).sockets.get(name)?.delete(ws);
        b?.close(code, reason);
      },
    };
    const ok = server.upgrade(req, { data: { handler, state: undefined }, headers: dev.protocol !== undefined ? { "sec-websocket-protocol": dev.protocol } : {} });
    if (ok) return undefined;
    dev.socket.destroy();
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const answer = await upstreamOf(hub, l, origin).fetch(req);
  if (refreshDue(pass.expMs, now, l.expiresMs)) {
    const exp = cookieEnd(now, l.expiresMs);
    answer.headers.append("set-cookie", header(signCookie(l, person.personId, exp), exp, now, secure));
  }
  return answer;
}

const signCookie = (l: Held, personId: string, exp: number) => sign(l.secret, l.name, personId, exp);
