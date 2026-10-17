import { Schema } from "effect";
import { HubEvent } from "./events.ts";
import { ProtocolVersion } from "./hello.ts";
import { EventSeq } from "./ids.ts";
import { ErrorCode, FleetStatus } from "./mcp.ts";

// App WebSocket at /app: JSON, one message per frame, discriminated by "t".

export const AppAuth = Schema.Struct({ t: Schema.tag("auth"), key: Schema.NonEmptyString });
export const AppSnapshotRequest = Schema.Struct({ t: Schema.tag("snapshot") });
/** Stream HubEvents after `cursor` as they happen. */
export const AppEventsRequest = Schema.Struct({ t: Schema.tag("events"), cursor: EventSeq });

export const AppClientMessage = Schema.Union([AppAuth, AppSnapshotRequest, AppEventsRequest])
  .pipe(Schema.toTaggedUnion("t"))
  .annotate({ identifier: "AppClientMessage" });
export type AppClientMessage = typeof AppClientMessage.Type;

/** Sent once the key is accepted. */
export const AppReady = Schema.Struct({ t: Schema.tag("ready"), protocol: ProtocolVersion });
/** Answer to `snapshot`: the fleetd_status data. */
export const AppSnapshot = Schema.Struct({ t: Schema.tag("snapshot"), ...FleetStatus.fields });
export const AppEvent = Schema.Struct({ t: Schema.tag("event"), ...HubEvent.fields });
export const AppError = Schema.Struct({
  t: Schema.tag("error"),
  code: ErrorCode,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
});

export const AppServerMessage = Schema.Union([AppReady, AppSnapshot, AppEvent, AppError])
  .pipe(Schema.toTaggedUnion("t"))
  .annotate({ identifier: "AppServerMessage" });
export type AppServerMessage = typeof AppServerMessage.Type;
