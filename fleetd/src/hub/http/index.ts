// The hub's HTTP server: the same routes on one port, loopback by default. Each
// route is its module's; a module not ported yet answers 501 with what it is.
import type { Server } from "bun";
import { PROTOCOL_VERSION } from "../../shared/contracts.ts";
import { internalError, NotImplemented } from "../../shared/errors.ts";
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";
import { hook } from "../automations/webhook.ts";
import { hubLink } from "../hub_links/serve.ts";
import { nodeLink } from "../link/socket.ts";
import { relay } from "../machine_roles/relay.ts";
import { mcp } from "../mcp/http.ts";
import { oauthCallback } from "../mcp_oauth/callback.ts";
import { macPair, pair } from "../pair/http.ts";
import { app } from "../app_ws/socket.ts";
import { gzipped } from "./gzip.ts";
import { json, type Route, type RouteContext, type SocketData } from "./route.ts";

/** Node links, /app sessions and events_wait long-polls never end on their own: after a stop they get this long. */
export const SHUTDOWN_GRACE_MS = 800;

const healthz: Route = () => json({ ok: true, version: VERSION, protocol: PROTOCOL_VERSION });

/** The Rust router's routes, in its order. `ANY` takes every method. */
export const ROUTES: [method: "GET" | "POST" | "ANY", path: string, route: Route][] = [
  ["GET", "/healthz", healthz],
  ["ANY", "/mcp", gzipped(mcp)],
  ["GET", "/app", app],
  ["POST", "/pair", pair],
  ["POST", "/pair/mac", macPair],
  ["GET", "/node/link", nodeLink],
  ["GET", "/relay/{token}", relay],
  ["POST", "/hooks/{automation_id}/{secret}", hook],
  ["ANY", "/link/v1/{op}", gzipped(hubLink)],
  ["GET", "/oauth/callback", oauthCallback],
];

type Compiled = { method: string; pattern: RegExp; names: string[]; route: Route };

function compile(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  const source = path.replace(/\{(\w+)\}/g, (_, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${source}$`), names };
}

const compiled: Compiled[] = ROUTES.map(([method, path, route]) => ({ method, route, ...compile(path) }));

/** What escapes a route (and Bun.serve's own failures): logged, and answered `failed` as JSON. */
export function onError(error: Error): Response {
  console.error("hub http:", error);
  return json(internalError().toJSON(), 500);
}

/** The path's `{name}` segments, decoded; undefined when one isn't valid percent-encoding. */
function decodeParams(names: string[], match: RegExpExecArray): Record<string, string> | undefined {
  try {
    return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? "")]));
  } catch {
    return undefined;
  }
}

/** Serves `hub` on its `--listen` address until `stop` is called. */
export function serve(hub: Hub, tools: Registry, port = hub.config.listen.port): Server<SocketData> {
  return Bun.serve<SocketData>({
    hostname: hub.config.listen.host,
    port,
    // Never Bun's development error page (stack, source, cwd) to a client: anything that escapes a route is `failed`.
    development: false,
    error: onError,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      for (const r of compiled) {
        const match = r.pattern.exec(path);
        if (!match) continue;
        // HEAD is GET's, as axum serves it.
        if (r.method !== "ANY" && r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) {
          return new Response(null, { status: 405 });
        }
        const params = decodeParams(r.names, match);
        // A malformed escape is the client's, as axum's Path extractor answers it.
        if (!params) return new Response("Invalid URL: a path segment is not valid percent-encoding", { status: 400 });
        const ctx: RouteContext = { hub, tools, server, params, ip: server.requestIP(req)?.address };
        try {
          return await r.route(req, ctx);
        } catch (error) {
          if (error instanceof NotImplemented) {
            return json({ code: "failed", message: error.message, fix: "Use the Rust hub for this for now." }, 501);
          }
          console.error(`hub http ${req.method} ${path}:`, error);
          return json(internalError().toJSON(), 500);
        }
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      // Bun sets this per server, not per route: the session relay carries CDP frames of up to 128 MB
      // (machine_roles/relay.ts MAX_MESSAGE), as the Rust relay allows.
      maxPayloadLength: 128 << 20,
      open: (ws) => ws.data.handler.open?.(ws),
      message: (ws, message) => ws.data.handler.message(ws, message),
      close: (ws, code, reason) => ws.data.handler.close?.(ws, code, reason),
      drain: (ws) => ws.data.handler.drain?.(ws),
      pong: (ws, data) => ws.data.handler.pong?.(ws, data),
    },
  });
}

/** Stops taking connections, then gives open ones SHUTDOWN_GRACE_MS before closing them. */
export async function stop(server: Server<SocketData>): Promise<void> {
  const graceful = server.stop(false);
  const timer = setTimeout(() => void server.stop(true), SHUTDOWN_GRACE_MS);
  await graceful;
  clearTimeout(timer);
}
