// Test kit for this area: the real store, event log and auth on an in-memory database, with fake
// executors and node link (W2/W3) that record calls.
import type {
  ActionItem,
  DecisionKey,
  ProjectId,
  Grant,
  KeyKind,
  HubEvent,
  Machine,
  MachineId,
  ProjectSummary,
  Task,
  ThreadId,
  ThreadSummary,
  ThreadTailOutput,
} from "@fleetd/contracts";
import crypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Auth from "../auth/Auth.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Executors from "../executor/Executors.ts";
import * as NodeLinkServer from "../link/NodeLinkServer.ts";
import * as SecretBox from "../webhooks/SecretBox.ts";
import * as Webhooks from "../webhooks/Webhooks.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as Wakes from "../wakes/Wakes.ts";
import * as HumanDigests from "../digests/HumanDigests.ts";
import * as LeadsLayer from "../leads/layer.ts";
import { Asks } from "../ledger/Asks.ts";
import { ThreadWorkspace } from "../executor/ThreadWorkspace.ts";
import * as Leases from "../leases/Leases.ts";
import * as Policy from "../leases/Policy.ts";
import * as Slots from "../slots/Slots.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { UsageSource } from "../usage/UsageSource.ts";
import * as Incidents from "../incidents/Incidents.ts";
import * as Receipts from "../receipts/Receipts.ts";
import * as JudgeHook from "../valuebar/JudgeHook.ts";
import * as PrHeads from "../valuebar/PrHeads.ts";
import * as ValueBar from "../valuebar/ValueBar.ts";

export const AT = "2026-10-17T10:00:00.000Z";

export const machine = (id: string, status: Machine["status"] = "online", lastSeenAt = AT): Machine => ({
  machineId: id as MachineId,
  name: id,
  tags: [],
  status,
  lastSeenAt,
  t3: { version: "2fbd4318fc", protocol: 2 },
  nodeVersion: "0.0.0",
});

export const project = (machineId: string, projectId: string, lastActivityAt = AT): ProjectSummary =>
  ({
    machineId,
    projectId,
    title: projectId,
    workspaceRoot: `/w/${projectId}`,
    threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
    lastActivityAt,
  }) as ProjectSummary;

export const thread = (machineId: string, projectId: string, threadId: string, over: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    machineId,
    projectId,
    threadId,
    title: threadId,
    status: "completed",
    headline: "OK",
    latestMessageTail: "OK",
    lastProgressAt: AT,
    stale: false,
    asOf: AT,
    ...over,
  }) as ThreadSummary;

export const makeTestHub = () => {
  const connected = new Set<string>();
  const calls: Array<{ op: string; args: unknown }> = [];
  let tail: typeof ThreadTailOutput.Type | undefined;
  let actions: ReadonlyArray<ActionItem> = [];
  let waitCalls = 0;
  const waitWatchers: Array<{ count: number; resolve: () => void }> = [];
  const liveWaiters: Array<{ id: string; resolve: () => void }> = [];

  const executors = Executors.Executors.of({
    attach: () => Effect.void,
    detach: () => Effect.void,
    isConnected: (id) => Effect.sync(() => connected.has(id)),
    awaitLive: (id) =>
      connected.has(id) ? Effect.void : Effect.callback<void>((resume) => void liveWaiters.push({ id, resolve: () => resume(Effect.void) })),
    launch: (machineId, input) =>
      Effect.sync(() => {
        calls.push({ op: "launch", args: { machineId, input } });
        return { threadId: "t-new" as ThreadId };
      }),
    send: (ref, message, clientRequestId) =>
      Effect.sync(() => {
        calls.push({ op: "send", args: { ref, message, clientRequestId } });
        return { queued: false, runId: "r1" };
      }),
    interrupt: (ref, clientRequestId) => Effect.sync(() => void calls.push({ op: "interrupt", args: { ref, clientRequestId } })),
    tail: (ref) =>
      tail === undefined ? Effect.fail(new Executors.ThreadNotFound({ machineId: ref.machineId, threadId: ref.threadId })) : Effect.succeed(tail),
    actions: () => Effect.succeed(actions),
  });

  /** The real event log, counting `wait` calls so a test can act once a long-poll is in flight. */
  const layerWatchedEvents = Layer.effect(
    EventLog.EventLog,
    Effect.gen(function* () {
      const real = yield* EventLog.EventLog;
      return EventLog.EventLog.of({
        ...real,
        wait: (input) =>
          Effect.suspend(() => {
            waitCalls += 1;
            for (const w of waitWatchers.filter((w) => waitCalls >= w.count)) w.resolve();
            return real.wait(input);
          }),
      });
    }),
  ).pipe(Layer.provide(EventLog.layer));

  const posts: Array<Webhooks.WebhookRequest> = [];
  const postWatchers: Array<{ count: number; resolve: () => void }> = [];
  const layerWebhooks = Layer.effect(
    Webhooks.Webhooks,
    Webhooks.make({
      box: SecretBox.fromKey(crypto.randomBytes(32)),
      post: (request) =>
        Effect.sync(() => {
          posts.push(request);
          for (const w of postWatchers.filter((w) => posts.length >= w.count)) w.resolve();
          return 200;
        }),
    }),
  );

  // No policy file anywhere (one area "all"); worktrees start from main.
  const layerTasks = Tasks.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Slots.layer(), Leases.layer, Policy.layer, ValueBar.layer, Receipts.layer)),
    Layer.provideMerge(Layer.mergeAll(Incidents.layer, PrHeads.layerGh, JudgeHook.layerNoop)),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Policy.PolicySource, Policy.PolicySource.of({ read: () => Effect.succeed(undefined) })),
        Layer.succeed(
          ThreadWorkspace,
          ThreadWorkspace.of({
            defaultBranch: () => Effect.succeed("main"),
            changes: () => Effect.succeed({ paths: [], pullRequestUrls: [] }),
            pendingQuestion: () => Effect.succeed(undefined),
          }),
        ),
      ),
    ),
  );

  const layer = Layer.mergeAll(layerWebhooks, Wakes.layer, HumanDigests.layer).pipe(
    Layer.provideMerge(layerTasks),
    Layer.provideMerge(LeadsLayer.layerWithLedger({ prompt: "You lead {{project}}." })),
    Layer.provideMerge(WriteQueue.layer()),
    Layer.provideMerge(
      Layer.mergeAll(
        HubStore.layer,
        layerWatchedEvents,
        Auth.layer,
        Layer.succeed(Executors.Executors, executors),
        // A lab-style machine: a subscription login, its T3 on another host, so no trace file is read.
        Layer.succeed(UsageSource, UsageSource.of({ read: () => Effect.succeed({ login: "subscription", local: false }) })),
        Layer.succeed(NodeLinkServer.NodeLinkServer, NodeLinkServer.NodeLinkServer.of({ handle: () => Effect.void })),
      ),
    ),
    Layer.provideMerge(HubDb.layerMemory),
  );

  type Seeded = HubStore.HubStore | EventLog.EventLog | Auth.Auth | Asks | TaskRecords.TaskRecords;
  /** Set once the hub's layer is built, so seeding runs against the same database the server reads. */
  let context: Context.Context<Seeded> | undefined;
  const run = <A>(effect: Effect.Effect<A, unknown, Seeded>) => {
    if (context === undefined) throw new Error("start the hub first");
    return Effect.runPromise(Effect.provideContext(effect, context));
  };

  return {
    layer,
    bind: (built: Context.Context<Seeded>) => void (context = built),
    connected,
    /** Marks the machine connected and wakes whatever waits for it. */
    goLive: (id: string) => {
      connected.add(id);
      for (const w of liveWaiters.filter((w) => w.id === id)) {
        liveWaiters.splice(liveWaiters.indexOf(w), 1);
        w.resolve();
      }
    },
    calls,
    /** Webhook POSTs the hub made; every one is answered 200. */
    posts,
    /** Resolves once the hub has made `count` webhook POSTs in total. */
    posted: (count: number) => new Promise<void>((resolve) => (posts.length >= count ? resolve() : postWatchers.push({ count, resolve }))),
    setTail: (value: typeof ThreadTailOutput.Type) => void (tail = value),
    setActions: (value: ReadonlyArray<ActionItem>) => void (actions = value),
    /** Resolves once the event log has been waited on `count` times in total. */
    waitCalls: (count: number) => new Promise<void>((resolve) => (waitCalls >= count ? resolve() : waitWatchers.push({ count, resolve }))),
    addMachine: (m: Machine) => run(Effect.flatMap(HubStore.HubStore, (s) => s.machines.upsert(m))),
    addProjects: (machineId: string, projects: ReadonlyArray<ProjectSummary>) =>
      run(Effect.flatMap(HubStore.HubStore, (s) => s.projects.upsertMany(machineId as MachineId, projects))),
    addThread: (t: ThreadSummary & { readonly lastSequence?: number }) => run(Effect.flatMap(HubStore.HubStore, (s) => s.threads.upsert(t))),
    addKey: (name: string, grants: ReadonlyArray<Grant>, kind?: KeyKind) =>
      run(Effect.flatMap(Auth.Auth, (a) => a.createKey(name, grants, kind))).then(({ key, info }) => ({ key, keyId: info.keyId })),
    revoke: (keyId: string) => run(Effect.flatMap(Auth.Auth, (a) => a.revoke(keyId))),
    append: (event: Omit<HubEvent, "seq">) => run(Effect.flatMap(EventLog.EventLog, (e) => e.append(event))),
    /** A task record as Tasks would store it, without running anything. */
    addTask: (task: Omit<Task, "taskId">) => run(Effect.flatMap(TaskRecords.TaskRecords, (r) => r.create(task))),
    /** `fleetd ask` from the lead of a project: a product decide with a recommendation. */
    fileAsk: (machineId: string, projectId: string, key: string, recommendation: string) =>
      run(
        Effect.flatMap(Asks, (asks) =>
          asks.create(
            {
              projectRef: { machineId: machineId as MachineId, projectId: projectId as ProjectId },
              kind: "decide",
              key: key as DecisionKey,
              class: "product",
              text: `${key}?`,
              recommendation,
              blocks: "nothing",
              proceededOnRec: true,
            },
            `lead:${machineId}/${projectId}`,
          ),
        ),
      ),
  };
};
