import * as NodeHttp from "node:http";
import { PROTOCOL_VERSION } from "@fleetd/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import pkg from "../../package.json" with { type: "json" };
import * as McpEndpoint from "../mcp/McpEndpoint.ts";
import * as AppSocket from "./AppSocket.ts";
import * as NodeLinkServer from "../link/NodeLinkServer.ts";

export const DEFAULT_LISTEN = { host: "127.0.0.1", port: 4790 } as const;

/** Upgrades a GET to a WebSocket and hands it to `session` for the life of the connection. */
const webSocketRoute = (session: (socket: Socket.Socket) => Effect.Effect<void, never, Scope.Scope>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Expected a WebSocket upgrade", { status: 426 });
    }
    const socket = yield* request.upgrade;
    yield* Effect.scoped(session(socket));
    return HttpServerResponse.empty();
  });

const layerRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/healthz",
    HttpServerResponse.jsonUnsafe({ ok: true, version: pkg.version, protocol: PROTOCOL_VERSION }),
  ),
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const app = yield* AppSocket.AppSocket;
      yield* router.add("GET", "/app", webSocketRoute(app.handle));
    }),
  ),
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const link = yield* NodeLinkServer.NodeLinkServer;
      yield* router.add("GET", "/node/link", webSocketRoute(link.handle));
    }),
  ),
  McpEndpoint.layer,
);

/** The hub's HTTP server: /healthz, /mcp, /app and /node/link on one loopback port by default. */
export const layer = (listen: { readonly host: string; readonly port: number }) =>
  HttpRouter.serve(layerRoutes, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: listen.host, port: listen.port })),
  );
