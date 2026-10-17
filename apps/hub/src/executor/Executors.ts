// Per-machine T3 clients. Each attached machine gets one supervised connection that follows T3's shell
// stream into HubStore (thread/project caches) and EventLog (derived events, on transitions only).
// Thread transcripts are read on demand (tail, actions, headlines) and dropped after 60 s unused.
import {
  type ActionItem,
  type MachineId,
  ProjectId,
  type TailKind,
  ThreadId,
  type ThreadLaunchInput,
  type ThreadRef,
  type ThreadSummary,
  type ThreadTailOutput,
} from "@fleetd/contracts";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS as M,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId as T3ProjectId,
  ProviderInstanceId,
  ThreadId as T3ThreadId,
  TurnItemId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import {
  applyShellItem,
  emptyShellState,
  removedProjects,
  type ShellState,
  transitionEvent,
  withAssistantText,
} from "./ShellMapper.ts";
import { connect, type T3Client } from "./T3Connection.ts";
import { openTool, ThreadWatch } from "./ThreadWatch.ts";
import { WorkspaceFiles } from "./WorkspaceFiles.ts";
import { effortOption, FLEETD_INSTANCE, ProviderList, routeModel, toInstance } from "./ProviderList.ts";
import { isLoopbackUrl, loginKindOf, UsageSource } from "../usage/UsageSource.ts";
import { ThreadWorkspace } from "./ThreadWorkspace.ts";
import {
  actionsOf,
  activeRunId,
  applyThreadItem,
  emptyView,
  latestAssistantText,
  omittedOutputs,
  pendingQuestionText,
  tailOf,
  type ThreadView,
  toAction,
} from "./ThreadView.ts";

export class MachineNotConnected extends Schema.TaggedError<MachineNotConnected>()("MachineNotConnected", {
  machineId: Schema.String,
}) {
  override get message(): string {
    return `machine ${this.machineId} has no live T3 connection`;
  }
}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()("ThreadNotFound", {
  machineId: Schema.String,
  threadId: Schema.String,
}) {
  override get message(): string {
    return `thread ${this.threadId} is not known on machine ${this.machineId}`;
  }
}

export class T3RequestFailed extends Schema.TaggedError<T3RequestFailed>()("T3RequestFailed", {
  machineId: Schema.String,
  operation: Schema.Literals(["launch", "send", "interrupt", "read"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `T3 on ${this.machineId} refused or failed the ${this.operation} request`;
  }
}

export type ExecutorError = MachineNotConnected | ThreadNotFound | T3RequestFailed;
type LaunchInput = typeof ThreadLaunchInput.Type;
export interface LaunchOptions {
  /** Default: the project root. Tasks launch writers in a new worktree on their own branch. */
  readonly workspace?: OrchestrationV2ThreadLaunchWorkspaceStrategy;
}
type TailOutput = typeof ThreadTailOutput.Type;

export class Executors extends Context.Service<
  Executors,
  {
    /** (Re)connects. Idempotent for the same URL and bearer; a new bearer reconnects with it. */
    readonly attach: (machineId: MachineId, session: { readonly t3Url: string; readonly bearer: string }) => Effect.Effect<void>;
    /** Drops the connection. The machine's shell state is kept, so a later attach resumes from its cursor. */
    readonly detach: (machineId: MachineId) => Effect.Effect<void>;
    readonly isConnected: (machineId: MachineId) => Effect.Effect<boolean>;
    /** Returns once the machine has a live T3 connection, at once if it has one now. */
    readonly awaitLive: (machineId: MachineId) => Effect.Effect<void>;
    readonly launch: (
      machineId: MachineId,
      input: LaunchInput,
      options?: LaunchOptions,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, ExecutorError>;
    readonly send: (
      ref: ThreadRef,
      message: string,
      clientRequestId: string,
    ) => Effect.Effect<{ readonly runId?: string; readonly queued: boolean }, ExecutorError>;
    readonly interrupt: (ref: ThreadRef, clientRequestId: string) => Effect.Effect<void, ExecutorError>;
    /** Newest first. */
    readonly tail: (ref: ThreadRef, n: number, kinds?: ReadonlyArray<typeof TailKind.Type>) => Effect.Effect<TailOutput, ExecutorError>;
    /** Newest first. */
    readonly actions: (ref: ThreadRef, limit: number, failedOnly?: boolean) => Effect.Effect<ReadonlyArray<ActionItem>, ExecutorError>;
  }
>()("fleetd/executor/Executors") {}

/** Reconnect delay: doubles from 1 s to a 30 s cap, ±25 % jitter so machines don't reconnect in step. */
export const backoffMs = (attempt: number, random: number) =>
  Math.min(30_000, Math.round(1000 * 2 ** Math.min(attempt, 5) * (0.75 + random * 0.5)));

const WATCH_IDLE_MS = 60_000;
const READ_TIMEOUT = Duration.seconds(15);

interface Watch {
  readonly view: ThreadView;
  readonly ready: Deferred.Deferred<void, T3RequestFailed>;
  lastUsedMs: number;
  /** Any frame but "synchronized" counts as progress; starts at the stream's opening. */
  lastFrameMs: number;
  /** Followed by the watchdog: stays open however long nobody reads it. */
  pinned: boolean;
}

interface Machine {
  t3Url: string;
  bearer: string;
  supervisor: Fiber.Fiber<never> | undefined;
  /** Set while a socket is open and the shell stream has delivered its first item. */
  live: { readonly client: T3Client; readonly scope: Scope.Scope } | undefined;
  readonly shell: ShellState;
  readonly watches: Map<string, Watch>;
}

const errorTag = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause);
  return typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "unknown";
};

const make = Effect.gen(function* () {
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const layerScope = yield* Effect.scope;
  const machines = new Map<string, Machine>();
  /** Completed when the machine next goes live. */
  const liveWaiters = new Map<string, Deferred.Deferred<void>>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const liveOf = (machineId: MachineId) => {
    const live = machines.get(machineId)?.live;
    return live === undefined ? Effect.fail(new MachineNotConnected({ machineId })) : Effect.succeed(live);
  };

  /** Drops a watch once it is unpinned and nobody has read it for WATCH_IDLE_MS. */
  const idleDrop = (watch: Watch) =>
    Effect.gen(function* () {
      while (true) {
        const idle = (yield* Clock.currentTimeMillis) - watch.lastUsedMs;
        if (idle >= WATCH_IDLE_MS && !watch.pinned) return;
        yield* Effect.sleep(Duration.millis(watch.pinned ? WATCH_IDLE_MS : WATCH_IDLE_MS - idle));
      }
    });

  /** The thread's live view, opening a bounded `subscribeThread` if none is open. */
  const view = (machineId: MachineId, threadId: string) =>
    Effect.gen(function* () {
      const live = yield* liveOf(machineId);
      const machine = machines.get(machineId)!;
      const now = yield* Clock.currentTimeMillis;
      let watch = machine.watches.get(threadId);
      if (watch === undefined) {
        const w: Watch = { view: emptyView(), ready: Deferred.makeUnsafe(), lastUsedMs: now, lastFrameMs: now, pinned: false };
        watch = w;
        machine.watches.set(threadId, w);
        yield* live.client[M.subscribeThread]({ threadId: T3ThreadId.make(threadId), acceptBoundedSnapshot: true }).pipe(
          Stream.runForEach((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") w.lastFrameMs = yield* Clock.currentTimeMillis;
              applyThreadItem(w.view, item);
              if (w.view.ready) yield* Deferred.succeed(w.ready, undefined);
            }),
          ),
          Effect.raceFirst(idleDrop(w)),
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (machine.watches.get(threadId) === w) machine.watches.delete(threadId);
              return Deferred.fail(w.ready, new T3RequestFailed({ machineId, operation: "read", cause: exit }));
            }),
          ),
          Effect.ignore,
          Effect.forkIn(live.scope),
        );
      }
      watch.lastUsedMs = now;
      yield* Deferred.await(watch.ready).pipe(
        Effect.timeoutOrElse({
          duration: READ_TIMEOUT,
          orElse: () => Effect.fail(new T3RequestFailed({ machineId, operation: "read", cause: "timeout" })),
        }),
      );
      return watch.view;
    });

  /** Fills in command output the bounded snapshot withheld, for the items about to be returned. */
  const fillOutputs = (machineId: MachineId, threadId: string, v: ThreadView, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const live = yield* liveOf(machineId);
      yield* Effect.forEach(
        omittedOutputs(v, ids),
        (itemId) =>
          live.client[M.getTurnItem]({ threadId: T3ThreadId.make(threadId), itemId: TurnItemId.make(itemId) }).pipe(
            Effect.tap((r) => Effect.sync(() => r.item && v.items.set(itemId, r.item))),
            Effect.mapError((cause) => new T3RequestFailed({ machineId, operation: "read", cause })),
          ),
        { concurrency: 4, discard: true },
      );
    });

  const summaryOf = (ref: ThreadRef) =>
    Effect.gen(function* () {
      const known = machines.get(ref.machineId)?.shell.threads.get(ref.threadId)?.summary;
      const summary: ThreadSummary | undefined = known ?? (yield* store.threads.get(ref));
      if (summary === undefined) return yield* new ThreadNotFound(ref);
      const { lastSequence: _, ...plain } = summary as HubStore.StoredThread;
      return plain;
    });

  const threadIdsOf = (item: OrchestrationV2ShellStreamItem): ReadonlyArray<string> =>
    item.kind === "snapshot" ? item.snapshot.threads.map((t) => t.id) : item.kind === "thread.updated" ? [item.thread.id] : [];

  const handleShellItem = (machineId: MachineId, machine: Machine, item: OrchestrationV2ShellStreamItem, baseline: boolean) =>
    Effect.gen(function* () {
      const stored = new Map<string, HubStore.StoredThread>();
      for (const id of threadIdsOf(item)) {
        if (machine.shell.threads.has(id)) continue;
        const s = yield* store.threads.get({ machineId, threadId: ThreadId.make(id) });
        if (s !== undefined) stored.set(id, s);
      }
      const applied = applyShellItem(machine.shell, item, { machineId, now: yield* nowIso, stored, baseline });
      const upserts = new Map(applied.threads.map((t) => [t.threadId as string, t]));
      // Shell rows carry no assistant text, so a run that ended or paused gets its headline from a thread read.
      for (const t of applied.transitions) {
        if (t.type === "thread.started") continue;
        const v = yield* view(machineId, t.threadId).pipe(Effect.option);
        const tracked = machine.shell.threads.get(t.threadId);
        if (v._tag === "None" || tracked === undefined) continue;
        const summary = withAssistantText(tracked.summary, latestAssistantText(v.value));
        if (summary === tracked.summary) continue;
        machine.shell.threads.set(t.threadId, { ...tracked, summary });
        // Keeps the row's lastSequence and run fields, if this item set them.
        upserts.set(t.threadId, { ...upserts.get(t.threadId), ...summary });
      }
      for (const t of upserts.values()) yield* store.threads.upsert(t);
      if (applied.projects.length > 0) yield* store.projects.upsertMany(machineId, applied.projects);
      if (item.kind === "project.removed" || item.kind === "snapshot") {
        const cached = yield* store.projects.list({ machineId });
        for (const projectId of removedProjects(machine.shell, item, cached.map((p) => p.projectId))) {
          const title = cached.find((p) => p.projectId === projectId)?.title ?? projectId;
          yield* store.projects.remove({ machineId, projectId: ProjectId.make(projectId) });
          yield* events.append({
            at: yield* nowIso,
            type: "project.removed",
            machineId,
            projectId: ProjectId.make(projectId),
            summary: `Project "${title}" on ${machineId} was deleted in T3`.slice(0, 200),
            data: { title },
          });
        }
      }
      for (const t of applied.transitions) {
        const tracked = machine.shell.threads.get(t.threadId);
        if (tracked !== undefined) yield* events.append(transitionEvent(t, tracked, machineId));
      }
      if (applied.cursor !== undefined) yield* store.cursors.set(machineId, applied.cursor);
    });

  /** One socket's lifetime: connect, follow the shell stream until it fails or ends. */
  const runConnection = (machineId: MachineId, machine: Machine, onLive: () => void) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const client = yield* connect(machine.t3Url, machine.bearer);
      const cursor = yield* store.cursors.get(machineId);
      // A replay only carries changed rows, and project counts need every row, so the first stream in this
      // process starts from a snapshot; it is diffed against the stored summaries, so nothing is missed.
      const afterSequence = machine.shell.complete ? cursor : undefined;
      const baseline = cursor === undefined;
      yield* client[M.subscribeShell](afterSequence === undefined ? {} : { afterSequence }).pipe(
        Stream.runForEach((item) =>
          Effect.suspend(() => {
            if (machine.live === undefined) {
              machine.live = { client, scope };
              onLive();
              const waiter = liveWaiters.get(machineId);
              liveWaiters.delete(machineId);
              if (waiter !== undefined) Deferred.doneUnsafe(waiter, Effect.void);
            }
            return handleShellItem(machineId, machine, item, baseline);
          }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          machine.live = undefined;
          machine.watches.clear();
        }),
      ),
    );

  const supervise = (machineId: MachineId, machine: Machine) =>
    Effect.gen(function* () {
      let attempt = 0;
      while (true) {
        const exit = yield* runConnection(machineId, machine, () => void (attempt = 0)).pipe(Effect.exit);
        const delay = backoffMs(attempt++, yield* Random.next);
        // The cause can carry the ws URL with its one-time ticket, so log only its tag.
        yield* Effect.logWarning("T3 connection lost; reconnecting", {
          machineId,
          reason: exit._tag === "Failure" ? errorTag(exit.cause) : "stream ended",
          retryInMs: delay,
        });
        yield* Effect.sleep(Duration.millis(delay));
      }
    });

  const stop = (machine: Machine) =>
    Effect.suspend(() => {
      const fiber = machine.supervisor;
      machine.supervisor = undefined;
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

  const attach: Executors["Service"]["attach"] = (machineId, session) =>
    Effect.gen(function* () {
      let machine = machines.get(machineId);
      if (machine?.supervisor !== undefined && machine.t3Url === session.t3Url && machine.bearer === session.bearer) return;
      if (machine === undefined) {
        machine = { ...session, supervisor: undefined, live: undefined, shell: emptyShellState(), watches: new Map() };
        machines.set(machineId, machine);
      }
      yield* stop(machine);
      machine.t3Url = session.t3Url;
      machine.bearer = session.bearer;
      machine.supervisor = yield* supervise(machineId, machine).pipe(Effect.forkIn(layerScope));
    });

  const detach: Executors["Service"]["detach"] = (machineId) =>
    Effect.suspend(() => {
      const machine = machines.get(machineId);
      return machine === undefined ? Effect.void : stop(machine);
    });

  const providers = ProviderList.of({
    instances: (machineId) =>
      Effect.gen(function* () {
        const { client } = yield* liveOf(machineId);
        const config = yield* client[WS_METHODS.serverGetConfig]({}).pipe(
          Effect.timeout(READ_TIMEOUT),
          Effect.mapError((cause) => new T3RequestFailed({ machineId, operation: "read", cause })),
        );
        return config.providers.map(toInstance);
      }),
  });

  // M4 usage: the fleetd instance's login kind and T3's logs directory, for usage_status. Env var names only.
  const usageSource = UsageSource.of({
    read: (machineId) =>
      Effect.gen(function* () {
        const { client } = yield* liveOf(machineId);
        const config = yield* client[WS_METHODS.serverGetConfig]({}).pipe(
          Effect.timeout(READ_TIMEOUT),
          Effect.mapError((cause) => new T3RequestFailed({ machineId, operation: "read", cause })),
        );
        const fleetd = config.providers.find((p) => p.instanceId === FLEETD_INSTANCE);
        return {
          login: loginKindOf(fleetd, config.settings.providerInstances[FLEETD_INSTANCE as ProviderInstanceId]),
          logsDir: config.observability.logsDirectoryPath,
          local: isLoopbackUrl(machines.get(machineId)?.t3Url ?? ""),
        };
      }),
  });

  /** Claude models go straight to the fleetd instance; anything else looks at the provider list, falling back to fleetd. */
  const routeOf = (machineId: MachineId, model: string) =>
    model.startsWith("claude")
      ? Effect.succeed(routeModel([], model))
      : providers.instances(machineId).pipe(
          Effect.map((list) => routeModel(list, model)),
          Effect.orElseSucceed(() => routeModel([], model)),
        );

  const launch: Executors["Service"]["launch"] = (machineId, input, options) =>
    Effect.gen(function* () {
      const { client } = yield* liveOf(machineId);
      const route = yield* routeOf(machineId, input.model);
      const title = input.title?.trim() || input.prompt.trim().split("\n", 1)[0]!.slice(0, 80);
      const result = yield* client[M.launchThread]({
        // T3 keeps a receipt per command id, so a retried launch returns the same thread.
        commandId: CommandId.make(input.clientRequestId),
        projectId: T3ProjectId.make(input.projectId),
        title,
        generateTitle: false,
        // The "fleetd" instance (its launch args deny T3's own spawn tools) unless only Codex has the model; explicit effort.
        modelSelection: {
          instanceId: ProviderInstanceId.make(route.instanceId),
          model: input.model,
          options: [effortOption(route.driver, input.effort)],
        },
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: options?.workspace ?? { type: "root" },
        initialMessage: { text: input.prompt, attachments: [] },
      }).pipe(Effect.mapError((cause) => new T3RequestFailed({ machineId, operation: "launch", cause })));
      return { threadId: ThreadId.make(result.threadId) };
    });

  const send: Executors["Service"]["send"] = (ref, message, clientRequestId) =>
    Effect.gen(function* () {
      const { client } = yield* liveOf(ref.machineId);
      const tracked = machines.get(ref.machineId)?.shell.threads.get(ref.threadId);
      yield* client[M.dispatchCommand]({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(clientRequestId),
        threadId: T3ThreadId.make(ref.threadId),
        messageId: MessageId.make(crypto.randomUUID()),
        text: message,
        attachments: [],
        // T3 picks: start a run if idle, steer a running one, queue behind one still starting.
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
      }).pipe(Effect.mapError((cause) => new T3RequestFailed({ machineId: ref.machineId, operation: "send", cause })));
      const active = tracked?.activeRunId ?? null;
      if (active === null) return { queued: false };
      return tracked?.activeRunStarting ? { queued: true } : { runId: active, queued: false };
    });

  const interrupt: Executors["Service"]["interrupt"] = (ref, clientRequestId) =>
    Effect.gen(function* () {
      const { client } = yield* liveOf(ref.machineId);
      const runId =
        machines.get(ref.machineId)?.shell.threads.get(ref.threadId)?.activeRunId ??
        activeRunId(yield* view(ref.machineId, ref.threadId));
      if (runId == null) return;
      yield* client[M.dispatchCommand]({
        type: "run.interrupt",
        commandId: CommandId.make(clientRequestId),
        threadId: T3ThreadId.make(ref.threadId),
        runId: runId as never,
        reason: "interrupted through fleetd",
      }).pipe(Effect.mapError((cause) => new T3RequestFailed({ machineId: ref.machineId, operation: "interrupt", cause })));
    });

  const tail: Executors["Service"]["tail"] = (ref, n, kinds) =>
    Effect.gen(function* () {
      const summary = yield* summaryOf(ref);
      const v = yield* view(ref.machineId, ref.threadId);
      const first = tailOf(v, n, kinds);
      const actionIds = first.rows.flatMap((r) => (r.kind === "action" ? [r.id] : []));
      yield* fillOutputs(ref.machineId, ref.threadId, v, actionIds);
      const items = first.rows.map(({ id, ...row }) => {
        if (row.kind !== "action") return row;
        const item = v.items.get(id);
        const action = item === undefined ? undefined : toAction(item);
        return action === undefined ? row : { ...row, action };
      });
      return {
        items,
        thread: withAssistantText(summary, latestAssistantText(v)),
        ...(first.truncated ? { truncated: true } : {}),
      };
    });

  const actions: Executors["Service"]["actions"] = (ref, limit, failedOnly) =>
    Effect.gen(function* () {
      yield* summaryOf(ref);
      const v = yield* view(ref.machineId, ref.threadId);
      const picked = actionsOf(v, limit, failedOnly);
      yield* fillOutputs(ref.machineId, ref.threadId, v, picked.map((a) => a.id));
      return picked.map((a) => {
        const item = v.items.get(a.id);
        return (item && toAction(item)) ?? a.action;
      });
    });

  const watch = ThreadWatch.of({
    running: () =>
      Effect.sync(() =>
        [...machines].flatMap(([machineId, machine]) =>
          machine.live === undefined
            ? []
            : [...machine.shell.threads].flatMap(([threadId, t]) => {
                const runId = t.activeRunId ?? t.runId;
                return t.summary.status === "running" && runId != null
                  ? [{ ref: { machineId: machineId as MachineId, threadId: ThreadId.make(threadId) }, runId }]
                  : [];
              }),
        ),
      ),
    latestRun: (ref) =>
      Effect.sync(() => {
        const t = machines.get(ref.machineId)?.shell.threads.get(ref.threadId);
        return t === undefined ? undefined : { runId: t.activeRunId ?? t.runId ?? null, running: t.summary.status === "running" };
      }),
    follow: (ref) =>
      Effect.gen(function* () {
        yield* view(ref.machineId, ref.threadId);
        const w = machines.get(ref.machineId)?.watches.get(ref.threadId);
        if (w !== undefined) w.pinned = true;
      }),
    release: (ref) =>
      Effect.gen(function* () {
        const w = machines.get(ref.machineId)?.watches.get(ref.threadId);
        if (w === undefined) return;
        w.pinned = false;
        w.lastUsedMs = yield* Clock.currentTimeMillis;
      }),
    progress: (ref) =>
      Effect.sync(() => {
        const machine = machines.get(ref.machineId);
        const w = machine?.watches.get(ref.threadId);
        if (w === undefined || !w.view.ready) return undefined;
        const tool = openTool(w.view, machine?.shell.threads.get(ref.threadId)?.activeRunId ?? undefined);
        return tool === undefined ? { lastFrameMs: w.lastFrameMs } : { lastFrameMs: w.lastFrameMs, tool };
      }),
  });

  const files = WorkspaceFiles.of({
    read: (machineId, cwd, relativePath) =>
      Effect.gen(function* () {
        const { client } = yield* liveOf(machineId);
        return yield* client[WS_METHODS.projectsReadFile]({ cwd, relativePath }).pipe(
          Effect.map((r): string | undefined => r.contents),
          // T3 resolves the target's real path first, so a missing file fails there.
          Effect.catchTag("ProjectReadFileError", (error) =>
            error.operation === "realpath-target"
              ? Effect.succeed(undefined)
              : Effect.fail(new T3RequestFailed({ machineId, operation: "read", cause: error })),
          ),
          Effect.mapError((cause) =>
            cause instanceof T3RequestFailed ? cause : new T3RequestFailed({ machineId, operation: "read", cause }),
          ),
        );
      }),
  });

  const readFailed = (machineId: MachineId) => (cause: unknown) => new T3RequestFailed({ machineId, operation: "read", cause });

  const workspace = ThreadWorkspace.of({
    defaultBranch: (machineId, cwd) =>
      Effect.gen(function* () {
        const { client } = yield* liveOf(machineId);
        const { refs } = yield* client[WS_METHODS.vcsListRefs]({ cwd, refKind: "local", limit: 200 }).pipe(
          Effect.mapError(readFailed(machineId)),
        );
        const local = refs.filter((r) => r.isRemote !== true);
        const ref = local.find((r) => r.isDefault) ?? local.find((r) => r.current);
        if (ref === undefined) return yield* new T3RequestFailed({ machineId, operation: "read", cause: `no local branch at ${cwd}` });
        return ref.name;
      }),
    changes: (ref) =>
      Effect.gen(function* () {
        const { client } = yield* liveOf(ref.machineId);
        const p = yield* client[M.getThreadProjection]({ threadId: T3ThreadId.make(ref.threadId) }).pipe(
          Effect.mapError(readFailed(ref.machineId)),
        );
        const paths = [...new Set(p.checkpoints.flatMap((c) => c.files.map((f) => f.path)))].sort();
        const urls = (p.thread.pullRequests ?? []).filter((l) => l.source !== "stack-dismissed").map((l) => l.url);
        if (p.thread.linkedPullRequest) urls.push(p.thread.linkedPullRequest.url);
        return {
          ...(p.thread.branch === null ? {} : { branch: p.thread.branch }),
          ...(p.thread.worktreePath === null ? {} : { worktreePath: p.thread.worktreePath }),
          paths,
          pullRequestUrls: [...new Set(urls)],
        };
      }),
    pendingQuestion: (ref) =>
      Effect.gen(function* () {
        const { client } = yield* liveOf(ref.machineId);
        const p = yield* client[M.getThreadProjection]({ threadId: T3ThreadId.make(ref.threadId) }).pipe(
          Effect.mapError(readFailed(ref.machineId)),
        );
        return pendingQuestionText(p);
      }),
  });

  return {
    files,
    workspace,
    providers,
    usageSource,
    executors: Executors.of({
      attach,
      detach,
      isConnected: (machineId) => Effect.sync(() => machines.get(machineId)?.live !== undefined),
      awaitLive: (machineId) =>
        Effect.suspend(() => {
          if (machines.get(machineId)?.live !== undefined) return Effect.void;
          let waiter = liveWaiters.get(machineId);
          if (waiter === undefined) {
            waiter = Deferred.makeUnsafe<void>();
            liveWaiters.set(machineId, waiter);
          }
          return Deferred.await(waiter);
        }),
      launch,
      send,
      interrupt,
      tail,
      actions,
    }),
    watch,
  };
});

/**
 * Provides Executors, the ThreadWatch the watchdog follows running threads through, WorkspaceFiles, ThreadWorkspace for
 * tasks, each machine's ProviderList, and the UsageSource behind usage_status.
 */
export const layer = Layer.effectContext(
  Effect.map(make, ({ executors, watch, files, workspace, providers, usageSource }) =>
    Context.make(Executors, executors).pipe(
      Context.add(ThreadWatch, watch),
      Context.add(WorkspaceFiles, files),
      Context.add(ThreadWorkspace, workspace),
      Context.add(ProviderList, providers),
      Context.add(UsageSource, usageSource),
    ),
  ),
);
