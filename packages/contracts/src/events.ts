import { Schema } from "effect";
import { EventSeq, MachineId, ProjectId, ThreadId, Timestamp } from "./ids.ts";

export const HubEventType = Schema.Literals([
  "machine.online",
  "machine.offline",
  "machine.degraded",
  "thread.started",
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
  /** Needs approval or user input. */
  "thread.waiting",
  "thread.usage_limited",
]).annotate({ identifier: "HubEventType" });
export type HubEventType = typeof HubEventType.Type;

export const HubEvent = Schema.Struct({
  /** Hub-global and monotonic. */
  seq: EventSeq,
  at: Timestamp,
  type: HubEventType,
  machineId: Schema.optionalKey(MachineId),
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
  /** Plain language. */
  summary: Schema.String.check(Schema.isMaxLength(200)),
  /** At most 2 KB of JSON; the hub trims before emitting. */
  data: Schema.optionalKey(Schema.Unknown),
}).annotate({ identifier: "HubEvent" });
export type HubEvent = typeof HubEvent.Type;
