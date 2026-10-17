import { Schema } from "effect";
import { HubEvent } from "./events.ts";
import { ProtocolVersion } from "./hello.ts";
import { EventSeq } from "./ids.ts";
import { ErrorCode, FleetStatus } from "./mcp.ts";

// App WebSocket at /app: JSON, one message per frame, discriminated by "t".

/** Chosen by the client; echoed on the call's `result` or `error`. */
export const AppCallId = Schema.NonEmptyString.check(Schema.isMaxLength(64)).annotate({ identifier: "AppCallId" });

export const AppAuth = Schema.Struct({ t: Schema.tag("auth"), key: Schema.NonEmptyString });
export const AppSnapshotRequest = Schema.Struct({ t: Schema.tag("snapshot") });
/** Stream HubEvents after `cursor` as they happen. */
export const AppEventsRequest = Schema.Struct({ t: Schema.tag("events"), cursor: EventSeq });
/**
 * Call one MCP tool with the session's key: same tools, grants and limits as /mcp. `input` is the
 * tool's input (see McpTools); answered by a `result` or an `error` carrying the same `id`.
 */
export const AppCall = Schema.Struct({
  t: Schema.tag("call"),
  id: AppCallId,
  tool: Schema.NonEmptyString,
  input: Schema.Unknown,
});

/**
 * M8: redeem a one-time pairing token from `fleetd hub device add` (15 minutes, consumed once) for a new human key,
 * before `auth`. Answered by `device_paired`, or an `error` without an id; then authenticate with the key.
 */
export const AppDevicePair = Schema.Struct({ t: Schema.tag("device_pair"), token: Schema.NonEmptyString.check(Schema.isMaxLength(200)) });

export const AppClientMessage = Schema.Union([AppAuth, AppSnapshotRequest, AppEventsRequest, AppCall, AppDevicePair])
  .pipe(Schema.toTaggedUnion("t"))
  .annotate({ identifier: "AppClientMessage" });
export type AppClientMessage = typeof AppClientMessage.Type;

/** Sent once the key is accepted. */
export const AppReady = Schema.Struct({ t: Schema.tag("ready"), protocol: ProtocolVersion });
/** Answer to `snapshot`: the fleetd_status data. */
export const AppSnapshot = Schema.Struct({ t: Schema.tag("snapshot"), ...FleetStatus.fields });
export const AppEvent = Schema.Struct({ t: Schema.tag("event"), ...HubEvent.fields });
/** A `call` succeeded; `output` is the tool's output. */
export const AppResult = Schema.Struct({ t: Schema.tag("result"), id: AppCallId, output: Schema.Unknown });
export const AppError = Schema.Struct({
  t: Schema.tag("error"),
  /** Present when this answers a `call`. */
  id: Schema.optionalKey(AppCallId),
  code: ErrorCode,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
});

/** The new human key, shown only here; the device stores it. */
export const AppDevicePaired = Schema.Struct({ t: Schema.tag("device_paired"), key: Schema.NonEmptyString, keyId: Schema.NonEmptyString });

export const AppServerMessage = Schema.Union([AppReady, AppSnapshot, AppEvent, AppResult, AppError, AppDevicePaired])
  .pipe(Schema.toTaggedUnion("t"))
  .annotate({ identifier: "AppServerMessage" });
export type AppServerMessage = typeof AppServerMessage.Type;
