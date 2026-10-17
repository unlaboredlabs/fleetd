// Test kit for tasks: the real store, event log, leads and ledger on an in-memory database under a TestClock,
// with fake executors, a fake ThreadWorkspace and in-memory slot, lease and policy ports.
import {
  type HubEventType,
  type MachineId,
  type PolicyFile,
  type ProjectId,
  type ProjectRef,
  type TaskId,
  type ThreadId,
  type ThreadLaunchInput,
  type WorkstreamId,
} from "@fleetd/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as Executors from "../executor/Executors.ts";
import { type ThreadChanges, ThreadWorkspace } from "../executor/ThreadWorkspace.ts";
import * as LeadsLayer from "../leads/layer.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as Leads from "../leads/Leads.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { type Grant, LeasePort, PolicyPort, SlotPort } from "./ports.ts";
import * as Tasks from "./Tasks.ts";

export const REF: ProjectRef = { machineId: "lab-a" as MachineId, projectId: "p1" as ProjectId };
export const LEAD = { projectRef: REF, by: "lead:lab-a/p1" };

export const POLICY: PolicyFile = {
  areas: { docs: ["docs/**"], hub: ["apps/hub/**", "packages/contracts/src/tasks.ts"] },
} as PolicyFile;

type LaunchInput = typeof ThreadLaunchInput.Type;

export const makeKit = (options: { readonly cap?: number; readonly policy?: PolicyFile } = {}) => {
  const launches: Array<{ readonly input: LaunchInput; readonly options: Executors.LaunchOptions | undefined }> = [];
  const sends: Array<{ readonly threadId: ThreadId; readonly message: string }> = [];
  const interrupts: Array<ThreadId> = [];
  const changes = new Map<string, ThreadChanges>();
  let offline = false;
  let live = Deferred.makeUnsafe<void>();

  const executors = Executors.Executors.of({
    attach: () => Effect.void,
    detach: () => Effect.void,
    isConnected: () => Effect.sync(() => !offline),
    awaitLive: () => Effect.suspend(() => (offline ? Deferred.await(live) : Effect.void)),
    launch: (machineId, input, launchOptions) =>
      Effect.suspend(() => {
        if (offline) return Effect.fail(new Executors.MachineNotConnected({ machineId }));
        launches.push({ input, options: launchOptions });
        return Effect.succeed({ threadId: `t${launches.length}` as ThreadId });
      }),
    send: (ref, message) =>
      Effect.sync(() => {
        sends.push({ threadId: ref.threadId, message });
        return { queued: false };
      }),
    interrupt: (ref) => Effect.sync(() => void interrupts.push(ref.threadId)),
    tail: (ref) => Effect.fail(new Executors.ThreadNotFound({ machineId: ref.machineId, threadId: ref.threadId })),
    actions: () =>
      Effect.succeed([
        { at: "1970-01-01T00:00:01.000Z", kind: "command", status: "completed", summary: "gh pr create --fill", outputTail: "https://github.com/wynn-dev/lab/pull/7", failed: false },
      ] as const),
  });

  const workspace = ThreadWorkspace.of({
    defaultBranch: () => Effect.succeed("main"),
    changes: (ref) => Effect.succeed(changes.get(ref.threadId) ?? { paths: [], pullRequestUrls: [] }),
  });

  // Slots: a plain global cap.
  const held = new Set<TaskId>();
  const released: Array<TaskId> = [];
  const listeners: Array<Effect.Effect<void>> = [];
  const slots = SlotPort.of({
    acquire: ({ holder }) =>
      Effect.sync((): Grant => {
        if (held.has(holder)) return { granted: true };
        const cap = options.cap ?? 40;
        if (held.size >= cap) return { granted: false, reason: `slots: ${held.size}/${cap} in use` };
        held.add(holder);
        return { granted: true };
      }),
    release: (holder) =>
      Effect.suspend(() => {
        if (!held.delete(holder)) return Effect.void;
        released.push(holder);
        return Effect.forEach(listeners, (l) => l, { discard: true });
      }),
    onRelease: (listener) => Effect.sync(() => void listeners.push(listener)),
  });

  // Leases: exclusive per area.
  const owners = new Map<string, TaskId>();
  const leases = LeasePort.of({
    acquire: ({ taskId, areas }) =>
      Effect.sync((): Grant => {
        const taken = areas.find((a) => owners.has(a) && owners.get(a) !== taskId);
        if (taken !== undefined) return { granted: false, reason: `lease: ${taken} held by ${owners.get(taken)}` };
        for (const a of areas) owners.set(a, taskId);
        return { granted: true };
      }),
    release: (taskId) =>
      Effect.sync(() => {
        for (const [a, t] of owners) if (t === taskId) owners.delete(a);
      }),
  });

  const policies = PolicyPort.of({ get: () => Effect.succeed(options.policy ?? POLICY) });

  const base = Layer.mergeAll(
    HubStore.layer,
    EventLog.layer,
    Layer.succeed(Executors.Executors, executors),
    Layer.succeed(ThreadWorkspace, workspace),
    Layer.succeed(SlotPort, slots),
    Layer.succeed(LeasePort, leases),
    Layer.succeed(PolicyPort, policies),
  ).pipe(Layer.provideMerge(HubDb.layerMemory), Layer.provideMerge(TestClock.layer()));
  const layer = Tasks.layer.pipe(
    Layer.provideMerge(LeadsLayer.layerWithLedger({ prompt: "You lead {{project}}." })),
    Layer.provideMerge(base),
  );

  /** A project with a started lead (thread t1) and an open workstream W1. */
  const setup = Effect.gen(function* () {
    yield* (yield* HubStore.HubStore).projects.upsertMany(REF.machineId, [
      {
        machineId: REF.machineId,
        projectId: REF.projectId,
        title: "Demo",
        workspaceRoot: "/w/p1",
        threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
        lastActivityAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
    yield* (yield* Leads.Leads).start(REF);
    const records = yield* LeadRecords.LeadRecords;
    const { workstream } = yield* records.workstreams.create({
      ref: REF,
      title: "docs",
      source: { text: "write docs", channel: "app", by: "human", at: "1970-01-01T00:00:00.000Z" },
    });
    yield* records.workstreams.put({
      workstream: {
        ...workstream,
        state: "running",
        brief: {
          goal: "a docs page",
          why: "people ask",
          pointers: [],
          constraints: [],
          doneWhen: [{ type: "pr_merged", repo: "wynn-dev/lab" }],
          tier: "S",
        },
      },
      amends: [],
    });
    return workstream.workstreamId as WorkstreamId;
  });

  /** What the executor does when a thread's run changes phase: the summary first, then the event. */
  const threadEvent = (threadId: string, type: HubEventType, text = "", lastError?: { class: string; message: string }) =>
    Effect.gen(function* () {
      yield* (yield* HubStore.HubStore).threads.upsert({
        machineId: REF.machineId,
        threadId: threadId as ThreadId,
        projectId: REF.projectId,
        title: "task",
        status: type === "thread.completed" ? "completed" : type === "thread.started" ? "running" : type === "thread.waiting" ? "waiting" : "failed",
        headline: text.split("\n", 1)[0]!.slice(0, 280),
        latestMessageTail: text,
        ...(lastError === undefined ? {} : { lastError }),
        lastProgressAt: "1970-01-01T00:00:00.000Z",
        stale: false,
        asOf: "1970-01-01T00:00:00.000Z",
      });
      yield* (yield* EventLog.EventLog).append({
        at: "1970-01-01T00:00:00.000Z",
        type,
        machineId: REF.machineId,
        projectId: REF.projectId,
        threadId: threadId as ThreadId,
        summary: `thread ${threadId} ${type}`,
      });
    });

  return {
    layer,
    launches,
    sends,
    interrupts,
    changes,
    held,
    released,
    owners,
    setup,
    threadEvent,
    setOffline: (value: boolean) =>
      Effect.suspend(() => {
        offline = value;
        if (value) return Effect.void;
        const done = live;
        live = Deferred.makeUnsafe<void>();
        return Deferred.succeed(done, undefined);
      }),
  };
};

export type Kit = ReturnType<typeof makeKit>;

export const runKit = <A, E>(kit: Kit, effect: Effect.Effect<A, E, Layer.Success<Kit["layer"]>>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, kit.layer)));

/** The first event of `type` after `cursor`, waiting for it; with `taskId`, only that task's. */
export const nextEvent = (cursor: number, type: HubEventType, taskId?: string) =>
  Effect.gen(function* () {
    const events = yield* EventLog.EventLog;
    let after = cursor;
    while (true) {
      const page = yield* events.wait({ cursor: after, types: [type], timeoutSec: 3600 });
      const found = page.events.find((e) => taskId === undefined || (e.data as { taskId?: string } | undefined)?.taskId === taskId);
      if (found !== undefined) return found;
      after = page.cursor;
    }
  });
