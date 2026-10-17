import { Effect, Schema } from "effect";
import type { Role } from "./auth.ts";
import { HubEvent, HubEventType } from "./events.ts";
import { EventSeq, MachineId, ProjectId, ThreadId, Timestamp } from "./ids.ts";
import {
  Ask,
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
import { ActionItem, Effort, Machine, ProjectOutcome, ProjectSummary, RuntimeMode, ThreadSummary } from "./model.ts";
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
export const LeadStartInput = Schema.Struct({ machineId: MachineId, projectId: ProjectId });
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

// decisions_record
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
