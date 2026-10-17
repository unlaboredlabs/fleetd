// One WebSocket connection to a stock T3 server, built only from the vendored wire client.
// Same handshake T3's own remote clients use (and S0 verified): bearer -> one-time ws ticket ->
// /ws?wsTicket=…&orchestrationProtocol=2, then WsRpcGroup over effect's RpcClient.
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
  makeEnvironmentHttpApiGroupClient,
} from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const TICKET_TIMEOUT_MS = 10_000;

/** Opens the socket in the caller's scope; closing the scope drops it. The bearer is never logged. */
export const connect = (t3Url: string, bearer: string) =>
  Effect.gen(function* () {
    const base = new URL(t3Url).origin;
    const ticket = yield* executeEnvironmentHttpRequest(
      `${base}/api/auth/websocket-ticket`,
      TICKET_TIMEOUT_MS,
      Effect.flatMap(makeEnvironmentHttpApiGroupClient(base, "auth"), (auth) =>
        auth.webSocketTicket({ headers: { authorization: `Bearer ${bearer}` } }),
      ),
    ).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch)));
    const url = new URL("/ws", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        // No retries inside the protocol: the executor owns reconnects, with a fresh ticket each time.
        RpcClient.makeProtocolSocket({ pingTimeout: "15 seconds", retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url.toString(), { openTimeout: "15 seconds" }).pipe(
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
  });

export type T3Client = Effect.Success<ReturnType<typeof connect>>;
