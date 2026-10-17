// Test kit for tasks: the real store, event log, leads and ledger on an in-memory database under a TestClock,
// with the real slot board and leases, fake executors, a fake ThreadWorkspace and a policy file given as text.
import type { ActionItem, HubEventType, MachineId, ProjectId, ProjectRef, ThreadId, ThreadLaunchInput, WorkstreamId } from "@fleetd/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { NodeCommands, unlinked } from "../checks/NodeCommands.ts";
import * as Executors from "../executor/Executors.ts";
import * as Incidents from "../incidents/Incidents.ts";
import { type ThreadChanges, ThreadWorkspace } from "../executor/ThreadWorkspace.ts";
import * as LeadsLayer from "../leads/layer.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as Leads from "../leads/Leads.ts";
import * as Leases from "../leases/Leases.ts";
import * as Policy from "../leases/Policy.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as Receipts from "../receipts/Receipts.ts";
import * as Slots from "../slots/Slots.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import * as JudgeHook from "../valuebar/JudgeHook.ts";
import * as PrHeads from "../valuebar/PrHeads.ts";
import * as ValueBar from "../valuebar/ValueBar.ts";
import * as Tasks from "./Tasks.ts";

export const REF: ProjectRef = { machineId: "lab-a" as MachineId, projectId: "p1" as ProjectId };
export const LEAD = { projectRef: REF, by: "lead:lab-a/p1" };

export const POLICY = `areas:
  docs: ["docs/**"]
  hub: ["apps/hub/**", "packages/contracts/src/tasks.ts"]
`;

type LaunchInput = typeof ThreadLaunchInput.Type;

/** `policy` is the text of .fleetd/policy.yaml. */
export const makeKit = (options: { readonly cap?: number; readonly policy?: string } = {}) => {
  const launches: Array<{ readonly input: LaunchInput; readonly options: Executors.LaunchOptions | undefined }> = [];
  const sends: Array<{ readonly threadId: ThreadId; readonly message: string }> = [];
  const interrupts: Array<ThreadId> = [];
  const changes = new Map<string, ThreadChanges>();
  /** PR URL → its head SHA as GitHub would report it; unknown PRs fail like an unauthenticated `gh`. */
  const prHeads = new Map<string, string>();
  /** Thread id → its actions; threads not in it ran one `gh pr create`. */
  const actions = new Map<string, ReadonlyArray<ActionItem>>();
  const questions = new Map<string, string>();
  /** Task branch → the files its PR diff names, as the node's `git diff --name-only` would; unknown branches fail. */
  const branchDiffs = new Map<string, ReadonlyArray<string>>();
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
    actions: (ref) =>
      Effect.succeed(
        actions.get(ref.threadId) ?? [
          { at: "1970-01-01T00:00:01.000Z", kind: "command", status: "completed", summary: "gh pr create --fill", outputTail: "https://github.com/wynn-dev/lab/pull/7", failed: false },
        ],
      ),
  });

  const workspace = ThreadWorkspace.of({
    defaultBranch: () => Effect.succeed("main"),
    changes: (ref) => Effect.succeed(changes.get(ref.threadId) ?? { paths: [], pullRequestUrls: [] }),
    pendingQuestion: (ref) => Effect.succeed(questions.get(ref.threadId)),
  });

  const policySource = Policy.PolicySource.of({ read: () => Effect.succeed(options.policy ?? POLICY) });

  const base = Layer.mergeAll(
    HubStore.layer,
    EventLog.layer,
    Layer.succeed(Executors.Executors, executors),
    Layer.succeed(ThreadWorkspace, workspace),
    Layer.succeed(Policy.PolicySource, policySource),
  ).pipe(Layer.provideMerge(HubDb.layerMemory), Layer.provideMerge(TestClock.layer()));
  const prHeadsFake = PrHeads.PrHeads.of({
    headSha: (pr) => {
      const sha = prHeads.get(pr);
      return sha === undefined ? Effect.fail(new PrHeads.PrHeadError({ pr, message: "gh: not logged in" })) : Effect.succeed(sha);
    },
  });

  const node = NodeCommands.of({
    run: (_machineId, input) =>
      Effect.sync(() => {
        const paths = branchDiffs.get(input.argv.at(-1) ?? "");
        return paths === undefined ? { exitCode: 128, outputTail: "fatal: bad revision", timedOut: false } : { exitCode: 0, outputTail: `${paths.join("\n")}\n`, timedOut: false };
      }),
    deliverSecret: unlinked,
    runGated: unlinked,
    attach: () => Effect.void,
    resolve: () => Effect.void,
  });

  const layer = Tasks.layer.pipe(
    Layer.provide(Layer.succeed(NodeCommands, node)),
    Layer.provideMerge(
      Layer.mergeAll(Slots.layer({ defaultCap: options.cap ?? 40 }), Leases.layer, Policy.layer, ValueBar.layer, Receipts.layer),
    ),
    Layer.provideMerge(Layer.mergeAll(Incidents.layer, Layer.succeed(PrHeads.PrHeads, prHeadsFake), JudgeHook.layerNoop)),
    Layer.provideMerge(LeadsLayer.layerWithLedger({ prompt: "You lead {{project}}." })),
    Layer.provideMerge(WriteQueue.layer()),
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
    branchDiffs,
    prHeads,
    actions,
    /** Thread id → what it is waiting on a human for. */
    questions,
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

/** Slots held now, across projects. */
export const slotsUsed = Effect.gen(function* () {
  const state = yield* (yield* Slots.Slots).state();
  return state.used;
});

/** Area → task, for REF. */
export const leaseOwners = Effect.map(
  Effect.flatMap(Leases.Leases, (l) => l.list({ projectRef: REF })),
  (leases) => Object.fromEntries(leases.map((l) => [l.area, l.taskId])),
);

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
