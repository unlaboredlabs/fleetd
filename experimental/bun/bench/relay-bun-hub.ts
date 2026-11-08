// The Bun side of bench/frame-relay.ts: the Bun hub's real node link (`/node/link`: challenge, signed hello, frame
// dispatch; src/hub/link) and its live-view path (src/hub/browser: Live, each app connection's slot and pace), with a
// stand-in for `/app` until that area lands (D346): it takes `auth` as a person's key and hands every other message to
// the browser area as app_ws will. Usage: bun bench/relay-bun-hub.ts <home> <port>
import { Hub } from "../src/hub/api/hub.ts";
import { Registry, type Caller } from "../src/hub/api/registry.ts";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { bindApp } from "../src/hub/browser/app.ts";
import { type AppConn, ShimAppWs } from "../src/hub/browser/app_seam.ts";
import type { Route, RouteContext, Socket, SocketData, SocketHandler } from "../src/hub/http/route.ts";
import { link } from "../src/hub/link/index.ts";
import { nodeLink } from "../src/hub/link/socket.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { systemClock } from "../src/shared/clock.ts";

const [home, port] = process.argv.slice(2) as [string, string];
const hub = new Hub({ home, listen: { host: "127.0.0.1", port: Number(port) } }, HubDb.open(home), systemClock);
link(hub).start();
startBrowser(hub);
const app = new ShimAppWs();
bindApp(hub, app);
const person: Caller = {
  keyId: "key_bench",
  name: "bench",
  prefix: "fld_bench",
  kind: "human",
  grants: [{ role: "operate", machines: "*" }],
  createdAt: new Date(0).toISOString(),
};
const conns = new Map<unknown, AppConn>();
const connOf = (ws: Socket) => {
  let conn = conns.get(ws);
  if (!conn) conns.set(ws, (conn = { caller: person, ws }));
  return conn;
};
const appSocket: SocketHandler = {
  message(ws, raw) {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown> & { t: string };
    if (msg.t === "auth") ws.send(JSON.stringify({ t: "ready" }));
    else void app.deliver(connOf(ws), msg);
  },
  close(ws) {
    app.close(connOf(ws));
    conns.delete(ws);
  },
};
const appRoute: Route = (req, ctx) => (ctx.server.upgrade(req, { data: { handler: appSocket, state: undefined } }) ? undefined : new Response(null, { status: 426 }));
const tools = new Registry();
Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: Number(port),
  fetch(req, server) {
    const ctx: RouteContext = { hub, tools, server, params: {}, ip: "127.0.0.1" };
    return new URL(req.url).pathname === "/node/link" ? nodeLink(req, ctx) : appRoute(req, ctx);
  },
  websocket: {
    maxPayloadLength: 128 << 20,
    open: (ws) => ws.data.handler.open?.(ws),
    message: (ws, message) => ws.data.handler.message(ws, message),
    close: (ws, code, reason) => ws.data.handler.close?.(ws, code, reason),
  },
});
console.log("ready");
