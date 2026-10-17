import {
  AppClientMessage,
  McpTools,
  PROTOCOL_VERSION,
  ProtocolVersion,
  type AgentKeyInfo,
  type AppServerMessage,
  type McpToolError,
} from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as FleetApi from "./FleetApi.ts";
import * as Auth from "../auth/Auth.ts";

/** Close code for a connection whose key was refused. */
export const CLOSE_UNAUTHORIZED = 4401;

/** Calls one connection may have running at once; more are refused rather than queued without bound. */
export const MAX_CALLS_IN_FLIGHT = 32;

/**
 * The app WebSocket at /app: `device_pair` to redeem a pairing link for a human key, `auth` with a key, then
 * `snapshot` for the fleetd_status data,
 * `events` to stream HubEvents after a cursor as they happen, and `call` to run any MCP tool.
 */
export class AppSocket extends Context.Service<
  AppSocket,
  { readonly handle: (socket: Socket.Socket) => Effect.Effect<void, never, Scope.Scope> }
>()("fleetd/hub/api/AppSocket") {}

const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(AppClientMessage));
const textDecoder = new TextDecoder();

const errorFrame = (error: McpToolError, id?: string): AppServerMessage => ({
  t: "error",
  ...(id === undefined ? {} : { id }),
  code: error.code,
  message: error.message,
  ...(error.fix === undefined ? {} : { fix: error.fix }),
});

const isImplemented = (tool: string): tool is FleetApi.ImplementedTool =>
  (FleetApi.IMPLEMENTED_TOOLS as ReadonlyArray<string>).includes(tool);

const make = Effect.gen(function* () {
  const auth = yield* Auth.Auth;
  const api = yield* FleetApi.FleetApi;

  /**
   * One tool call, checked like an MCP request: the key is verified again (so a revoked key stops at its
   * next call), the input is decoded against the tool's schema, and FleetApi applies grants and limits.
   */
  const call = Effect.fnUntraced(function* (key: string, tool: string, input: unknown) {
    const info = yield* auth.verify(key);
    if (!isImplemented(tool)) {
      return yield* Effect.fail<McpToolError>({ code: "not_found", message: `No tool ${tool}.`, fix: "Use a tool name from the hub's MCP tool list." });
    }
    const decoded = yield* Effect.result(Schema.decodeUnknownEffect(McpTools[tool].input as Schema.Codec<FleetApi.ToolInput<typeof tool>, unknown>)(input));
    if (decoded._tag === "Failure") {
      return yield* Effect.fail<McpToolError>({
        code: "invalid",
        message: `Invalid ${tool} input: ${decoded.failure.message}`.slice(0, 1000),
        fix: "Check the input against the tool's input schema.",
      });
    }
    return yield* api.call(info, tool, decoded.success) as Effect.Effect<unknown, McpToolError>;
  });

  const handle = Effect.fnUntraced(function* (socket: Socket.Socket) {
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const send = (message: AppServerMessage) => writer.write(JSON.stringify(message));
    const stream = yield* FiberHandle.make();
    const calls = yield* FiberSet.make();
    let caller: { readonly key: string; readonly info: AgentKeyInfo } | undefined;

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
      // Before auth only: a pairing link from `fleetd hub device add` becomes this device's human key. A refused link
      // leaves the socket open, so the page can say why.
      if (message.t === "device_pair") {
        if (caller !== undefined) {
          return yield* send(errorFrame({ code: "invalid", message: "This connection is already authenticated.", fix: "Pair from a fresh connection." }));
        }
        const paired = yield* Effect.result(auth.consumePairToken(message.token));
        if (paired._tag === "Failure") return yield* send(errorFrame(paired.failure));
        yield* Effect.logInfo("device paired").pipe(Effect.annotateLogs({ keyId: paired.success.info.keyId, name: paired.success.info.name }));
        return yield* send({ t: "device_paired", key: paired.success.key, keyId: paired.success.info.keyId });
      }
      if (message.t === "auth") {
        const verified = yield* Effect.result(auth.verify(message.key));
        if (verified._tag === "Failure") {
          yield* send(errorFrame(verified.failure));
          return yield* writer.write(new Socket.CloseEvent(CLOSE_UNAUTHORIZED, "unauthorized"));
        }
        caller = { key: message.key, info: verified.success };
        return yield* send({ t: "ready", protocol: ProtocolVersion.make(PROTOCOL_VERSION) });
      }
      const who = caller;
      if (who === undefined) {
        const notAuthed: McpToolError = { code: "forbidden", message: "Not authenticated.", fix: "Send {t:auth,key} first." };
        return yield* send(errorFrame(notAuthed, message.t === "call" ? message.id : undefined));
      }
      if (message.t === "call") {
        if ((yield* FiberSet.size(calls)) >= MAX_CALLS_IN_FLIGHT) {
          return yield* send(
            errorFrame({ code: "invalid", message: `Over ${MAX_CALLS_IN_FLIGHT} calls in flight.`, fix: "Wait for a result before sending more calls." }, message.id),
          );
        }
        yield* FiberSet.run(
          calls,
          call(who.key, message.tool, message.input).pipe(
            Effect.matchEffect({
              onFailure: (error) => send(errorFrame(error, message.id)),
              onSuccess: (output) => send({ t: "result", id: message.id, output }),
            }),
            Effect.ignore,
          ),
        );
        return;
      }
      if (message.t === "snapshot") {
        const status = yield* Effect.result(api.call(who.info, "fleetd_status", {}));
        if (status._tag === "Failure") return yield* send(errorFrame(status.failure));
        const { machines, projects, attention, cursor } = status.success;
        return yield* send({ t: "snapshot", machines, projects, attention, cursor });
      }
      // A new `events` request replaces the running stream.
      yield* FiberHandle.run(
        stream,
        streamEvents(who.info, message.cursor).pipe(
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
