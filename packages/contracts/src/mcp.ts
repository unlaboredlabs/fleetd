import { Effect, Schema } from "effect";
import type { Role } from "./auth.ts";
import { HubEvent, HubEventType } from "./events.ts";
import { EventSeq, MachineId, ProjectId, ProjectRef, ThreadId, Timestamp } from "./ids.ts";
import {
  Ask,
  DecisionSource,
  AskId,
  AskState,
  Batch,
  BatchId,
  Decision,
  DecisionId,
  DecisionKey,
  DecisionScope,
  DecisionValue,
  DecisionWhy,
  IntakeText,
  Lead,
  Workstream,
  WorkstreamId,
  WorkstreamState,
} from "./ledger.ts";
import { Effort } from "./effort.ts";
import { ActionItem, Machine, ProjectOutcome, ProjectSummary, RuntimeMode, ThreadSummary } from "./model.ts";
import { SlotState, Task, TaskId, TaskState } from "./tasks.ts";
import { Claim, Eta, Incident, IncidentClass } from "./verification.ts";
import { Change, ChangeState, GitHubRepo, TrainState } from "./train.ts";
import { Subscription, SubscriptionMachines, SubscriptionTypes, WebhookUrl } from "./subscriptions.ts";
import { Wake, WakeCatchUp, WakeMessage, WakeSchedule, WakeState, WakeTarget } from "./wakes.ts";

/** Fields every tool result carries: a hint for the next call, and whether lists were trimmed to their limits. */
const resultFields = {
  next: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
};

const RequestId = Schema.NonEmptyString;

/** Struct-key int in [min, max], defaulted when the key is absent. */
const intDefault = (min: number, max: number, fallback: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(fallback)),
  );

export const FleetStatus = Schema.Struct({
  machines: Schema.Array(Machine),
  projects: Schema.Array(ProjectSummary).check(Schema.isMaxLength(50)),
  /** Latest failed, waiting and usage-limited events. */
  attention: Schema.Array(HubEvent).check(Schema.isMaxLength(10)),
  cursor: EventSeq,
  /** Absent until the hub runs the slot board (M5). */
  slots: Schema.optionalKey(SlotState),
}).annotate({ identifier: "FleetStatus" });
export type FleetStatus = typeof FleetStatus.Type;

// fleetd_status
export const FleetdStatusInput = Schema.Struct({});
export const FleetdStatusOutput = Schema.Struct({ ...FleetStatus.fields, ...resultFields });

// projects_list
export const ProjectsListInput = Schema.Struct({
  machineId: Schema.optionalKey(MachineId),
  query: Schema.optionalKey(Schema.String),
});
export const ProjectsListOutput = Schema.Struct({ projects: Schema.Array(ProjectSummary), ...resultFields });

// project_get
export const ProjectGetInput = Schema.Struct({ machineId: MachineId, projectId: ProjectId });
export const ProjectGetOutput = ProjectOutcome;

// thread_tail
export const TailKind = Schema.Literals(["message", "action"]);
export const TailMessage = Schema.Struct({
  kind: Schema.tag("message"),
  at: Timestamp,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String.check(Schema.isMaxLength(2000)),
});
export const TailAction = Schema.Struct({ kind: Schema.tag("action"), at: Timestamp, action: ActionItem });
export const TailItem = Schema.Union([TailMessage, TailAction]).pipe(Schema.toTaggedUnion("kind"));
export type TailItem = typeof TailItem.Type;

export const ThreadTailInput = Schema.Struct({
  machineId: MachineId,
  threadId: ThreadId,
  n: intDefault(1, 50, 10),
  kinds: Schema.optionalKey(Schema.Array(TailKind)),
});
export const ThreadTailOutput = Schema.Struct({
  /** Newest first. */
  items: Schema.Array(TailItem).check(Schema.isMaxLength(50)),
  thread: ThreadSummary,
  ...resultFields,
});

// actions_list
export const ActionsListInput = Schema.Struct({
  machineId: MachineId,
  threadId: ThreadId,
  limit: intDefault(1, 50, 50),
  failedOnly: Schema.optionalKey(Schema.Boolean),
});
export const ActionsListOutput = Schema.Struct({
  /** Newest first. */
  actions: Schema.Array(ActionItem).check(Schema.isMaxLength(50)),
  ...resultFields,
});

// events_wait
export const EventsWaitInput = Schema.Struct({
  /** Absent means start at the current end. */
  cursor: Schema.optionalKey(EventSeq),
  types: Schema.optionalKey(Schema.Array(HubEventType)),
  machineId: Schema.optionalKey(MachineId),
  timeoutSec: intDefault(0, 50, 50),
});
export const EventsWaitOutput = Schema.Struct({
  events: Schema.Array(HubEvent).check(Schema.isMaxLength(100)),
  cursor: EventSeq,
  more: Schema.Boolean,
  ...resultFields,
});

// thread_launch
export const ThreadLaunchInput = Schema.Struct({
  machineId: MachineId,
  projectId: ProjectId,
  prompt: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  effort: Effort,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("full-access" as const))),
  title: Schema.optionalKey(Schema.String),
  clientRequestId: RequestId,
});
export const ThreadLaunchOutput = Schema.Struct({ threadId: ThreadId, ...resultFields });

// thread_send
export const ThreadSendInput = Schema.Struct({
  machineId: MachineId,
  threadId: ThreadId,
  message: Schema.NonEmptyString,
  clientRequestId: RequestId,
});
export const ThreadSendOutput = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  /** True when the machine is offline and the message waits in the hub's queue. */
  queued: Schema.Boolean,
  /** When a queued message expires undelivered. */
  queuedUntil: Schema.optionalKey(Timestamp),
  ...resultFields,
});

// thread_interrupt
export const ThreadInterruptInput = Schema.Struct({ machineId: MachineId, threadId: ThreadId, clientRequestId: RequestId });
export const ThreadInterruptOutput = Schema.Struct({ ok: Schema.Literal(true), ...resultFields });

// wake_set
export const WakeSetInput = Schema.Struct({
  target: WakeTarget,
  schedule: WakeSchedule,
  message: WakeMessage,
  once: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  catchUp: WakeCatchUp.pipe(Schema.withDecodingDefaultKey(Effect.succeed("fire_once" as const))),
  clientRequestId: RequestId,
});
export const WakeSetOutput = Schema.Struct({ wakeId: Schema.NonEmptyString, nextRunAt: Timestamp, ...resultFields });

// wake_list
export const WakeListInput = Schema.Struct({
  machineId: Schema.optionalKey(MachineId),
  threadId: Schema.optionalKey(ThreadId),
  state: Schema.optionalKey(WakeState),
});
export const WakeListOutput = Schema.Struct({ wakes: Schema.Array(Wake), ...resultFields });

// wake_cancel
export const WakeCancelInput = Schema.Struct({ wakeId: Schema.NonEmptyString });
export const WakeCancelOutput = Schema.Struct({ ok: Schema.Literal(true), ...resultFields });

// subscription_set
export const SubscriptionSetInput = Schema.Struct({
  url: WebhookUrl,
  types: SubscriptionTypes.pipe(Schema.withDecodingDefaultKey(Effect.succeed("*" as const))),
  machines: SubscriptionMachines.pipe(Schema.withDecodingDefaultKey(Effect.succeed("*" as const))),
  clientRequestId: RequestId,
});
export const SubscriptionSetOutput = Schema.Struct({
  subscriptionId: Schema.NonEmptyString,
  /** The webhook signing secret. Shown only here; store it now. */
  secret: Schema.NonEmptyString,
  ...resultFields,
});

// subscription_list
export const SubscriptionListInput = Schema.Struct({});
export const SubscriptionListOutput = Schema.Struct({ subscriptions: Schema.Array(Subscription), ...resultFields });

// subscription_delete
export const SubscriptionDeleteInput = Schema.Struct({ subscriptionId: Schema.NonEmptyString });
export const SubscriptionDeleteOutput = Schema.Struct({ ok: Schema.Literal(true), ...resultFields });

// lead_start, lead_restart
export const LeadStartInput = Schema.Struct({
  machineId: MachineId,
  projectId: ProjectId,
  /** Saved as the project's lead model and effort for this and later (re)starts; absent keeps the saved or hub default. */
  model: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(Effort),
});
export const LeadStartOutput = Schema.Struct({ ...Lead.fields, ...resultFields });
export const LeadRestartInput = LeadStartInput;
export const LeadRestartOutput = LeadStartOutput;

// intake_submit
export const IntakeSubmitInput = Schema.Struct({
  machineId: MachineId,
  projectId: ProjectId,
  text: IntakeText,
  clientRequestId: RequestId,
});
export const IntakeSubmitOutput = Schema.Struct({ workstreamId: WorkstreamId, ...resultFields });

// workstream_list
export const WorkstreamListInput = Schema.Struct({
  machineId: Schema.optionalKey(MachineId),
  projectId: Schema.optionalKey(ProjectId),
  state: Schema.optionalKey(WorkstreamState),
  limit: intDefault(1, 100, 50),
});
export const WorkstreamListOutput = Schema.Struct({
  /** Newest first. */
  workstreams: Schema.Array(Workstream).check(Schema.isMaxLength(100)),
  ...resultFields,
});

// workstream_get
export const WorkstreamGetInput = Schema.Struct({ workstreamId: WorkstreamId });
export const WorkstreamGetOutput = Schema.Struct({
  workstream: Workstream,
  /** Its open asks. */
  asks: Schema.Array(Ask).check(Schema.isMaxLength(50)),
  /** Active decisions scoped to it. */
  decisions: Schema.Array(Decision).check(Schema.isMaxLength(50)),
  /** Absent without a raw estimate in the brief. */
  eta: Schema.optionalKey(Eta),
  /** Its claims, newest first. */
  claims: Schema.optionalKey(Schema.Array(Claim).check(Schema.isMaxLength(20))),
  ...resultFields,
});

// asks_list
export const AsksListInput = Schema.Struct({
  state: AskState.pipe(Schema.withDecodingDefaultKey(Effect.succeed("open" as const))),
  batchId: Schema.optionalKey(BatchId),
});
export const AsksListOutput = Schema.Struct({
  /** Newest first. */
  batches: Schema.Array(Batch).check(Schema.isMaxLength(20)),
  /** The asks in those batches, by batch then number. */
  asks: Schema.Array(Ask).check(Schema.isMaxLength(100)),
  ...resultFields,
});

// inbox_reply
export const InboxReplyInput = Schema.Struct({
  /** Terse reply such as "1 go 2 nvm 3 recs fine"; a leading "#B<n>" picks the batch. */
  raw: Schema.NonEmptyString.check(Schema.isMaxLength(4000)),
  /** Absent: the latest open batch. */
  batchId: Schema.optionalKey(BatchId),
});
export const InboxReplyApplied = Schema.Struct({
  /** The batch item number; absent for "pref:" and "forget". */
  number: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  askId: Schema.optionalKey(AskId),
  /** answered: a Decision was written. later: moved to the next batch. retired: "forget Dn". pref: "pref:" recorded. */
  outcome: Schema.Literals(["answered", "withdrawn", "later", "retired", "pref"]),
  value: Schema.optionalKey(Schema.String),
  decisionId: Schema.optionalKey(DecisionId),
  /** The written decision's source and by, filled by the hub from the caller (human device or agent key). */
  source: Schema.optionalKey(DecisionSource),
  by: Schema.optionalKey(Schema.String),
});
export const InboxReplyOutput = Schema.Struct({
  /** False: nothing changed; see `hint`. */
  parsed: Schema.Boolean,
  batchId: Schema.optionalKey(BatchId),
  /** E.g. "Logged: 1 → go (D12), 2 → dropped". */
  echo: Schema.optionalKey(Schema.String),
  applied: Schema.Array(InboxReplyApplied),
  /** How to fix an unparseable reply. */
  hint: Schema.optionalKey(Schema.String),
  ...resultFields,
});

// decisions_search
export const DecisionsSearchInput = Schema.Struct({
  query: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  /** Absent: every scope. */
  scope: Schema.optionalKey(DecisionScope),
  limit: intDefault(1, 50, 10),
});
export const DecisionsSearchOutput = Schema.Struct({
  /** Best match first; active decisions only. */
  decisions: Schema.Array(Decision).check(Schema.isMaxLength(50)),
  ...resultFields,
});

// decisions_record: the hub fills the decision's source and by from the caller (human device or agent key).
export const DecisionsRecordInput = Schema.Struct({
  key: DecisionKey,
  value: DecisionValue,
  why: Schema.optionalKey(DecisionWhy),
  scope: DecisionScope,
});
export const DecisionsRecordOutput = Schema.Struct({ decision: Decision, ...resultFields });

// digest_get
export const DigestGetInput = Schema.Struct({});
export const DigestGetOutput = Schema.Struct({ text: Schema.String, at: Timestamp, ...resultFields });

// tasks_list
export const TasksListInput = Schema.Struct({
  projectRef: Schema.optionalKey(ProjectRef),
  state: Schema.optionalKey(TaskState),
  limit: intDefault(1, 100, 50),
});
export const TasksListOutput = Schema.Struct({
  /** Newest first. */
  tasks: Schema.Array(Task).check(Schema.isMaxLength(100)),
  ...resultFields,
});

// task_get
export const TaskGetInput = Schema.Struct({ taskId: TaskId });
export const TaskGetOutput = Schema.Struct({ task: Task, ...resultFields });

// cap_set: the global cap, a project's share, or both.
export const CapSetInput = Schema.Struct({
  cap: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  share: Schema.optionalKey(
    Schema.Struct({ projectRef: ProjectRef, share: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })) }),
  ),
}).check(
  Schema.makeFilter((input) => input.cap !== undefined || input.share !== undefined, { expected: "cap, share or both" }),
);
export const CapSetOutput = Schema.Struct({ slots: SlotState, ...resultFields });

// claims_list
export const ClaimsListInput = Schema.Struct({
  workstreamId: Schema.optionalKey(WorkstreamId),
  projectRef: Schema.optionalKey(ProjectRef),
  outcome: Schema.optionalKey(Schema.Literals(["pass", "fail"])),
  limit: intDefault(1, 100, 20),
});
export const ClaimsListOutput = Schema.Struct({
  /** Newest first. */
  claims: Schema.Array(Claim).check(Schema.isMaxLength(100)),
  ...resultFields,
});

// incidents_list
export const IncidentsListInput = Schema.Struct({
  projectRef: Schema.optionalKey(ProjectRef),
  workstreamId: Schema.optionalKey(WorkstreamId),
  class: Schema.optionalKey(IncidentClass),
  limit: intDefault(1, 100, 20),
});
export const IncidentsListOutput = Schema.Struct({
  /** Newest first. */
  incidents: Schema.Array(Incident).check(Schema.isMaxLength(100)),
  ...resultFields,
});

// changes_list
export const ChangesListInput = Schema.Struct({
  projectRef: Schema.optionalKey(ProjectRef),
  repo: Schema.optionalKey(GitHubRepo),
  state: Schema.optionalKey(ChangeState),
  limit: intDefault(1, 100, 50),
});
export const ChangesListOutput = Schema.Struct({
  /** Newest first. */
  changes: Schema.Array(Change).check(Schema.isMaxLength(100)),
  ...resultFields,
});

// train_get
export const TrainGetInput = Schema.Struct({ repo: GitHubRepo });
export const TrainGetOutput = Schema.Struct({ train: TrainState, ...resultFields });

// train_freeze: records or retires the repo's `policy.freeze.<repo>` decision.
export const TrainFreezeInput = Schema.Struct({
  repo: GitHubRepo,
  frozen: Schema.Boolean,
  reason: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(200))),
});
export const TrainFreezeOutput = Schema.Struct({ train: TrainState, ...resultFields });

/** The static MCP tool list. Keys are the tool names; `scope` is the minimum grant role. */
export const McpTools = {
  fleetd_status: { scope: "read", input: FleetdStatusInput, output: FleetdStatusOutput },
  projects_list: { scope: "read", input: ProjectsListInput, output: ProjectsListOutput },
  project_get: { scope: "read", input: ProjectGetInput, output: ProjectGetOutput },
  thread_tail: { scope: "read", input: ThreadTailInput, output: ThreadTailOutput },
  actions_list: { scope: "read", input: ActionsListInput, output: ActionsListOutput },
  events_wait: { scope: "read", input: EventsWaitInput, output: EventsWaitOutput },
  thread_launch: { scope: "operate", input: ThreadLaunchInput, output: ThreadLaunchOutput },
  thread_send: { scope: "operate", input: ThreadSendInput, output: ThreadSendOutput },
  thread_interrupt: { scope: "operate", input: ThreadInterruptInput, output: ThreadInterruptOutput },
  wake_set: { scope: "operate", input: WakeSetInput, output: WakeSetOutput },
  wake_list: { scope: "read", input: WakeListInput, output: WakeListOutput },
  wake_cancel: { scope: "operate", input: WakeCancelInput, output: WakeCancelOutput },
  subscription_set: { scope: "operate", input: SubscriptionSetInput, output: SubscriptionSetOutput },
  subscription_list: { scope: "read", input: SubscriptionListInput, output: SubscriptionListOutput },
  subscription_delete: { scope: "operate", input: SubscriptionDeleteInput, output: SubscriptionDeleteOutput },
  lead_start: { scope: "operate", input: LeadStartInput, output: LeadStartOutput },
  lead_restart: { scope: "operate", input: LeadRestartInput, output: LeadRestartOutput },
  intake_submit: { scope: "operate", input: IntakeSubmitInput, output: IntakeSubmitOutput },
  workstream_list: { scope: "read", input: WorkstreamListInput, output: WorkstreamListOutput },
  workstream_get: { scope: "read", input: WorkstreamGetInput, output: WorkstreamGetOutput },
  asks_list: { scope: "read", input: AsksListInput, output: AsksListOutput },
  inbox_reply: { scope: "operate", input: InboxReplyInput, output: InboxReplyOutput },
  decisions_search: { scope: "read", input: DecisionsSearchInput, output: DecisionsSearchOutput },
  decisions_record: { scope: "operate", input: DecisionsRecordInput, output: DecisionsRecordOutput },
  digest_get: { scope: "read", input: DigestGetInput, output: DigestGetOutput },
  tasks_list: { scope: "read", input: TasksListInput, output: TasksListOutput },
  task_get: { scope: "read", input: TaskGetInput, output: TaskGetOutput },
  cap_set: { scope: "admin", input: CapSetInput, output: CapSetOutput },
  claims_list: { scope: "read", input: ClaimsListInput, output: ClaimsListOutput },
  incidents_list: { scope: "read", input: IncidentsListInput, output: IncidentsListOutput },
  changes_list: { scope: "read", input: ChangesListInput, output: ChangesListOutput },
  train_get: { scope: "read", input: TrainGetInput, output: TrainGetOutput },
  train_freeze: { scope: "operate", input: TrainFreezeInput, output: TrainFreezeOutput },
} as const satisfies Record<string, { scope: Role; input: Schema.Top; output: Schema.Top }>;
export type McpToolName = keyof typeof McpTools;

export const ErrorCode = Schema.Literals(["machine_offline", "not_found", "forbidden", "invalid", "t3_error"]);
export type ErrorCode = typeof ErrorCode.Type;

/** Sent as an MCP tool error result whose text is this JSON. */
export const McpToolError = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
  /** What to do next. */
  fix: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "McpToolError" });
export type McpToolError = typeof McpToolError.Type;
