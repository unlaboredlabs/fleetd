// fleetd-owned tasks: every subagent a lead runs. Spawn resolves model and effort, takes leases (writers) and a
// slot or queues with the reason, and launches a T3 thread (writers in a new worktree on `fleetd/<taskId>-<slug>`).
// The thread's status transitions, read off the event log, end the task: the result goes into the record and,
// inline, into one lead wake; the slot and leases are released and the queue is tried again.
import type {
  HubEvent,
  HubEventType,
  PolicyFile,
  ProjectRef,
  Task,
  TaskId,
  TaskResult,
  TaskResultStatus,
  TaskSpawnCall,
  TaskState,
  WorkstreamId,
} from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Executors from "../executor/Executors.ts";
import { ThreadWorkspace } from "../executor/ThreadWorkspace.ts";
import { fromExecutor, LeadError } from "../leads/LeadError.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Leases from "../leases/Leases.ts";
import * as Policy from "../leases/Policy.ts";
import * as Receipts from "../receipts/Receipts.ts";
import * as Slots from "../slots/Slots.ts";
import * as ValueBar from "../valuebar/ValueBar.ts";
import { outsideGlobs } from "./glob.ts";
import { branchFor, findPrUrl, renderTaskPrompt, tailOf } from "./render.ts";
import { resolveModelEffort } from "./resolve.ts";
import * as TaskRecords from "./TaskRecords.ts";

/** Who asks: the project's lead, as the lead-call handler attributes it. */
export interface TaskCaller {
  readonly projectRef: ProjectRef;
  readonly by: string;
}

export type SpawnInput = Omit<typeof TaskSpawnCall.Type, "op">;

export class Tasks extends Context.Service<
  Tasks,
  {
    /** The task as stored: running, queued with its reason, or failed if T3 refused the launch. */
    readonly spawn: (caller: TaskCaller, input: SpawnInput) => Effect.Effect<Task, LeadError>;
    /** Steers a running task; continues an ended one in the same thread, which re-takes its slot and leases. */
    readonly message: (caller: TaskCaller, taskId: TaskId, message: string) => Effect.Effect<Task, LeadError>;
    /** Interrupts a running task and releases its slot and leases. */
    readonly cancel: (caller: TaskCaller, taskId: TaskId, reason?: string) => Effect.Effect<Task, LeadError>;
    readonly get: (taskId: TaskId) => Effect.Effect<Task | undefined>;
    /** Newest first. */
    readonly list: (filter: {
      readonly ref?: ProjectRef;
      readonly state?: TaskState;
      readonly workstreamId?: WorkstreamId;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Task>>;
  }
>()("fleetd/tasks/Tasks") {}

const THREAD_EVENTS: ReadonlyArray<HubEventType> = [
  "thread.started",
  "thread.waiting",
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
  "thread.usage_limited",
];

const OUT_OF_AREA_MAX = 20;

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

const without = <A extends object, K extends keyof A>(a: A, ...keys: ReadonlyArray<K>): Omit<A, K> =>
  Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k as K))) as Omit<A, K>;

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const make = Effect.gen(function* () {
  const records = yield* TaskRecords.TaskRecords;
  const leadRecords = yield* LeadRecords.LeadRecords;
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const executors = yield* Executors.Executors;
  const workspace = yield* ThreadWorkspace;
  const wakes = yield* LeadWakes.LeadWakes;
  const slots = yield* Slots.Slots;
  const leases = yield* Leases.Leases;
  const policies = yield* Policy.Policies;
  // M6 value bar and receipts (apps/hub/src/valuebar, apps/hub/src/receipts).
  const valueBar = yield* ValueBar.ValueBar;
  const receipts = yield* Receipts.Receipts;
  const scope = yield* Effect.scope;
  // Every state change goes through this, so a release, a completion and a lead call never interleave.
  const lock = Semaphore.makeUnsafe(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /** Machines a queued task waits on; one waiter each. */
  const awaiting = new Set<string>();

  const emit = (task: Task, type: HubEventType, summary: string, extra: Record<string, unknown> = {}) =>
    Effect.flatMap(nowIso, (at) =>
      events.append({
        at,
        type,
        machineId: task.projectRef.machineId,
        projectId: task.projectRef.projectId,
        ...(task.threadRef === undefined ? {} : { threadId: task.threadRef.threadId }),
        summary,
        data: { taskId: task.taskId, workstreamId: task.workstreamId, ...(task.branch === undefined ? {} : { branch: task.branch }), ...extra },
      }),
    );

  const releaseAll = (task: Task) => Effect.andThen(slots.release(task.taskId), Effect.asVoid(leases.release(task.taskId)));

  const wake = (task: Task, result: TaskResult) =>
    wakes.trigger(task.projectRef, { kind: "task_result", taskId: task.taskId, title: task.title, result });

  const globsOf = (policy: PolicyFile, areas: ReadonlyArray<string>) => Object.fromEntries(areas.map((a) => [a, policy.areas[a] ?? []]));

  const queue = (stored: TaskRecords.StoredTask, reason: string) =>
    Effect.gen(function* () {
      const { task } = stored;
      if (task.state === "queued" && task.queuedReason === reason) return task;
      const next: Task = { ...task, state: "queued", queuedReason: reason.slice(0, 200) };
      yield* records.put({ ...stored, task: next });
      yield* emit(next, "task.queued", `${task.taskId} queued: ${reason}`, { queuedReason: reason });
      return next;
    });

  const launch = (task: Task) =>
    Effect.gen(function* () {
      const ref = task.projectRef;
      const project = yield* store.projects.get(ref);
      if (project === undefined) {
        return yield* new LeadError({ code: "not_found", message: `No project ${ref.projectId} on machine ${ref.machineId}.` });
      }
      const policy = yield* policies.get(ref);
      const brief = (yield* leadRecords.workstreams.get(task.workstreamId))?.workstream.brief;
      const write = task.kind === "write";
      const baseBranch = write ? yield* workspace.defaultBranch(ref.machineId, project.workspaceRoot) : undefined;
      const branch = write ? branchFor(task.taskId, task.title) : undefined;
      const prompt = renderTaskPrompt({ task, projectTitle: project.title, brief, areaGlobs: globsOf(policy, task.areas), branch, baseBranch });
      const { threadId } = yield* executors.launch(
        ref.machineId,
        {
          machineId: ref.machineId,
          projectId: ref.projectId,
          prompt,
          model: task.model,
          effort: task.effort,
          runtimeMode: "full-access",
          title: `${task.taskId}: ${task.title}`.slice(0, 80),
          // T3 keeps a receipt per command id, so a retried launch returns the same thread.
          clientRequestId: `fleetd-task:${task.taskId}:${task.attempt}`,
        },
        baseBranch === undefined || branch === undefined ? undefined : { workspace: { type: "worktree", baseRef: baseBranch, branch } },
      );
      return { threadRef: { machineId: ref.machineId, threadId }, ...(branch === undefined ? {} : { branch }) };
    });

  /** Sends a continuation and returns how it went out, or fails like `launch`. */
  const resume = (task: Task, message: string) =>
    Effect.as(executors.send(task.threadRef!, message, `fleetd-task:${task.taskId}:${task.attempt}`), {});

  const failToStart = (stored: TaskRecords.StoredTask, error: unknown, fromQueue: boolean) =>
    Effect.gen(function* () {
      const { task } = stored;
      const at = yield* nowIso;
      const message = describeError(error);
      const result: TaskResult = { status: "failed", tail: tailOf(`fleetd could not start the task: ${message}`), at, ...(task.branch === undefined ? {} : { branch: task.branch }) };
      const next: Task = { ...without(task, "queuedReason"), state: "failed", result, endedAt: at };
      yield* records.put({ task: next });
      yield* releaseAll(task);
      // A direct call gets this in its reply; a task started from the queue has nobody waiting on it.
      if (fromQueue) yield* wake(next, result);
      yield* emit(next, "task.failed", `${task.taskId} failed to start: ${message}`);
      return next;
    });

  const retryWhenLive = (machineId: ProjectRef["machineId"]) =>
    Effect.suspend(() => {
      if (awaiting.has(machineId)) return Effect.void;
      awaiting.add(machineId);
      return executors.awaitLive(machineId).pipe(
        Effect.ensuring(Effect.sync(() => awaiting.delete(machineId))),
        Effect.andThen(lock.withPermit(retryQueue)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  /** Leases, then a slot, then the launch or the pending message. Queues with the first reason it cannot go. */
  const tryStart = (stored: TaskRecords.StoredTask, fromQueue: boolean): Effect.Effect<Task> =>
    Effect.gen(function* () {
      const { task } = stored;
      if (task.kind === "write") {
        const lease = yield* leases.acquire({ projectRef: task.projectRef, taskId: task.taskId, areas: task.areas });
        if (!lease.granted) return yield* queue(stored, lease.reason);
      }
      // Checked before the slot: taking and releasing one would run the queue again at once.
      const offline = `machine ${task.projectRef.machineId} is offline`;
      if (!(yield* executors.isConnected(task.projectRef.machineId))) {
        yield* retryWhenLive(task.projectRef.machineId);
        return yield* queue(stored, offline);
      }
      const slot = yield* slots.acquire({ holder: task.taskId, projectRef: task.projectRef, priority: Slots.priorityOf(task.kind) });
      if (!slot.granted) return yield* queue(stored, slot.reason);

      const continuing = task.threadRef !== undefined && stored.pendingMessage !== undefined;
      const started = yield* (continuing ? resume(task, stored.pendingMessage!) : launch(task)).pipe(Effect.result);
      if (started._tag === "Failure") {
        const error = started.failure;
        if (error._tag === "MachineNotConnected") {
          yield* slots.release(task.taskId);
          yield* retryWhenLive(task.projectRef.machineId);
          return yield* queue(stored, offline);
        }
        return yield* failToStart(stored, error, fromQueue);
      }
      const at = yield* nowIso;
      const next: Task = {
        ...without(task, "queuedReason", "endedAt"),
        ...started.success,
        state: "running",
        startedAt: task.startedAt ?? at,
      };
      // From here the board holds the slot while the thread runs and frees it whenever it stops.
      yield* slots.bind(task.taskId, next.threadRef!);
      yield* records.put({ task: next });
      yield* emit(
        next,
        "task.started",
        continuing ? `${task.taskId} continued (attempt ${task.attempt}): ${task.title}` : `${task.taskId} started (${task.model}/${task.effort}): ${task.title}`,
      );
      return next;
    }).pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning("task start failed", { taskId: stored.task.taskId, cause: Cause.pretty(cause) }), stored.task)));

  /** FIFO over every project's queue; each task is tried once. */
  const retryQueue: Effect.Effect<void> = Effect.gen(function* () {
    for (const stored of yield* records.queued()) yield* tryStart(stored, true);
  });

  const retryLater = Effect.asVoid(Effect.forkIn(lock.withPermit(retryQueue), scope));

  const finish = (stored: TaskRecords.StoredTask, status: TaskResultStatus) =>
    Effect.gen(function* () {
      const { task } = stored;
      const ref = task.threadRef!;
      const thread = yield* store.threads.get(ref);
      const text = thread?.latestMessageTail ?? "";
      const error = status === "failed" && thread?.lastError !== undefined ? `[${thread.lastError.class}] ${thread.lastError.message}` : "";
      const write = task.kind === "write";
      const changes = write ? yield* Effect.option(workspace.changes(ref)) : undefined;
      const actions = yield* executors.actions(ref, 30).pipe(Effect.orElseSucceed(() => []));
      const prUrl =
        (changes?._tag === "Some" ? changes.value.pullRequestUrls.at(-1) : undefined) ??
        findPrUrl([...actions].reverse().flatMap((a) => [a.summary, a.outputTail]).concat(text));
      const branch = (changes?._tag === "Some" ? changes.value.branch : undefined) ?? task.branch;
      const at = yield* nowIso;
      // M6 receipts: what the thread actually ran, counted from its items.
      const result: TaskResult = yield* receipts.attach(ref, {
        status,
        tail: tailOf([text.trim(), error].filter((s) => s !== "").join("\n\n")),
        ...(branch === undefined ? {} : { branch }),
        ...(prUrl === undefined ? {} : { prUrl }),
        at,
      });
      const worktreePath = changes?._tag === "Some" ? changes.value.worktreePath : undefined;
      const next: Task = {
        ...task,
        state: status,
        result,
        endedAt: at,
        ...(branch === undefined ? {} : { branch }),
        ...(worktreePath === undefined ? {} : { worktreePath }),
      };
      yield* records.put({ task: next });

      if (changes?._tag === "Some") {
        const policy = yield* Effect.option(policies.get(task.projectRef));
        if (policy._tag === "Some") {
          const outside = outsideGlobs(changes.value.paths, Object.values(globsOf(policy.value, task.areas)).flat());
          if (outside.length > 0) {
            yield* emit(
              next,
              "task.out_of_area",
              `${task.taskId} changed ${outside.length} file${outside.length === 1 ? "" : "s"} outside ${task.areas.join(", ")}: ${outside.slice(0, 5).join(", ")}`,
              { paths: outside.slice(0, OUT_OF_AREA_MAX) },
            );
          }
        }
      }
      yield* releaseAll(task);
      yield* wake(next, result);
      // Last, so whoever waits on it sees the slot, the leases and the wake already settled.
      yield* emit(next, status === "done" ? "task.completed" : "task.failed", `${task.taskId} ${status === "done" ? "completed" : "failed"}: ${task.title}`);
      yield* retryQueue;
    });

  const onThreadEvent = (event: HubEvent) =>
    Effect.gen(function* () {
      if (event.machineId === undefined || event.threadId === undefined) return;
      const stored = yield* records.byThread({ machineId: event.machineId, threadId: event.threadId });
      if (stored === undefined) return;
      const { task } = stored;
      const live = task.state === "running" || task.state === "idle";
      switch (event.type) {
        case "thread.started": {
          // Continued outside `task message`: the watchdog's nudge, or a human writing to the thread.
          if (task.state !== "done" && task.state !== "failed" && task.state !== "idle") return;
          if (task.kind === "write") yield* leases.acquire({ projectRef: task.projectRef, taskId: task.taskId, areas: task.areas });
          yield* slots.acquire({ holder: task.taskId, projectRef: task.projectRef, priority: Slots.priorityOf(task.kind) });
          yield* slots.bind(task.taskId, task.threadRef!);
          yield* records.put({ task: { ...without(task, "endedAt"), state: "running" } });
          return;
        }
        case "thread.waiting": {
          // The board frees the slot itself and takes it again if the run resumes; the leases stay.
          if (task.state !== "running") return;
          yield* records.put({ task: { ...task, state: "idle" } });
          // Nobody else answers a task's question, so its lead is woken with it.
          const ref = task.threadRef!;
          const asked = yield* workspace.pendingQuestion(ref).pipe(Effect.orElseSucceed(() => undefined));
          const latest = (yield* store.threads.get(ref))?.latestMessageTail.trim();
          const question = asked ?? (latest === undefined || latest === "" ? undefined : tailOf(latest, 1500));
          yield* wakes.trigger(task.projectRef, {
            kind: "task_waiting",
            taskId: task.taskId,
            title: task.title,
            question: question ?? `(T3 did not say what it waits for; read it with thread_tail on ${ref.machineId}/${ref.threadId})`,
          });
          return;
        }
        case "thread.completed":
          if (live) yield* finish(stored, "done");
          return;
        case "thread.failed":
        case "thread.usage_limited":
        case "thread.interrupted":
          // A cancel interrupts the thread itself and has already ended the task.
          if (live) yield* finish(stored, "failed");
          return;
      }
    }).pipe(
      lock.withPermit,
      Effect.catchCause((cause) => Effect.logWarning("task event not handled", { seq: event.seq, cause: Cause.pretty(cause) })),
    );

  const follow = (from: number) =>
    Effect.gen(function* () {
      let cursor = from;
      while (true) {
        const page = yield* events.wait({ cursor, types: THREAD_EVENTS, timeoutSec: 300 });
        cursor = page.cursor;
        for (const event of page.events) yield* onThreadEvent(event);
      }
    });

  const owned = (caller: TaskCaller, taskId: TaskId) =>
    Effect.flatMap(records.get(taskId), (stored) =>
      stored === undefined || !sameProject(stored.task.projectRef, caller.projectRef)
        ? Effect.fail(new LeadError({ code: "not_found", message: `No task ${taskId} in this project.`, fix: "Run `fleetd task list`." }))
        : Effect.succeed(stored),
    );

  // M6 value bar: serves, done workstreams and review rounds. Outside the lock, since it may ask GitHub for a PR head,
  // and before the closed-state check, so a done workstream gets its own refusal.
  const checkValueBar = (caller: TaskCaller, input: SpawnInput) =>
    Effect.flatMap(leadRecords.workstreams.get(input.workstreamId), (ws) =>
      ws === undefined || !sameProject(ws.workstream.projectRef, caller.projectRef) ? Effect.void : valueBar.checkSpawn(caller, input, ws.workstream),
    );

  const spawn: Tasks["Service"]["spawn"] = (caller, input) =>
    Effect.andThen(checkValueBar(caller, input), Effect.gen(function* () {
      const ref = caller.projectRef;
      const ws = yield* leadRecords.workstreams.get(input.workstreamId);
      if (ws === undefined || !sameProject(ws.workstream.projectRef, ref)) {
        return yield* new LeadError({
          code: "not_found",
          message: `No workstream ${input.workstreamId} in this project.`,
          fix: "Use a workstream id from your digest.",
        });
      }
      if (LeadRecords.CLOSED_STATES.includes(ws.workstream.state)) {
        return yield* new LeadError({
          code: "invalid",
          message: `Workstream ${input.workstreamId} is ${ws.workstream.state}; tasks run only for open workstreams.`,
        });
      }
      const policy = yield* policies.get(ref);
      const unknown = input.areas.filter((a) => policy.areas[a] === undefined);
      if (unknown.length > 0) {
        return yield* new LeadError({
          code: "invalid",
          message: `Unknown area${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}.`,
          fix: `Use areas from .fleetd/policy.yaml: ${Object.keys(policy.areas).join(", ")}.`,
        });
      }
      const { model, effort } = resolveModelEffort({ flag: input, policy: policy.defaults, project: yield* leadRecords.settings.get(ref) });
      const task = yield* records.create({
        projectRef: ref,
        workstreamId: input.workstreamId,
        title: input.title,
        kind: input.kind,
        prompt: input.prompt,
        areas: input.areas,
        model,
        effort,
        ...(input.tier === undefined ? {} : { tier: input.tier }),
        ...(input.estimateMinutes === undefined ? {} : { estimateMinutes: input.estimateMinutes }),
        ...(input.serves === undefined ? {} : { serves: input.serves }),
        ...(input.pr === undefined ? {} : { pr: input.pr }),
        ...(input.qa === undefined ? {} : { qa: input.qa }),
        state: "queued",
        attempt: 1,
        createdAt: yield* nowIso,
      });
      return yield* tryStart({ task }, false);
    }).pipe(lock.withPermit));

  const message: Tasks["Service"]["message"] = (caller, taskId, text) =>
    Effect.gen(function* () {
      const stored = yield* owned(caller, taskId);
      const { task } = stored;
      switch (task.state) {
        case "cancelled":
          return yield* new LeadError({ code: "invalid", message: `${taskId} was cancelled.`, fix: "Spawn a new task for the remaining work." });
        case "queued": {
          if (task.threadRef === undefined) {
            return yield* new LeadError({
              code: "invalid",
              message: `${taskId} has not started yet (${task.queuedReason ?? "queued"}).`,
              fix: `Wait for it to start, or \`fleetd task cancel ${taskId}\` and spawn it again with the new prompt.`,
            });
          }
          const pendingMessage = stored.pendingMessage === undefined ? text : `${stored.pendingMessage}\n\n${text}`;
          yield* records.put({ task, pendingMessage });
          return task;
        }
        case "running": {
          yield* executors.send(task.threadRef!, text, `fleetd-task:${taskId}:msg:${crypto.randomUUID()}`).pipe(Effect.mapError(fromExecutor));
          return task;
        }
        default:
          return yield* tryStart({ task: { ...task, attempt: task.attempt + 1 }, pendingMessage: text }, false);
      }
    }).pipe(lock.withPermit);

  const cancel: Tasks["Service"]["cancel"] = (caller, taskId, reason) =>
    Effect.gen(function* () {
      const stored = yield* owned(caller, taskId);
      const { task } = stored;
      if (task.state === "cancelled") return task;
      if (task.state === "done" || task.state === "failed") {
        return yield* new LeadError({ code: "invalid", message: `${taskId} already ended (${task.state}); there is nothing to cancel.` });
      }
      if (task.state === "running" && task.threadRef !== undefined) {
        const interrupted = yield* Effect.result(executors.interrupt(task.threadRef, `fleetd-task:${taskId}:cancel:${task.attempt}`));
        if (interrupted._tag === "Failure") yield* Effect.logWarning("task cancel: interrupt failed", { taskId, error: interrupted.failure._tag });
      }
      const at = yield* nowIso;
      const result: TaskResult = {
        status: "cancelled",
        tail: tailOf(reason ?? `Cancelled by ${caller.by}.`),
        ...(task.branch === undefined ? {} : { branch: task.branch }),
        at,
      };
      const next: Task = { ...without(task, "queuedReason"), state: "cancelled", result, endedAt: at };
      yield* records.put({ task: next });
      yield* releaseAll(task);
      yield* emit(next, "task.cancelled", `${taskId} cancelled: ${task.title}`);
      yield* retryQueue;
      return next;
    }).pipe(lock.withPermit);

  // The board also runs the listener once now, which picks up tasks queued before a restart.
  yield* slots.onRelease(retryLater);
  // The cursor is read here, not in the fiber, so nothing appended before the fiber first runs is missed.
  yield* Effect.forkScoped(follow(yield* events.head()));

  return Tasks.of({
    spawn,
    message,
    cancel,
    get: (taskId) => Effect.map(records.get(taskId), (s) => s?.task),
    list: records.list,
  });
});

/** Needs TaskRecords, LeadRecords, LeadWakes, HubStore, EventLog, Executors, ThreadWorkspace, Slots, Leases, Policies, ValueBar and Receipts. */
export const layer = Layer.effect(Tasks, make);
