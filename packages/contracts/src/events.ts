import { Schema } from "effect";
import { EventSeq, MachineId, ProjectId, ThreadId, Timestamp } from "./ids.ts";

export const HubEventType = Schema.Literals([
  "machine.online",
  "machine.offline",
  "machine.degraded",
  /** T3 no longer has the project: the hub dropped it from its cache, and its open workstreams stop. `data.title`. */
  "project.removed",
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
  /** The human digest is ready; no project content, since every key sees it. Read it with digest_get. `data.at`. */
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
  /** `data.changeId`, `data.repo`, `data.prNumber`. */
  "change.queued",
  /** Its tier's reviews are satisfied for the current patch id. `data.changeId`. */
  "change.ready",
  /** The rebase conflicted; `data.changeId`, `data.paths`. */
  "change.needs_rebase",
  /** `data.changeId`, `data.checks` (failing check names), `data.logUrl`. */
  "change.ci_failed",
  /** `data.changeId`, `data.repo`, `data.prNumber`, `data.mergedSha`. */
  "pr.merged",
  /** `data.repo`, `data.reason`. */
  "train.frozen",
  /** `data.repo`. */
  "train.resumed",
  /** Refused at enqueue; `data.prUrl`, `data.fix`. */
  "change.refused",
  /** Where an intent went; `data.workstreamId` or `data.askId`, `data.template`, `data.reason`, `data.playbook`. */
  "intake.routed",
  /** A research workstream's computed verdict; `data.workstreamId`, `data.outcome`, `data.metricValues`. */
  "research.verdict",
  /** M4: a machine's login hit the same limit on several threads, or its proxy has no account; dispatch there pauses. */
  "usage.breaker",
  /** M4: parked threads were sent "continue" at their reset or on usage_resume; `data.breakerCleared`. */
  "usage.resumed",
  /** M8: the node wrote a secret's sink. `data.askId`, `data.fingerprint`, `data.by` (the human who submitted it). */
  "ask.secret_saved",
  /** M8: the node ran an approved command. `data.askId`, `data.exitCode`, `data.timedOut`, `data.by` (the approver). */
  "gated.ran",
  /** M8: a Web Push went out; no item content. `data.items` (how many it covers, "+N more" folded in), `data.devices`. */
  "push.sent",
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
