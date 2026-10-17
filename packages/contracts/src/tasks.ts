import { Schema } from "effect";
import { ProjectRef, ThreadRef, Timestamp } from "./ids.ts";
import { Tier, WorkstreamId } from "./ledger.ts";
import { Effort } from "./model.ts";
import { isHttpUrl } from "./subscriptions.ts";

// M5 objects: fleetd-owned tasks, area leases, slots and the repo policy file.

const text = (max: number) => Schema.NonEmptyString.check(Schema.isMaxLength(max));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** "T" plus a positive integer, unique per hub, e.g. "T7". */
export const TaskId = Schema.String.check(Schema.isPattern(/^T[1-9][0-9]*$/u)).pipe(
  Schema.brand("TaskId"),
  Schema.annotate({ identifier: "TaskId" }),
);
export type TaskId = typeof TaskId.Type;

/** Only write tasks get a worktree and leases. */
export const TaskKind = Schema.Literals(["write", "read", "review"]);
export type TaskKind = typeof TaskKind.Type;

export const TaskState = Schema.Literals(["queued", "running", "idle", "done", "failed", "cancelled"]);
export type TaskState = typeof TaskState.Type;

/** A policy area name such as "docs" or "hub-tasks". */
export const AreaName = Schema.String.check(Schema.isMaxLength(40), Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/u)).pipe(
  Schema.brand("AreaName"),
  Schema.annotate({ identifier: "AreaName", description: "Lowercase slug, [a-z0-9][a-z0-9_-]*, at most 40" }),
);
export type AreaName = typeof AreaName.Type;

/** It also becomes the branch slug, so one line. */
export const TaskTitle = text(80).check(Schema.isPattern(/^[^\r\n]*$/u));
export const TaskPrompt = text(8000);
export const TaskAreas = Schema.Array(AreaName).check(Schema.isMaxLength(20), Schema.isUnique());

/** A write task needs at least one area to lease. */
export const taskAreasRule = Schema.makeFilter(
  (task: { readonly kind: TaskKind; readonly areas: ReadonlyArray<string> }) =>
    task.kind === "write" && task.areas.length === 0
      ? { path: ["areas"], issue: "a write task needs at least one area" }
      : undefined,
);

export const TaskResultStatus = Schema.Literals(["done", "failed", "cancelled"]);
export type TaskResultStatus = typeof TaskResultStatus.Type;

export const TaskResult = Schema.Struct({
  status: TaskResultStatus,
  /** The latest assistant message, trimmed to its last 2000 characters. */
  tail: Schema.String.check(Schema.isMaxLength(2000)),
  branch: Schema.optionalKey(Schema.NonEmptyString),
  prUrl: Schema.optionalKey(Schema.String.check(Schema.makeFilter(isHttpUrl, { expected: "an absolute http:// or https:// URL" }))),
  at: Timestamp,
}).annotate({ identifier: "TaskResult" });
export type TaskResult = typeof TaskResult.Type;

export const Task = Schema.Struct({
  taskId: TaskId,
  projectRef: ProjectRef,
  workstreamId: WorkstreamId,
  title: TaskTitle,
  kind: TaskKind,
  prompt: TaskPrompt,
  areas: TaskAreas,
  model: Schema.NonEmptyString,
  /** Always explicit; resolved at spawn. */
  effort: Effort,
  tier: Schema.optionalKey(Tier),
  estimateMinutes: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The done-when index or ref it works towards. */
  serves: Schema.optionalKey(text(200)),
  state: TaskState,
  /** Why it is queued, e.g. "lease: docs held by T1" or "slots: 40/40 in use". */
  queuedReason: Schema.optionalKey(text(200)),
  threadRef: Schema.optionalKey(ThreadRef),
  /** `fleetd/<taskId>-<slug>`; write tasks only. */
  branch: Schema.optionalKey(Schema.NonEmptyString),
  worktreePath: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\//u))),
  /** 1 for the first launch. */
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  result: Schema.optionalKey(TaskResult),
  createdAt: Timestamp,
  startedAt: Schema.optionalKey(Timestamp),
  endedAt: Schema.optionalKey(Timestamp),
})
  .check(taskAreasRule)
  .annotate({ identifier: "Task" });
export type Task = typeof Task.Type;

/** One writer per area within a project, held from spawn until the task ends. */
export const Lease = Schema.Struct({
  projectRef: ProjectRef,
  area: AreaName,
  taskId: TaskId,
  since: Timestamp,
}).annotate({ identifier: "Lease" });
export type Lease = typeof Lease.Type;

export const SlotState = Schema.Struct({
  /** Global cap on running turns. */
  cap: Count,
  used: Count,
  queued: Count,
  /** Slots of the cap only lead turns may take. */
  reservedBand: Count,
  perProject: Schema.Array(Schema.Struct({ projectRef: ProjectRef, share: Count, used: Count })).check(Schema.isMaxLength(50)),
}).annotate({ identifier: "SlotState" });
export type SlotState = typeof SlotState.Type;

/** Fields `HubEvent.data` carries on `task.*` events. */
export const TaskEventData = Schema.Struct({
  taskId: TaskId,
  workstreamId: Schema.optionalKey(WorkstreamId),
  queuedReason: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  /** task.out_of_area: the first 20 paths outside the leased globs. */
  paths: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(20))),
}).annotate({ identifier: "TaskEventData" });
export type TaskEventData = typeof TaskEventData.Type;

// The repo policy file, as decoded from YAML.

/** Repo-relative. */
export const POLICY_FILE_PATH = ".fleetd/policy.yaml";

/** A repo-relative glob such as "docs/**". */
export const AreaGlob = text(200).check(
  Schema.makeFilter((glob) => !glob.startsWith("/"), { expected: "a repo-relative glob, not an absolute path" }),
);

export const PolicyFile = Schema.Struct({
  // A Record keyed by AreaName would silently drop misnamed areas; checking the names refuses them instead.
  areas: Schema.Record(Schema.String, Schema.Array(AreaGlob).check(Schema.isMinLength(1), Schema.isMaxLength(50))).check(
    Schema.isPropertyNames(AreaName),
  ),
  defaults: Schema.optionalKey(
    Schema.Struct({ model: Schema.optionalKey(Schema.NonEmptyString), effort: Schema.optionalKey(Effort) }),
  ),
}).annotate({ identifier: "PolicyFile" });
export type PolicyFile = typeof PolicyFile.Type;

/** What a project without a policy file gets. */
export const DEFAULT_POLICY: PolicyFile = Schema.decodeUnknownSync(PolicyFile)({ areas: { all: ["**"] } });
