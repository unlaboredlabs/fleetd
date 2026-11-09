// What an HTTP route and a websocket get: the shapes every route module implements.
import type { Server, ServerWebSocket } from "bun";
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";

export type RouteContext = {
  hub: Hub;
  tools: Registry;
  server: Server<SocketData>;
  /** The path's `{name}` segments, decoded. */
  params: Record<string, string>;
  /** The peer's address. */
  ip: string | undefined;
};

/** Answers a request; returns undefined once it upgraded the request to a websocket (`upgrade`). */
export type Route = (req: Request, ctx: RouteContext) => Response | undefined | Promise<Response | undefined>;

export type Socket = ServerWebSocket<SocketData>;

/** One websocket's handler, chosen by its route when it upgrades. */
export interface SocketHandler {
  open?(ws: Socket): void | Promise<void>;
  message(ws: Socket, message: string | Buffer): void | Promise<void>;
  close?(ws: Socket, code: number, reason: string): void | Promise<void>;
  drain?(ws: Socket): void;
  /** A pong to the hub's ping: live screens' pacing times round trips with them (browser/app.ts `pong`). */
  pong?(ws: Socket, data: Buffer): void;
}

/** Each websocket's data: its handler, and whatever state the handler keeps for it. */
export type SocketData = { handler: SocketHandler; state: unknown };

/**
 * Upgrades `req` to a websocket that `handler` serves, with `state` as its `ws.data.state`. A request that isn't an
 * upgrade gets the Rust hub's 426 "Expected a WebSocket upgrade".
 */
export function upgrade(req: Request, ctx: RouteContext, handler: SocketHandler, state: unknown = undefined): Response | undefined {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return expectUpgrade();
  if (ctx.server.upgrade(req, { data: { handler, state } })) return undefined;
  return expectUpgrade();
}

export const expectUpgrade = () => new Response("Expected a WebSocket upgrade", { status: 426 });

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
