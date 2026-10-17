import {
  ErrorCode,
  McpTools,
  type AgentKeyInfo,
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
import * as Auth from "../auth/Auth.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Executors from "../executor/Executors.ts";

/** A tool failure in the spec's `{ code, message, fix }` shape. Every one says what to do next. */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  code: ErrorCode,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
}) {}

export type ToolInput<N extends McpToolName> = (typeof McpTools)[N]["input"]["Type"];
export type ToolOutput<N extends McpToolName> = (typeof McpTools)[N]["output"]["Type"];

export const LIMITS = { projects: 50, attention: 10, outcomeThreads: 20, tailText: 2000 } as const;
const ATTENTION_TYPES: ReadonlyArray<HubEventType> = ["thread.failed", "thread.waiting", "thread.usage_limited"];
/** How far back fleetd_status looks for attention events. */
const ATTENTION_LOOKBACK = 1000;

/**
 * Everything the central MCP and the app WebSocket can ask of the hub, one method per MCP tool.
 * `call` checks the tool's role; each handler checks the per-machine grant and trims to the limits.
 */
export class FleetApi extends Context.Service<
  FleetApi,
  {
    readonly call: <N extends McpToolName>(
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

const make = Effect.gen(function* () {
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const auth = yield* Auth.Auth;
  const executors = yield* Executors.Executors;

  const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

  const require = (caller: AgentKeyInfo, role: Role, machineId?: MachineId) =>
    auth.allows(caller, role, machineId) ? Effect.void : Effect.fail(forbidden(role, machineId));

  const canRead = (caller: AgentKeyInfo) => (event: HubEvent) =>
    event.machineId === undefined || auth.allows(caller, "read", event.machineId);

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

  const handlers: { readonly [N in McpToolName]: (caller: AgentKeyInfo, input: ToolInput<N>) => Effect.Effect<ToolOutput<N>, ToolError> } = {
    fleetd_status: Effect.fnUntraced(function* (caller) {
      const cursor = yield* events.head();
      const machines = (yield* store.machines.list()).filter((m: Machine) => auth.allows(caller, "read", m.machineId));
      const projects = (yield* store.projects.list())
        .filter((p) => auth.allows(caller, "read", p.machineId))
        .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      const shown = cap(projects, LIMITS.projects);
      return {
        machines,
        projects: shown.items,
        attention: yield* attention(caller, cursor),
        cursor,
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
      const threads = cap(yield* store.threads.listByProject(input, LIMITS.outcomeThreads + 1), LIMITS.outcomeThreads);
      return {
        project,
        threads: threads.items.map((t) => markStale(t, fresh)),
        stale: fresh.stale,
        asOf: fresh.asOf,
        ...withTruncated(threads.truncated),
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
      const cursor = yield* events.head();
      const { threadId } = yield* executors.launch(input.machineId, input).pipe(Effect.mapError(fromExecutor));
      return {
        threadId,
        next: `Call events_wait with cursor ${cursor} and machineId ${input.machineId} to wait for thread.completed.`,
      };
    }),

    thread_send: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      yield* requireConnected(input.machineId);
      const sent = yield* executors
        .send(input, input.message, input.clientRequestId)
        .pipe(Effect.mapError(fromExecutor));
      return { ...sent, next: "Call events_wait to wait for the thread to finish." };
    }),

    thread_interrupt: Effect.fnUntraced(function* (caller, input) {
      yield* require(caller, "operate", input.machineId);
      yield* requireConnected(input.machineId);
      yield* executors.interrupt(input, input.clientRequestId).pipe(Effect.mapError(fromExecutor));
      return { ok: true as const };
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
