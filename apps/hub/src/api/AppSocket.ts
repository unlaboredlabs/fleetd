import {
  AppClientMessage,
  PROTOCOL_VERSION,
  ProtocolVersion,
  type AgentKeyInfo,
  type AppServerMessage,
  type McpToolError,
} from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as FleetApi from "./FleetApi.ts";
import * as Auth from "../auth/Auth.ts";

/** Close code for a connection whose key was refused. */
export const CLOSE_UNAUTHORIZED = 4401;

/**
 * The minimal M1 app WebSocket at /app: `auth` with an agent key, then `snapshot` for the
 * fleetd_status data and `events` to stream HubEvents after a cursor as they happen.
 */
export class AppSocket extends Context.Service<
  AppSocket,
  { readonly handle: (socket: Socket.Socket) => Effect.Effect<void, never, Scope.Scope> }
>()("fleetd/hub/api/AppSocket") {}

const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(AppClientMessage));
const textDecoder = new TextDecoder();

const errorFrame = (error: McpToolError): AppServerMessage => ({
  t: "error",
  code: error.code,
  message: error.message,
  ...(error.fix === undefined ? {} : { fix: error.fix }),
});

const make = Effect.gen(function* () {
  const auth = yield* Auth.Auth;
  const api = yield* FleetApi.FleetApi;

  const handle = Effect.fnUntraced(function* (socket: Socket.Socket) {
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const send = (message: AppServerMessage) => writer.write(JSON.stringify(message));
    const stream = yield* FiberHandle.make();
    let caller: AgentKeyInfo | undefined;

    const streamEvents = Effect.fnUntraced(function* (who: AgentKeyInfo, from: number) {
      let cursor = from;
      for (;;) {
        const page = yield* api.call(who, "events_wait", { cursor, timeoutSec: 50 });
        for (const event of page.events) yield* send({ t: "event", ...event });
        cursor = page.cursor;
      }
    });

    const onMessage = Effect.fnUntraced(function* (text: string) {
      const decoded = decodeMessage(text);
      if (decoded._tag === "Failure") {
        return yield* send(errorFrame({ code: "invalid", message: "Unknown or malformed message.", fix: "Send {t:auth|snapshot|events}." }));
      }
      const message = decoded.success;
      if (message.t === "auth") {
        const verified = yield* Effect.result(auth.verify(message.key));
        if (verified._tag === "Failure") {
          yield* send(errorFrame(verified.failure));
          return yield* writer.write(new Socket.CloseEvent(CLOSE_UNAUTHORIZED, "unauthorized"));
        }
        caller = verified.success;
        return yield* send({ t: "ready", protocol: ProtocolVersion.make(PROTOCOL_VERSION) });
      }
      const who = caller;
      if (who === undefined) {
        return yield* send(errorFrame({ code: "forbidden", message: "Not authenticated.", fix: "Send {t:auth,key} first." }));
      }
      if (message.t === "snapshot") {
        const status = yield* Effect.result(api.call(who, "fleetd_status", {}));
        if (status._tag === "Failure") return yield* send(errorFrame(status.failure));
        const { machines, projects, attention, cursor } = status.success;
        return yield* send({ t: "snapshot", machines, projects, attention, cursor });
      }
      // A new `events` request replaces the running stream.
      yield* FiberHandle.run(
        stream,
        streamEvents(who, message.cursor).pipe(
          Effect.catchTags({ ToolError: (error) => send(errorFrame(error)) }),
          Effect.ignore,
        ),
      );
    });

    for (;;) {
      const chunks = yield* reader.pull;
      for (const chunk of chunks) yield* onMessage(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
    }
  }, (effect) => Effect.ignore(effect));

  return AppSocket.of({ handle });
});

export const layer = Layer.effect(AppSocket, make);
