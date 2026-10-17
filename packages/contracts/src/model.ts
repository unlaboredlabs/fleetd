import { Schema } from "effect";
import { MachineId, ProjectId, ThreadId, Timestamp } from "./ids.ts";

export const MachineStatus = Schema.Literals(["online", "offline", "degraded"]);
export type MachineStatus = typeof MachineStatus.Type;

export const Machine = Schema.Struct({
  machineId: MachineId,
  name: Schema.String,
  tags: Schema.Array(Schema.String),
  status: MachineStatus,
  lastSeenAt: Timestamp,
  /** Null until the node has reported a reachable T3. */
  t3: Schema.NullOr(Schema.Struct({ version: Schema.String, protocol: Schema.Int })),
  nodeVersion: Schema.String,
  /** Plain language, set while status is "degraded". */
  degradedReason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Machine" });
export type Machine = typeof Machine.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ThreadCounts = Schema.Struct({ running: Count, waiting: Count, idle: Count, failed: Count });
export type ThreadCounts = typeof ThreadCounts.Type;

export const ProjectSummary = Schema.Struct({
  machineId: MachineId,
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  threads: ThreadCounts,
  lastActivityAt: Timestamp,
}).annotate({ identifier: "ProjectSummary" });
export type ProjectSummary = typeof ProjectSummary.Type;

export const ThreadStatus = Schema.Literals(["running", "waiting", "idle", "completed", "failed", "interrupted", "cancelled"]);
export type ThreadStatus = typeof ThreadStatus.Type;

export const ThreadSummary = Schema.Struct({
  machineId: MachineId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  status: ThreadStatus,
  /** First line of the latest visible assistant text. */
  headline: Schema.String.check(Schema.isMaxLength(280)),
  latestMessageTail: Schema.String.check(Schema.isMaxLength(4096)),
  lastError: Schema.optionalKey(Schema.Struct({ class: Schema.String, message: Schema.String })),
  usageLimitResetAt: Schema.optionalKey(Timestamp),
  lastProgressAt: Timestamp,
  model: Schema.optionalKey(Schema.String),
  /** As reported by T3; not narrowed to Effort because T3 may report other levels. */
  effort: Schema.optionalKey(Schema.String),
  stale: Schema.Boolean,
  asOf: Timestamp,
}).annotate({ identifier: "ThreadSummary" });
export type ThreadSummary = typeof ThreadSummary.Type;

/** The one-call project outcome, returned as-is by project_get. M3 adds lead and workstreams. */
export const ProjectOutcome = Schema.Struct({
  project: ProjectSummary,
  /** Newest activity first. */
  threads: Schema.Array(ThreadSummary).check(Schema.isMaxLength(20)),
  stale: Schema.Boolean,
  asOf: Timestamp,
  /** Hint for the next call. */
  next: Schema.optionalKey(Schema.String),
  /** True when `threads` was trimmed to its limit. */
  truncated: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "ProjectOutcome" });
export type ProjectOutcome = typeof ProjectOutcome.Type;

export const ActionItem = Schema.Struct({
  at: Timestamp,
  kind: Schema.Literals(["command", "file_change", "tool_call", "other"]),
  status: Schema.Literals(["completed", "failed", "running"]),
  /** The command, path or tool. */
  summary: Schema.String.check(Schema.isMaxLength(200)),
  outputTail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  /** Only when T3 reports one or the output says "Exit code N"; T3's Claude adapter sets none itself. */
  exitCode: Schema.optionalKey(Schema.Int),
  failed: Schema.Boolean,
}).annotate({ identifier: "ActionItem" });
export type ActionItem = typeof ActionItem.Type;

export const Effort = Schema.Literals(["low", "medium", "high", "max"]);
export type Effort = typeof Effort.Type;

export const RuntimeMode = Schema.Literals(["full-access", "approval-required"]);
export type RuntimeMode = typeof RuntimeMode.Type;
