// Test kit for the leads area: the real store, event log and lead records on an in-memory database, under a
// TestClock, with fake executors and an in-memory ledger port.
import type { Ask, AskId, Decision, DecisionId, MachineId, ProjectId, ProjectRef, ThreadId, ThreadLaunchInput } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as Executors from "../executor/Executors.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import type { AnswerNote } from "./digest.ts";
import * as LeadsLayer from "./layer.ts";
import { LedgerPort } from "./LedgerPort.ts";
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
  const asks = new Map<string, Ask>();
  const decisions = new Map<string, Decision>();
  const handlers: Array<(note: AnswerNote) => Effect.Effect<void>> = [];
  let offline = false;

  const executors = Executors.Executors.of({
    attach: () => Effect.void,
    detach: () => Effect.void,
    isConnected: () => Effect.succeed(!offline),
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

  const ledger = LedgerPort.of({
    getAsk: (id) => Effect.sync(() => asks.get(id)),
    getDecision: (id) => Effect.sync(() => decisions.get(id)),
    openAsks: (ref) =>
      Effect.sync(() =>
        [...asks.values()].filter((a) => a.state === "open" && a.projectRef.machineId === ref.machineId && a.projectRef.projectId === ref.projectId),
      ),
    activeDecisions: (scopes) =>
      Effect.sync(() =>
        [...decisions.values()].filter(
          (d) => d.state === "active" && scopes.some((s) => JSON.stringify(s) === JSON.stringify(d.scope)),
        ),
      ),
    onAnswered: (handler) => Effect.sync(() => void handlers.push(handler)),
  });

  const base = Layer.mergeAll(HubStore.layer, EventLog.layer, Layer.succeed(Executors.Executors, executors), Layer.succeed(LedgerPort, ledger)).pipe(
    Layer.provideMerge(HubDb.layerMemory),
    Layer.provideMerge(TestClock.layer()),
  );
  const layer = LeadsLayer.layer(options).pipe(Layer.provideMerge(base));

  return {
    layer,
    launches,
    sends,
    asks,
    decisions,
    setOffline: (value: boolean) => void (offline = value),
    /** Plays the ledger committing a human answer. */
    answer: (note: AnswerNote) => Effect.forEach(handlers, (h) => h(note), { discard: true }),
    addProject: (ref: ProjectRef, title?: string) =>
      Effect.flatMap(HubStore.HubStore, (s) => s.projects.upsertMany(ref.machineId, [project(ref, title) as never])),
  };
};

export const runKit = <A, E>(kit: ReturnType<typeof makeKit>, effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeKit>["layer"]>>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, kit.layer)));
