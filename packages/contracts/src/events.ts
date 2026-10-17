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
  /** No progress past the stall threshold; the hub interrupts and nudges once. */
  "thread.stalled",
  "wake.fired",
  /** A wake missed while the hub was down, with catchUp "skip". */
  "wake.missed",
  /** A queued write to an offline machine was delivered when it came back. */
  "write.delivered",
  /** A queued write outlived its TTL and was dropped. */
  "write.expired",
  /** A webhook subscription has been failing for over an hour. */
  "webhook.failing",
  "workstream.created",
  /** The brief was frozen; `data.briefHash`. */
  "workstream.running",
  "workstream.state",
  "ask.created",
  /** An ask was answered from the decision log and never reached a batch. */
  "ask.auto",
  "batch.ready",
  "decision.recorded",
  "lead.started",
  "lead.woken",
  /** The human digest; its text is in `data`. */
  "digest.ready",
  /** `data.queuedReason`. */
  "task.queued",
  "task.started",
  "task.completed",
  "task.failed",
  "task.cancelled",
  /** A write task's diff touched files outside its leased areas; `data.paths`. */
  "task.out_of_area",
  /** A lease held for over 4 h; flagged once, never released by the hub. `data.taskId`, `data.area`. */
  "lease.stale",
  /** A claim had a failing check; the workstream stays verifying. `data.claimId`, `data.workstreamId`. */
  "claim.failed",
  "claim.passed",
  /** Every done-when check passed. `data.workstreamId`. */
  "workstream.done",
  /** `data.taskId`, `data.prHeadSha`, `data.blocking`. */
  "review.verdict",
  /** `data.incidentId`, `data.class`. */
  "incident.recorded",
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

export const ThreadEventReason = Schema.Literals(["stalled", "t3", "usage_limit", "interrupted"]);
export type ThreadEventReason = typeof ThreadEventReason.Type;

/** Fields `HubEvent.data` may carry on `thread.*` events, alongside whatever else the hub adds. */
export const ThreadEventData = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  /** The run ended while the hub was down and this event was emitted on its return. */
  late: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(ThreadEventReason),
}).annotate({ identifier: "ThreadEventData" });
export type ThreadEventData = typeof ThreadEventData.Type;
