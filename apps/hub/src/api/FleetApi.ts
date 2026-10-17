import {
  ErrorCode,
  McpTools,
  type AgentKeyInfo,
  type Ask,
  type Batch,
  type Claim,
  type Decision,
  type DecisionKey,
  type DecisionScope,
  type HubEvent,
  type HubEventType,
  type Machine,
  type MachineId,
  type McpToolName,
  type ProjectRef,
  type Role,
  type ThreadRef,
  type ThreadSummary,
} from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Approvals } from "../approvals/Approvals.ts";
import * as Auth from "../auth/Auth.ts";
import * as ClaimRecords from "../checks/ClaimRecords.ts";
import * as Estimates from "../estimates/Estimates.ts";
import * as Incidents from "../incidents/Incidents.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Executors from "../executor/Executors.ts";
import * as Webhooks from "../webhooks/Webhooks.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as Wakes from "../wakes/Wakes.ts";
import * as HumanDigests from "../digests/HumanDigests.ts";
import { Intake } from "../intake/Intake.ts";
import * as Leads from "../leads/Leads.ts";
import * as Workstreams from "../leads/Workstreams.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { Inbox } from "../ledger/Inbox.ts";
import { FinishAll } from "../playbooks/FinishAll.ts";
import * as Slots from "../slots/Slots.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import * as Tasks from "../tasks/Tasks.ts";
import * as Usage from "../usage/Usage.ts";
import { UsageSource } from "../usage/UsageSource.ts";
import { ChangeRecords } from "../train/ChangeRecords.ts";
import { freezeKey } from "../train/rules.ts";
import { Train } from "../train/Train.ts";
import { Doctor } from "../doctor/Doctor.ts";

/** A tool failure in the spec's `{ code, message, fix }` shape. Every one says what to do next. */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  code: ErrorCode,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
}) {}

export type ToolInput<N extends McpToolName> = (typeof McpTools)[N]["input"]["Type"];
export type ToolOutput<N extends McpToolName> = (typeof McpTools)[N]["output"]["Type"];

/** Tools the hub serves today. A tool in the contracts table is listed here once its handler exists. */
export const IMPLEMENTED_TOOLS = [
  "fleetd_status",
  "projects_list",
  "project_get",
  "thread_tail",
  "actions_list",
  "events_wait",
  "thread_launch",
  "thread_send",
  "thread_interrupt",
  "subscription_set",
  "subscription_list",
  "subscription_delete",
  "wake_set",
  "wake_list",
  "wake_cancel",
  "lead_start",
  "lead_restart",
  "intake_submit",
  "workstream_list",
  "workstream_get",
  "workstream_spawn",
  "inventory",
  "asks_list",
  "inbox_reply",
  "secret_submit",
  "decisions_search",
  "decisions_record",
  "digest_get",
  "tasks_list",
  "task_get",
  "cap_set",
  "usage_status",
  "usage_resume",
  "claims_list",
  "incidents_list",
  "changes_list",
  "train_get",
  "train_freeze",
  "doctor_list",
  "doctor_fix",
] as const satisfies ReadonlyArray<McpToolName>;
export type ImplementedTool = (typeof IMPLEMENTED_TOOLS)[number];

export const LIMITS = {
  projects: 50,
  attention: 10,
  outcomeThreads: 20,
  outcomeWorkstreams: 20,
  tailText: 2000,
  wakes: 200,
  workstreamAsks: 50,
  batches: 20,
  asks: 100,
  outcomeTasks: 20,
  /** Threads read to fill `outcomeThreads` once task threads are left out. */
  outcomeThreadScan: 200,
  workstreamClaims: 20,
  trains: 10,
} as const;
const ATTENTION_TYPES: ReadonlyArray<HubEventType> = [
  "thread.failed",
  "thread.waiting",
  "thread.usage_limited",
  "usage.breaker",
  // The train sent these back to their authors; they need a look if an author is gone.
  "change.needs_rebase",
  "change.ci_failed",
];
/** How far back fleetd_status looks for attention events. */
const ATTENTION_LOOKBACK = 1000;

/**
 * Everything the central MCP and the app WebSocket can ask of the hub, one method per MCP tool.
 * `call` checks the tool's role; each handler checks the per-machine grant and trims to the limits.
 */
export class FleetApi extends Context.Service<
  FleetApi,
  {
    readonly call: <N extends ImplementedTool>(
      caller: AgentKeyInfo,
      tool: N,
      input: ToolInput<N>,
    ) => Effect.Effect<ToolOutput<N>, ToolError>;
  }
>()("fleetd/hub/api/FleetApi") {}

const cap = <A>(items: ReadonlyArray<A>, max: number) =>
  items.length > max ? { items: items.slice(0, max), truncated: true as const } : { items, truncated: undefined };
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const withTruncated = (truncated: boolean | undefined) => (truncated === true ? { truncated } : {});

const forbidden = (role: Role, machineId?: MachineId) =>
  new ToolError({
    code: "forbidden",
    message: machineId === undefined ? `This key lacks the ${role} role.` : `This key has no ${role} grant on machine ${machineId}.`,
    fix: "Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …).",
  });
const offline = (machineId: MachineId) =>
  new ToolError({
    code: "machine_offline",
    message: `Machine ${machineId} is offline.`,
    fix: `Start the node on ${machineId} or check its network, then retry.`,
  });
const unknownMachine = (machineId: MachineId) =>
  new ToolError({ code: "not_found", message: `No machine ${machineId}.`, fix: "Call fleetd_status to list machines." });
const unknownProject = (ref: ProjectRef) =>
  new ToolError({
    code: "not_found",
    message: `No project ${ref.projectId} on ${ref.machineId}.`,
    fix: `Call projects_list with machineId ${ref.machineId}.`,
  });
const unknownThread = (ref: ThreadRef) =>
  new ToolError({
    code: "not_found",
    message: `No thread ${ref.threadId} on ${ref.machineId}.`,
    fix: "Call project_get to list the project's threads.",
  });

const internalError = new ToolError({
  code: "t3_error",
  message: "The hub failed to answer that request.",
  fix: "Retry; if it keeps failing, check the hub log.",
});

const fromExecutor = (error: Executors.ExecutorError): ToolError => {
  switch (error._tag) {
    case "MachineNotConnected":
      return offline(error.machineId as MachineId);
    case "ThreadNotFound":
      return unknownThread({ machineId: error.machineId, threadId: error.threadId } as ThreadRef);
    case "T3RequestFailed":
      return new ToolError({ code: "t3_error", message: error.message, fix: "Retry; if it keeps failing, check the machine with fleetd_status." });
  }
};

/** Leads and the ledger refuse in the same `{ code, message, fix }` shape. */
const refusal = (error: { readonly code: ToolError["code"]; readonly message: string; readonly fix?: string }) =>
  new ToolError({ code: error.code, message: error.message, ...(error.fix === undefined ? {} : { fix: error.fix }) });

const unknownTask = (taskId: string): ToolError =>
  new ToolError({ code: "not_found", message: `No task ${taskId}.`, fix: "Call tasks_list to see tasks." });

const unknownTrain = (repo: string): ToolError =>
  new ToolError({
    code: "not_found",
    message: `No merge train for ${repo}; a repo gets one when its first PR is enqueued.`,
    fix: `To hold it before then, record the decision ${freezeKey(repo)} = true with decisions_record at its project's scope.`,
  });

const unknownWorkstream = (workstreamId: string): ToolError =>
  new ToolError({ code: "not_found", message: `No workstream ${workstreamId}.`, fix: "Call workstream_list to see workstreams." });

const make = Effect.gen(function* () {
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const auth = yield* Auth.Auth;
  const executors = yield* Executors.Executors;
  const webhooks = yield* Webhooks.Webhooks;
  const writes = yield* WriteQueue.WriteQueue;
  const wakes = yield* Wakes.Wakes;
  const leads = yield* Leads.Leads;
  const workstreams = yield* Workstreams.Workstreams;
  const intake = yield* Intake;
  const asks = yield* Asks;
  const decisions = yield* Decisions;
  const inbox = yield* Inbox;
  const digests = yield* HumanDigests.HumanDigests;
  const tasks = yield* Tasks.Tasks;
  const taskRecords = yield* TaskRecords.TaskRecords;
  const slots = yield* Slots.Slots;
  const claims = yield* ClaimRecords.ClaimRecords;
  const estimates = yield* Estimates.Estimates;
  const incidents = yield* Incidents.Incidents;
  const usage = yield* Usage.Usage;
  const usageSource = yield* UsageSource;
  const train = yield* Train;
  const changeRecords = yield* ChangeRecords;
  const approvals = yield* Approvals;
  const finishAll = yield* FinishAll;
  const doctor = yield* Doctor;

  const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

  const require = (caller: AgentKeyInfo, role: Role, machineId?: MachineId) =>
    auth.allows(caller, role, machineId) ? Effect.void : Effect.fail(forbidden(role, machineId));

  const canRead = (caller: AgentKeyInfo) => (event: HubEvent) =>
    event.machineId === undefined || auth.allows(caller, "read", event.machineId);

  /** A grant over every machine, as global decisions need: they apply to all of them. */
  const allowsEverywhere = (caller: AgentKeyInfo, role: Role) =>
    caller.grants.some((grant) => grant.machines === "*" && auth.allows({ ...caller, grants: [grant] }, role));

  /** Who a decision written with this key comes from: the human for a human key (a person's device), else the agent. */
  const actorOf = (caller: AgentKeyInfo) =>
    caller.kind === "human" ? { source: "human" as const, by: `human:${caller.name}` } : { source: "agent" as const, by: caller.name };

  /** The project a decision scope belongs to: undefined for global, a not_found for an unknown workstream. */
  const decisionProject = Effect.fnUntraced(function* (scope: DecisionScope) {
    if (scope.kind === "global") return undefined;
    if (scope.kind === "project") return scope.projectRef;
    const workstream = yield* workstreams.get(scope.workstreamId);
    if (workstream === undefined) return yield* unknownWorkstream(scope.workstreamId);
    return workstream.projectRef;
  });

  /** lead_start and lead_restart save a given model or effort as the project's lead settings first. */
  const configureLead = Effect.fnUntraced(function* (input: ToolInput<"lead_start">) {
    if (input.model === undefined && input.effort === undefined) return;
    const ref = { machineId: input.machineId, projectId: input.projectId };
    if ((yield* store.projects.get(ref)) === undefined) return yield* unknownProject(ref);
    yield* leads.configure(ref, {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    });
  });

  const canReadDecision = (caller: AgentKeyInfo, decision: Decision) =>
    decisionProject(decision.scope).pipe(
      Effect.map((ref) => ref === undefined || auth.allows(caller, "read", ref.machineId)),
      Effect.orElseSucceed(() => false),
    );

  /** A machine's cache is fresh only while its node is online and its executor holds a T3 connection. */
  const freshness = Effect.fnUntraced(function* (machineId: MachineId) {
    const machine = yield* store.machines.get(machineId);
    if (machine === undefined) return yield* unknownMachine(machineId);
    const live = machine.status === "online" && (yield* executors.isConnected(machineId));
    return live ? { machine, stale: false, asOf: yield* now } : { machine, stale: true, asOf: machine.lastSeenAt };
  });

  const markStale = (thread: ThreadSummary, fresh: { stale: boolean; asOf: string }): ThreadSummary =>
    fresh.stale ? { ...thread, stale: true, asOf: fresh.asOf } : thread;

  const requireConnected = Effect.fnUntraced(function* (machineId: MachineId) {
    if (!(yield* executors.isConnected(machineId))) return yield* offline(machineId);
  });

  /** A write that may wait in the queue needs a target the hub has seen, since T3 can't vouch for it offline. */
  const requireKnownThread = Effect.fnUntraced(function* (ref: ThreadRef) {
    if ((yield* store.machines.get(ref.machineId)) === undefined) return yield* unknownMachine(ref.machineId);
    if ((yield* store.threads.get(ref)) === undefined && !(yield* executors.isConnected(ref.machineId))) {
      return yield* unknownThread(ref);
    }
  });

  const unknownWake = (wakeId: string) =>
    new ToolError({ code: "not_found", message: `No wake ${wakeId}.`, fix: "Call wake_list to see wakes." });

  /** The latest attention events the caller may see, oldest first, scanned forward from a bounded lookback. */
  const attention = Effect.fnUntraced(function* (caller: AgentKeyInfo, head: number) {
    let cursor = Math.max(0, head - ATTENTION_LOOKBACK);
    let latest: Array<HubEvent> = [];
    for (;;) {
      const page = yield* events.wait({ cursor, types: ATTENTION_TYPES, timeoutSec: 0 });
      latest = [...latest, ...page.events.filter(canRead(caller))].slice(-LIMITS.attention);
      if (!page.more || page.cursor <= cursor) return latest;
      cursor = page.cursor;
    }
  });

  const handlers: { readonly [N in ImplementedTool]: (caller: AgentKeyInfo, input: ToolInput<N>) => Effect.Effect<ToolOutput<N>, ToolError> } = {
    fleetd_status: Effect.fnUntraced(function* (caller) {
      const cursor = yield* events.head();
      const machines = (yield* store.machines.list()).filter((m: Machine) => auth.allows(caller, "read", m.machineId));
      const projects = (yield* store.projects.list())
        .filter((p) => auth.allows(caller, "read", p.machineId))
        .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      const shown = cap(projects, LIMITS.projects);
      const board = yield* slots.state();
      return {
        machines,
        projects: shown.items,
        attention: yield* attention(caller, cursor),
        cursor,
        slots: { ...board, perProject: board.perProject.filter((p) => auth.allows(caller, "read", p.projectRef.machineId)) },
        ...withTruncated(shown.truncated),
        next: `Call events_wait with cursor ${cursor} to wait for changes, or project_get for one project's outcome.`,
      };
    }),

    projects_list: Effect.fnUntraced(function* (caller, input) {
      if (input.machineId !== undefined) yield* require(caller, "read", input.machineId);
      const projects = (yield* store.projects.list(input)).filter((p) => auth.allows(caller, "read", p.machineId));
      const shown = cap(projects, LIMITS.projects);
      return {
        projects: shown.items,
        ...withTruncated(shown.truncated),
        ...(shown.truncated ? { next: "Narrow the list with machineId or query." } : {}),
      };
    }),

    project_get: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "read", input.machineId);
      const fresh = yield* freshness(input.machineId);
      const project = yield* store.projects.get(input);
      if (project === undefined) return yield* unknownProject(input);
      // Task threads show only as tasks, never in the thread list.
      const taskThreads = yield* taskRecords.threadIds(input);
      const ownThreads = (yield* store.threads.listByProject(input, LIMITS.outcomeThreadScan)).filter((t) => !taskThreads.has(t.threadId));
      const threads = cap(ownThreads, LIMITS.outcomeThreads);
      const lead = yield* leads.get(input);
      const open = cap(yield* workstreams.list({ ref: input, open: true, limit: LIMITS.outcomeWorkstreams + 1 }), LIMITS.outcomeWorkstreams);
      const recent = cap(yield* tasks.list({ ref: input, limit: LIMITS.outcomeTasks + 1 }), LIMITS.outcomeTasks);
      const ownTrains = (yield* changeRecords.trains()).filter((t) => t.projectRef.machineId === input.machineId && t.projectRef.projectId === input.projectId);
      const trains = yield* Effect.forEach(ownTrains.slice(0, LIMITS.trains), (t) => train.state(t.repo));
      return {
        project,
        threads: threads.items.map((t) => markStale(t, fresh)),
        ...(lead === undefined ? {} : { lead }),
        ...(open.items.length === 0 ? {} : { workstreams: open.items }),
        ...(recent.items.length === 0 ? {} : { taskCounts: yield* taskRecords.counts(input), tasks: recent.items }),
        ...(trains.length === 0 ? {} : { trains }),
        stale: fresh.stale,
        asOf: fresh.asOf,
        ...withTruncated(threads.truncated ?? open.truncated ?? recent.truncated ?? (ownTrains.length > LIMITS.trains ? true : undefined)),
        next: fresh.stale
          ? `Cached as of ${fresh.asOf}: ${input.machineId} is offline.`
          : "Call thread_tail for a thread's latest messages and actions.",
      };
    }),

    thread_tail: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "read", input.machineId);
      const fresh = yield* freshness(input.machineId);
      if (fresh.stale) {
        // The hub caches shell rows only, so offline the tail is the cached latest message.
        const thread = yield* store.threads.get(input);
        if (thread === undefined) return yield* unknownThread(input);
        const wantsMessages = input.kinds === undefined || input.kinds.includes("message");
        return {
          items:
            wantsMessages && thread.latestMessageTail.length > 0
              ? [{ kind: "message" as const, at: thread.lastProgressAt, role: "assistant" as const, text: clip(thread.latestMessageTail, LIMITS.tailText) }]
              : [],
          thread: markStale(Struct.omit(thread, ["lastSequence"]), fresh),
          next: `Cached as of ${fresh.asOf}: ${input.machineId} is offline, so only the latest message is available.`,
        };
      }
      const tail = yield* executors.tail(input, input.n, input.kinds).pipe(Effect.mapError(fromExecutor));
      const items = cap(tail.items, input.n);
      return {
        ...tail,
        items: items.items.map((item) => (item.kind === "message" ? { ...item, text: clip(item.text, LIMITS.tailText) } : item)),
        ...withTruncated(items.truncated ?? tail.truncated),
      };
    }),

    actions_list: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "read", input.machineId);
      const fresh = yield* freshness(input.machineId);
      if (fresh.stale) return yield* offline(input.machineId);
      const actions = yield* executors
        .actions(input, input.limit, input.failedOnly)
        .pipe(Effect.mapError(fromExecutor));
      const shown = cap(actions, input.limit);
      return { actions: shown.items, ...withTruncated(shown.truncated) };
    }),

    events_wait: Effect.fnUntraced(function* (caller, input) {
      if (input.machineId !== undefined) yield* require(caller, "read", input.machineId);
      let cursor = input.cursor ?? (yield* events.head());
      const deadline = (yield* Clock.currentTimeMillis) + input.timeoutSec * 1000;
      for (;;) {
        const remaining = Math.max(0, Math.ceil((deadline - (yield* Clock.currentTimeMillis)) / 1000));
        const page = yield* events.wait({
          cursor,
          timeoutSec: remaining,
          ...(input.types === undefined ? {} : { types: input.types }),
          ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
        });
        cursor = Math.max(cursor, page.cursor);
        const visible = page.events.filter(canRead(caller));
        // Keep waiting through events on machines this key can't see, until the deadline.
        if (visible.length > 0 || page.events.length === 0 || (remaining === 0 && !page.more)) {
          return {
            events: visible,
            cursor,
            more: page.more,
            next: page.more ? `More events are ready: call events_wait with cursor ${cursor} now.` : `Call events_wait with cursor ${cursor} to keep waiting.`,
          };
        }
      }
    }),

    thread_launch: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      yield* requireConnected(input.machineId);
      if ((yield* store.projects.get(input)) === undefined) return yield* unknownProject(input);
      // M4 usage: no new turn goes into a login fleetd knows is exhausted.
      const paused = yield* usage.gate(input.machineId);
      if (paused !== undefined) {
        return yield* new ToolError({
          code: "invalid",
          message: `Not launched: ${paused}.`,
          fix: `Wait for the reset (usage_status shows it), or run usage_resume with machineId ${input.machineId} once the login has capacity again.`,
        });
      }
      const cursor = yield* events.head();
      const { threadId } = yield* executors.launch(input.machineId, input).pipe(Effect.mapError(fromExecutor));
      return {
        threadId,
        next: `Call events_wait with cursor ${cursor} and machineId ${input.machineId} to wait for thread.completed.`,
      };
    }),

    thread_send: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      yield* requireKnownThread(input);
      const sent = yield* writes.send(input, input.message, input.clientRequestId).pipe(Effect.mapError(fromExecutor));
      return {
        ...sent,
        next: sent.queued
          ? `${input.machineId} is offline: the message is queued until ${sent.queuedUntil}. Wait for write.delivered or write.expired with events_wait.`
          : "Call events_wait to wait for the thread to finish.",
      };
    }),

    thread_interrupt: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      yield* requireConnected(input.machineId);
      yield* executors.interrupt(input, input.clientRequestId).pipe(Effect.mapError(fromExecutor));
      return { ok: true as const };
    }),

    subscription_set: Effect.fnUntraced(function* (caller, input) {
      if (input.machines !== "*") for (const machineId of input.machines) yield* require(caller, "read", machineId);
      const created = yield* webhooks.create(caller, input);
      return {
        ...created,
        next: "Store the secret now; it is never shown again. Verify each POST's webhook-signature header with it (Standard Webhooks).",
      };
    }),

    subscription_list: Effect.fnUntraced(function* (caller) {
      return { subscriptions: yield* webhooks.list(caller) };
    }),

    subscription_delete: Effect.fnUntraced(function* (caller, input) {
      if (!(yield* webhooks.remove(caller, input.subscriptionId))) {
        return yield* new ToolError({
          code: "not_found",
          message: `No subscription ${input.subscriptionId} for this key.`,
          fix: "Call subscription_list to see this key's subscriptions.",
        });
      }
      return { ok: true as const };
    }),

    wake_set: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.target.machineId);
      yield* requireKnownThread(input.target);
      const set = yield* wakes.set({ ...input, createdBy: caller.keyId }).pipe(
        Effect.mapError(
          (error) =>
            new ToolError({
              code: "invalid",
              message: `Invalid schedule: ${error.message}`,
              fix: "Use at (ISO time, future), every (everySec >= 60) or a 5-field cron, with an IANA tz such as Europe/London.",
            }),
        ),
      );
      return { ...set, next: `Call events_wait with types ["wake.fired"] to see it fire, or wake_cancel with wakeId ${set.wakeId}.` };
    }),

    wake_list: Effect.fnUntraced(function* (caller, input) {
      if (input.machineId !== undefined) yield* require(caller, "read", input.machineId);
      const all = (yield* wakes.list(input)).filter((w) => auth.allows(caller, "read", w.target.machineId));
      const shown = cap(all, LIMITS.wakes);
      return {
        wakes: shown.items,
        ...withTruncated(shown.truncated),
        ...(shown.truncated ? { next: "Narrow the list with machineId, threadId or state." } : {}),
      };
    }),

    wake_cancel: Effect.fnUntraced(function* (caller, input) {
      const wake = yield* wakes.get(input.wakeId);
      if (wake === undefined || !auth.allows(caller, "read", wake.target.machineId)) return yield* unknownWake(input.wakeId);
      yield* require(caller, "operate", wake.target.machineId);
      yield* wakes.cancel(input.wakeId);
      return { ok: true as const };
    }),

    lead_start: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      yield* configureLead(input);
      const lead = yield* leads.start({ machineId: input.machineId, projectId: input.projectId }).pipe(Effect.mapError(refusal));
      return {
        ...lead,
        next: `Lead thread ${lead.threadId} is ${lead.state}. Submit work with intake_submit; watch it with project_get or events_wait (lead.woken, ask.created, batch.ready).`,
      };
    }),

    lead_restart: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      yield* configureLead(input);
      const lead = yield* leads.restart({ machineId: input.machineId, projectId: input.projectId }).pipe(Effect.mapError(refusal));
      return {
        ...lead,
        next: `Fresh lead thread ${lead.threadId} (session ${lead.sessionGeneration}) started from the current digest; the old thread stays in T3 as history.`,
      };
    }),

    intake_submit: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      return yield* intake
        .submit({
          text: input.text,
          ...(input.template === undefined ? {} : { template: input.template }),
          ...(input.machineId === undefined || input.projectId === undefined ? {} : { ref: { machineId: input.machineId, projectId: input.projectId } }),
          clientRequestId: input.clientRequestId,
          channel: "mcp",
          by: caller.keyId,
          allows: (machineId) => auth.allows(caller, "operate", machineId),
        })
        .pipe(Effect.mapError(refusal));
    }),

    workstream_list: Effect.fnUntraced(function* (caller, input) {
      if (input.machineId !== undefined) yield* require(caller, "read", input.machineId);
      const ref = input.machineId !== undefined && input.projectId !== undefined ? { machineId: input.machineId, projectId: input.projectId } : undefined;
      const all = (yield* workstreams.list({
        ...(ref === undefined ? {} : { ref }),
        ...(input.state === undefined ? {} : { state: input.state }),
        limit: ref === undefined ? 1000 : input.limit + 1,
      })).filter(
        (w) =>
          auth.allows(caller, "read", w.projectRef.machineId) &&
          (input.machineId === undefined || w.projectRef.machineId === input.machineId) &&
          (input.projectId === undefined || w.projectRef.projectId === input.projectId),
      );
      const shown = cap(all, input.limit);
      return { workstreams: shown.items, ...withTruncated(shown.truncated), ...(shown.truncated ? { next: "Narrow the list with machineId, projectId or state." } : {}) };
    }),

    workstream_get: Effect.fnUntraced(function* (caller, input) {
      const workstream = yield* workstreams.get(input.workstreamId);
      if (workstream === undefined || !auth.allows(caller, "read", workstream.projectRef.machineId)) {
        return yield* unknownWorkstream(input.workstreamId);
      }
      const open = cap(yield* asks.list({ workstreamId: input.workstreamId, state: "open", limit: LIMITS.workstreamAsks + 1 }), LIMITS.workstreamAsks);
      const scoped = cap(
        yield* decisions.list({ scope: { kind: "workstream", workstreamId: input.workstreamId }, limit: LIMITS.workstreamAsks + 1 }),
        LIMITS.workstreamAsks,
      );
      const eta = yield* estimates.eta(workstream);
      const recentClaims = yield* claims.list({ workstreamId: input.workstreamId, limit: LIMITS.workstreamClaims });
      return {
        workstream,
        asks: open.items,
        decisions: scoped.items,
        ...(eta === undefined ? {} : { eta }),
        ...(recentClaims.length === 0 ? {} : { claims: recentClaims }),
        ...withTruncated(open.truncated ?? scoped.truncated),
        next:
          workstream.state === "draft"
            ? "The lead has not registered its brief yet; wait for workstream.running with events_wait."
            : workstream.state === "done"
              ? `Done: its latest claim passed every done-when check (claims_list with workstreamId ${workstream.workstreamId}).`
              : "Open asks are answered with asks_list and inbox_reply.",
      };
    }),

    // The finish-all lead's own calls, for an outside orchestrator: same service, same limits, recorded as this key.
    workstream_spawn: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      const ref = { machineId: input.machineId, projectId: input.projectId };
      if ((yield* store.projects.get(ref)) === undefined) return yield* unknownProject(ref);
      const spawned = yield* finishAll
        .spawn(
          { projectRef: ref, by: caller.keyId, channel: "mcp" },
          { text: input.text, serves: input.serves, ...(input.template === undefined ? {} : { template: input.template }) },
        )
        .pipe(Effect.mapError(refusal));
      return {
        ...spawned,
        next: `${spawned.workstreamId} is a draft child of ${spawned.parent}; its lead writes the brief. Watch it with workstream_get or events_wait (workstream.running, workstream.done).`,
      };
    }),

    inventory: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "read", input.machineId);
      const ref = { machineId: input.machineId, projectId: input.projectId };
      if ((yield* store.projects.get(ref)) === undefined) return yield* unknownProject(ref);
      const listed = yield* finishAll.inventory({ projectRef: ref, by: caller.keyId }).pipe(Effect.mapError(refusal));
      return {
        ...listed,
        next: listed.idle
          ? "Nothing is left with a value source: the finish-all workstream is idle."
          : listed.spawnable > 0
            ? "Start a child for an unserved item with workstream_spawn, passing its serves value; that needs the project's open finish-all workstream (intake_submit \"finish: ...\" starts one)."
            : "Every item with a value source is in progress; wait for workstream.done with events_wait.",
      };
    }),

    claims_list: Effect.fnUntraced(function* (caller, input) {
      if (input.projectRef !== undefined) yield* require(caller, "read", input.projectRef.machineId);
      if (input.workstreamId !== undefined) {
        const workstream = yield* workstreams.get(input.workstreamId);
        if (workstream === undefined || !auth.allows(caller, "read", workstream.projectRef.machineId)) return yield* unknownWorkstream(input.workstreamId);
      }
      // Scoped to one project or workstream the store's limit is exact; otherwise read wide and keep what the key may see.
      const scoped = input.projectRef !== undefined || input.workstreamId !== undefined;
      const listed = yield* claims.list({
        ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
        ...(input.projectRef === undefined ? {} : { ref: input.projectRef }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        limit: scoped ? input.limit + 1 : 1000,
      });
      const all: Array<Claim> = [];
      const machineOf = new Map<string, MachineId | undefined>();
      for (const claim of listed) {
        if (scoped) {
          all.push(claim);
          continue;
        }
        if (!machineOf.has(claim.workstreamId)) machineOf.set(claim.workstreamId, (yield* workstreams.get(claim.workstreamId))?.projectRef.machineId);
        const machineId = machineOf.get(claim.workstreamId);
        if (machineId !== undefined && auth.allows(caller, "read", machineId)) all.push(claim);
      }
      const shown = cap(all, input.limit);
      return {
        claims: shown.items,
        ...withTruncated(shown.truncated),
        next: shown.truncated ? "Narrow the list with workstreamId, projectRef or outcome." : "Each result's evidence is what fleetd saw; workstream_get shows the workstream's state.",
      };
    }),

    incidents_list: Effect.fnUntraced(function* (caller, input) {
      if (input.projectRef !== undefined) yield* require(caller, "read", input.projectRef.machineId);
      const scoped = input.projectRef !== undefined;
      const all = (yield* incidents.list({
        ...(input.projectRef === undefined ? {} : { projectRef: input.projectRef }),
        ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
        ...(input.class === undefined ? {} : { class: input.class }),
        limit: scoped ? input.limit + 1 : 1000,
      })).filter((i) => auth.allows(caller, "read", i.projectRef.machineId));
      const shown = cap(all, input.limit);
      return {
        incidents: shown.items,
        ...withTruncated(shown.truncated),
        ...(shown.truncated ? { next: "Narrow the list with projectRef, workstreamId or class." } : {}),
      };
    }),

    changes_list: Effect.fnUntraced(function* (caller, input) {
      if (input.projectRef !== undefined) yield* require(caller, "read", input.projectRef.machineId);
      const scoped = input.projectRef !== undefined;
      const all = (yield* train.list({
        ...(input.projectRef === undefined ? {} : { projectRef: input.projectRef }),
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(input.state === undefined ? {} : { state: input.state }),
        limit: scoped ? input.limit + 1 : 1000,
      })).filter((c) => auth.allows(caller, "read", c.projectRef.machineId));
      const shown = cap(all, input.limit);
      return {
        changes: shown.items,
        ...withTruncated(shown.truncated),
        next: shown.truncated ? "Narrow the list with projectRef, repo or state." : "train_get shows a repo's train; only the train merges.",
      };
    }),

    train_get: Effect.fnUntraced(function* (caller, input) {
      const row = yield* changeRecords.train(input.repo);
      if (row === undefined || !auth.allows(caller, "read", row.projectRef.machineId)) return yield* unknownTrain(input.repo);
      const state = yield* train.state(input.repo);
      return {
        train: state,
        next: state.frozen
          ? `Frozen by ${freezeKey(input.repo)}; train_freeze with frozen false resumes it.`
          : "changes_list with this repo shows each Change; events_wait for pr.merged.",
      };
    }),

    train_freeze: Effect.fnUntraced(function* (caller, input) {
      const row = yield* changeRecords.train(input.repo);
      if (row === undefined || !auth.allows(caller, "read", row.projectRef.machineId)) return yield* unknownTrain(input.repo);
      yield* require(caller, "operate", row.projectRef.machineId);
      const key = freezeKey(input.repo) as DecisionKey;
      const chain = { projectRef: row.projectRef };
      if (input.frozen) {
        yield* decisions.record(
          { key, scope: { kind: "project", projectRef: row.projectRef }, value: "true", ...(input.reason === undefined ? {} : { why: input.reason }), projectRef: row.projectRef },
          actorOf(caller),
        );
      } else {
        // Every active freeze along the chain goes: a project one may hide a global one behind it.
        for (let active = yield* decisions.resolve(key, chain); active !== undefined; active = yield* decisions.resolve(key, chain)) {
          if (active.scope.kind === "global" && !allowsEverywhere(caller, "operate")) {
            return yield* new ToolError({
              code: "forbidden",
              message: `${active.decisionId} freezes ${input.repo} globally; this key has no operate grant on every machine.`,
              fix: "Use a key with an operate grant on * machines.",
            });
          }
          yield* decisions.retire(active.decisionId).pipe(Effect.mapError(refusal));
        }
      }
      return {
        train: { ...(yield* train.state(input.repo)), frozen: input.frozen },
        next: `The train ${input.frozen ? "holds" : "resumes"} on its next pass (within 15 s) and emits ${input.frozen ? "train.frozen" : "train.resumed"}.`,
      };
    }),

    asks_list: Effect.fnUntraced(function* (caller, input) {
      const visible = (ask: Ask) => auth.allows(caller, "read", ask.projectRef?.machineId);
      const listed = (yield* asks.list({ state: input.state, ...(input.batchId === undefined ? {} : { batchId: input.batchId }), limit: 1000 })).filter(visible);
      const shownAsks = cap(listed, LIMITS.asks);
      const ids = new Set(shownAsks.items.map((ask) => ask.askId as string));
      const inBatch = new Set(shownAsks.items.flatMap((ask) => (ask.batchId === undefined ? [] : [ask.batchId as string])));
      const candidates = input.batchId === undefined ? yield* asks.batches({ limit: 200 }) : yield* asks.batches({ batchId: input.batchId });
      // Only the caller's items are shown; numbers stay as fixed in the batch.
      const batches = candidates
        .filter((b: Batch) => inBatch.has(b.batchId))
        .map((b: Batch) => ({ ...b, items: b.items.filter((item) => ids.has(item.askId)) }));
      const shownBatches = cap(batches, LIMITS.batches);
      const truncated = shownAsks.truncated ?? shownBatches.truncated;
      return {
        batches: shownBatches.items,
        asks: shownAsks.items,
        ...withTruncated(truncated),
        next:
          shownAsks.items.length === 0
            ? "Nothing to answer. Wait for batch.ready with events_wait."
            : 'Answer with inbox_reply, e.g. "1 go 2 nvm 3 b", "recs fine", "2: your own answer"; a leading "#B<n>" picks an older batch.',
      };
    }),

    inbox_reply: Effect.fnUntraced(function* (caller, input) {
      const result = yield* inbox.reply(
        {
          raw: input.raw,
          ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
          allows: (ref) => (ref === undefined ? allowsEverywhere(caller, "operate") : auth.allows(caller, "operate", ref.machineId)),
        },
        actorOf(caller),
      ).pipe(Effect.mapError(refusal));
      return result.parsed ? { ...result, next: "Each answer is a Decision now and reaches its lead in its next wake." } : result;
    }),

    secret_submit: (caller, input) => approvals.submitSecret(caller, input).pipe(Effect.mapError(refusal)),

    decisions_search: Effect.fnUntraced(function* (caller, input) {
      const scoped = input.scope === undefined ? undefined : yield* decisionProject(input.scope);
      if (scoped !== undefined) yield* require(caller, "read", scoped.machineId);
      const found = yield* decisions.search(input.query, { ...(input.scope === undefined ? {} : { scope: input.scope }), limit: input.limit });
      const visible: Array<Decision> = [];
      for (const decision of found) if (yield* canReadDecision(caller, decision)) visible.push(decision);
      return {
        decisions: visible,
        ...(visible.length === 0 ? { next: "No active decision matches; record one with decisions_record." } : {}),
      };
    }),

    decisions_record: Effect.fnUntraced(function* (caller, input) {
      const ref = yield* decisionProject(input.scope);
      if (input.scope.kind === "global") {
        if (!allowsEverywhere(caller, "operate")) {
          return yield* new ToolError({
            code: "forbidden",
            message: "A global decision applies to every machine; this key has no operate grant on all of them.",
            fix: "Record it at project scope, or use a key with an operate grant on * machines.",
          });
        }
      } else if (ref !== undefined) {
        yield* require(caller, "operate", ref.machineId);
        if (input.scope.kind === "project" && (yield* store.projects.get(ref)) === undefined) return yield* unknownProject(ref);
      }
      const decision = yield* decisions.record(
        {
          key: input.key,
          scope: input.scope,
          value: input.value,
          ...(input.why === undefined ? {} : { why: input.why }),
          ...(ref === undefined ? {} : { projectRef: ref }),
        },
        actorOf(caller),
      );
      return {
        decision,
        next: `${decision.decisionId} is active${decision.supersedes === undefined ? "" : ` and supersedes ${decision.supersedes}`}. Leads use it instead of asking; a project's lead is woken with it.`,
      };
    }),

    tasks_list: Effect.fnUntraced(function* (caller, input) {
      if (input.projectRef !== undefined) yield* require(caller, "read", input.projectRef.machineId);
      // Without a project, read wide and keep what the key may see.
      const listed = (yield* tasks.list({
        ...(input.projectRef === undefined ? {} : { ref: input.projectRef }),
        ...(input.state === undefined ? {} : { state: input.state }),
        limit: input.projectRef === undefined ? 1000 : input.limit + 1,
      })).filter((t) => auth.allows(caller, "read", t.projectRef.machineId));
      const shown = cap(listed, input.limit);
      return {
        tasks: shown.items,
        ...withTruncated(shown.truncated),
        next: shown.truncated ? "Narrow the list with projectRef or state." : "Call task_get for one task's result, or thread_tail on its threadRef for its transcript.",
      };
    }),

    task_get: Effect.fnUntraced(function* (caller, input) {
      const task = yield* tasks.get(input.taskId);
      if (task === undefined || !auth.allows(caller, "read", task.projectRef.machineId)) return yield* unknownTask(input.taskId);
      return {
        task,
        next:
          task.threadRef === undefined
            ? `${task.taskId} has not started${task.queuedReason === undefined ? "" : `: ${task.queuedReason}`}.`
            : `Read its transcript with thread_tail (machineId ${task.threadRef.machineId}, threadId ${task.threadRef.threadId}).`,
      };
    }),

    cap_set: Effect.fnUntraced(function* (_caller, input) {
      if (input.share !== undefined && (yield* store.projects.get(input.share.projectRef)) === undefined) {
        return yield* unknownProject(input.share.projectRef);
      }
      const board = yield* slots.setCap({
        ...(input.cap === undefined ? {} : { cap: input.cap }),
        ...(input.share === undefined ? {} : { share: input.share }),
      });
      return { slots: board, next: "Applied now: queued tasks start as soon as they fit. fleetd_status shows the board." };
    }),

    usage_status: Effect.fnUntraced(function* (caller, input) {
      if (input.machineId !== undefined) {
        yield* require(caller, "read", input.machineId);
        if ((yield* store.machines.get(input.machineId)) === undefined) return yield* unknownMachine(input.machineId);
      }
      const machines = (yield* store.machines.list()).filter(
        (m) => auth.allows(caller, "read", m.machineId) && (input.machineId === undefined || m.machineId === input.machineId),
      );
      const statuses = yield* Effect.forEach(machines, (m) => usage.status(m.machineId, usageSource.read(m.machineId)));
      const open = statuses.filter((s) => s.breaker.state === "open").map((s) => s.machineId);
      return {
        machines: statuses,
        next:
          open.length === 0
            ? "No login is paused. fleetd never calls a usage API; probes.count must stay 0."
            : `Paused: ${open.join(", ")}. It lifts at the reset, or run usage_resume once the login has capacity.`,
      };
    }),

    usage_resume: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      if ((yield* store.machines.get(input.machineId)) === undefined) return yield* unknownMachine(input.machineId);
      const { resumed } = yield* usage.resume(input.machineId, caller.name);
      return {
        resumed,
        status: yield* usage.status(input.machineId, usageSource.read(input.machineId)),
        next: "Queued tasks start as slots allow. If the limit is still there, the breaker trips again on the next failures.",
      };
    }),

    digest_get: Effect.fnUntraced(function* (caller) {
      const digest = yield* digests.render((machineId) => auth.allows(caller, "read", machineId));
      return { ...digest, next: "Answer open items with inbox_reply. The hub emits digest.ready at 09:00 and 18:00 (policy.tz) as the cue to call this again." };
    }),

    doctor_list: Effect.fnUntraced(function* (caller, input) {
      if (input.machineId !== undefined) yield* require(caller, "read", input.machineId);
      const results = yield* doctor.list({ rerun: input.rerun === true });
      const checks = results.checks.filter((c) =>
        c.machineId === undefined
          ? input.machineId === undefined
          : auth.allows(caller, "read", c.machineId) && (input.machineId === undefined || c.machineId === input.machineId),
      );
      const failing = checks.filter((c) => c.status === "fail" || c.status === "warn");
      return {
        checks,
        checkedAt: results.checkedAt,
        next: failing.some((c) => c.fix?.kind === "auto")
          ? "Run doctor_fix with a checkId to apply its automatic fix; manual fixes name the command to run."
          : failing.length > 0
            ? "Each failing check names the command that fixes it."
            : "Every check passes. rerun: true runs them now; the hub also runs them every 15 minutes and emits doctor.changed.",
      };
    }),

    doctor_fix: Effect.fnUntraced(function* (caller, input) {
      const scope = input.checkId.slice(0, input.checkId.indexOf("/"));
      const machineId = scope === "hub" ? undefined : (scope as MachineId);
      // The fixes are safe but act on machines: admin keys, or a person's own paired device.
      if (!auth.allows(caller, "admin", machineId) && !(caller.kind === "human" && auth.allows(caller, "operate", machineId))) {
        return yield* new ToolError({
          code: "forbidden",
          message: "doctor_fix needs an admin key, or a person's paired device with operate on the machine.",
          fix: "Run it from the phone app, or with a key from fleetd hub key create --role admin.",
        });
      }
      const { ran, check } = yield* doctor.fix(input.checkId).pipe(Effect.mapError(refusal));
      return {
        ran,
        check,
        next: check.status === "ok" ? "Fixed: the check passes now." : `Still ${check.status}: ${check.message}`,
      };
    }),
  };

  return FleetApi.of({
    call: (caller, tool, input) =>
      Effect.andThen(require(caller, McpTools[tool].scope), () =>
        (handlers[tool] as (c: AgentKeyInfo, i: typeof input) => Effect.Effect<ToolOutput<typeof tool>, ToolError>)(caller, input),
      ).pipe(
        // Store failures are defects; one failed request must not take the connection down.
        Effect.catchDefect((defect) =>
          Effect.logError("tool call failed", { tool, defect }).pipe(Effect.andThen(Effect.fail(internalError))),
        ),
      ),
  });
});

export const layer = Layer.effect(FleetApi, make);
