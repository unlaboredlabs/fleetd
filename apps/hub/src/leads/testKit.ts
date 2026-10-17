// Test kit for the leads area: the real store, event log and lead records on an in-memory database, under a
// TestClock, with the real ledger and fake executors.
import type { Ask, AskId, Decision, DecisionId, DecisionKey, MachineId, ProjectId, ProjectRef, ThreadId, ThreadLaunchInput } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as Executors from "../executor/Executors.ts";
import { Asks } from "../ledger/Asks.ts";
import { Inbox } from "../ledger/Inbox.ts";
import type { Actor } from "../ledger/LedgerRepo.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import * as LeadsLayer from "./layer.ts";
import type { LeadsOptions } from "./Leads.ts";

export const REF: ProjectRef = { machineId: "lab-a" as MachineId, projectId: "p1" as ProjectId };
export const OTHER: ProjectRef = { machineId: "lab-a" as MachineId, projectId: "p2" as ProjectId };

export const project = (ref: ProjectRef, title = "Demo") => ({
  machineId: ref.machineId,
  projectId: ref.projectId,
  title,
  workspaceRoot: `/w/${ref.projectId}`,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  lastActivityAt: "1970-01-01T00:00:00.000Z",
});

export const decision = (n: number, key: string, value: string, over: Partial<Decision> = {}): Decision =>
  ({
    decisionId: `D${n}` as DecisionId,
    key,
    scope: { kind: "project", projectRef: REF },
    value,
    source: "human",
    state: "active",
    at: `2026-10-17T10:${String(n % 60).padStart(2, "0")}:00.000Z`,
    ...over,
  }) as Decision;

export const ask = (n: number, key: string, over: Partial<Ask> = {}): Ask =>
  ({
    askId: `A${n}` as AskId,
    projectRef: REF,
    kind: "decide",
    key,
    class: "product",
    text: `Question ${n}?`,
    recommendation: "yes",
    blocks: "nothing",
    proceededOnRec: false,
    state: "open",
    createdAt: "2026-10-17T10:00:00.000Z",
    ...over,
  }) as Ask;

type LaunchInput = typeof ThreadLaunchInput.Type;

export const makeKit = (options: LeadsOptions = { prompt: "You are the lead of project {{project}} ({{projectRef}})." }) => {
  const launches: Array<{ readonly machineId: MachineId; readonly input: LaunchInput }> = [];
  const sends: Array<{ readonly threadId: ThreadId; readonly message: string; readonly clientRequestId: string }> = [];
  let offline = false;
  const liveWaiters: Array<() => void> = [];

  const executors = Executors.Executors.of({
    attach: () => Effect.void,
    detach: () => Effect.void,
    isConnected: () => Effect.succeed(!offline),
    awaitLive: () => Effect.suspend(() => (offline ? Effect.callback<void>((resume) => void liveWaiters.push(() => resume(Effect.void))) : Effect.void)),
    launch: (machineId, input) =>
      Effect.suspend(() => {
        if (offline) return Effect.fail(new Executors.MachineNotConnected({ machineId }));
        launches.push({ machineId, input });
        // Yields like a real round trip, so concurrent starts really interleave.
        return Effect.as(Effect.yieldNow, { threadId: `t${launches.length}` as ThreadId });
      }),
    send: (ref, message, clientRequestId) =>
      Effect.suspend(() => {
        if (offline) return Effect.fail(new Executors.MachineNotConnected({ machineId: ref.machineId }));
        sends.push({ threadId: ref.threadId, message, clientRequestId });
        return Effect.succeed({ queued: false });
      }),
    interrupt: () => Effect.void,
    tail: (ref) => Effect.fail(new Executors.ThreadNotFound({ machineId: ref.machineId, threadId: ref.threadId })),
    actions: () => Effect.succeed([]),
  });

  const base = Layer.mergeAll(HubStore.layer, EventLog.layer, Layer.succeed(Executors.Executors, executors)).pipe(
    Layer.provideMerge(HubDb.layerMemory),
    Layer.provideMerge(TestClock.layer()),
  );
  const layer = LeadsLayer.layerWithLedger(options).pipe(Layer.provideMerge(WriteQueue.layer()), Layer.provideMerge(base));

  return {
    layer,
    launches,
    sends,
    /** Going back online resumes whatever waits for the machine, such as the write queue. */
    setOffline: (value: boolean) => {
      offline = value;
      if (!value) for (const resume of liveWaiters.splice(0)) resume();
    },
    addProject: (ref: ProjectRef, title?: string) =>
      Effect.flatMap(HubStore.HubStore, (s) => s.projects.upsertMany(ref.machineId, [project(ref, title) as never])),
  };
};

export const runKit = <A, E>(kit: ReturnType<typeof makeKit>, effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeKit>["layer"]>>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, kit.layer)));

export const HUMAN: Actor = { source: "human", by: "human:phone" };
export const LEAD: Actor = { source: "lead", by: "lead:lab-a/p1" };

/** `fleetd ask` from the lead of REF: a product decide with a recommendation. */
export const fileAsk = (key: string, over: { readonly recommendation?: string; readonly text?: string } = {}) =>
  Effect.flatMap(Asks, (a) =>
    a.create(
      {
        projectRef: REF,
        kind: "decide",
        key: key as DecisionKey,
        class: "product",
        text: over.text ?? `${key}?`,
        recommendation: over.recommendation ?? "yes",
        blocks: "nothing",
        proceededOnRec: true,
      },
      LEAD.by,
    ),
  );

export const reply = (raw: string, actor: Actor = HUMAN) => Effect.flatMap(Inbox, (i) => i.reply({ raw }, actor));
