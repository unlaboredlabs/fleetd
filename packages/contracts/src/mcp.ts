import { Effect, Schema } from "effect";
import type { Role } from "./auth.ts";
import { HubEvent, HubEventType } from "./events.ts";
import { EventSeq, MachineId, ProjectId, ThreadId, Timestamp } from "./ids.ts";
import { ActionItem, Effort, Machine, ProjectOutcome, ProjectSummary, RuntimeMode, ThreadSummary } from "./model.ts";

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
export const ProjectGetOutput = Schema.Struct({ ...ProjectOutcome.fields, ...resultFields });

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
  queued: Schema.Boolean,
  ...resultFields,
});

// thread_interrupt
export const ThreadInterruptInput = Schema.Struct({ machineId: MachineId, threadId: ThreadId, clientRequestId: RequestId });
export const ThreadInterruptOutput = Schema.Struct({ ok: Schema.Literal(true), ...resultFields });

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
