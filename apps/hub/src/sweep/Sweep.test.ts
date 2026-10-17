import { MachineId, ProjectId, ThreadId, type Machine } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { Watchdog } from "../watchdog/Watchdog.ts";
import * as SweepModule from "./Sweep.ts";
import { Sweep } from "./Sweep.ts";

const AT = "2026-10-17T10:00:00.000Z";
const machine = (id: string, status: Machine["status"], lastSeenAt = AT): Machine => ({
  machineId: MachineId.make(id),
  name: id,
  tags: [],
  status,
  lastSeenAt,
  t3: null,
  nodeVersion: "0.0.0",
});
const thread = (machineId: string, threadId: string, status: "running" | "completed") => ({
  machineId: MachineId.make(machineId),
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("p1"),
  title: threadId,
  status,
  headline: "",
  latestMessageTail: "",
  lastProgressAt: AT,
  stale: false,
  asOf: AT,
});

const run = (body: (resubscribes: { count: number }) => Effect.Effect<void, never, Sweep | HubStore.HubStore | EventLog.EventLog>) => {
  const resubscribes = { count: 0 };
  const watchdog = Watchdog.of({
    check: () => Effect.void,
    resubscribe: () => Effect.sync(() => ++resubscribes.count),
  });
  const deps = Layer.mergeAll(Layer.succeed(Watchdog, watchdog), EventLog.layer, HubStore.layer).pipe(
    Layer.provideMerge(HubDb.layerMemory),
    Layer.provideMerge(TestClock.layer()),
  );
  return Effect.runPromise(
    body(resubscribes).pipe(Effect.provide(SweepModule.layer()), Effect.provide(deps), Effect.scoped),
  );
};

const types = Effect.gen(function* () {
  const page = yield* (yield* EventLog.EventLog).wait({ cursor: 0, timeoutSec: 0 });
  return page.events.map((e) => [e.type, e.machineId, e.summary]);
});

describe("sweep", () => {
  it("runs every 5 minutes: re-subscribes, then each registered check, isolating failures", () =>
    run((resubscribes) =>
      Effect.gen(function* () {
        const sweep = yield* Sweep;
        const ran: Array<string> = [];
        yield* sweep.register({ name: "boom", run: Effect.fail("nope") });
        yield* sweep.register({ name: "wakes", run: Effect.sync(() => void ran.push("wakes")) });
        yield* TestClock.adjust("4 minutes");
        expect([resubscribes.count, ran]).toEqual([0, []]);
        yield* TestClock.adjust("1 minute");
        expect([resubscribes.count, ran]).toEqual([1, ["wakes"]]);
        yield* TestClock.adjust("10 minutes");
        expect([resubscribes.count, ran]).toEqual([3, ["wakes", "wakes", "wakes"]]);
      }),
    ));

  it("reports a machine offline with running threads once per offline spell", () =>
    run(() =>
      Effect.gen(function* () {
        const store = yield* HubStore.HubStore;
        const sweep = yield* Sweep;
        yield* store.machines.upsert(machine("lab-a", "offline"));
        yield* store.machines.upsert(machine("lab-b", "offline"));
        yield* store.machines.upsert(machine("lab-c", "online"));
        yield* store.threads.upsert(thread("lab-a", "t1", "running"));
        yield* store.threads.upsert(thread("lab-a", "t2", "running"));
        yield* store.threads.upsert(thread("lab-b", "t3", "completed"));
        yield* store.threads.upsert(thread("lab-c", "t4", "running"));
        yield* sweep.runOnce();
        yield* sweep.runOnce();
        expect(yield* types).toEqual([
          ["machine.offline", "lab-a", "lab-a is still offline with 2 running threads; their runs are not being watched"],
        ]);
        // Back online, then offline again: a new spell, reported again.
        yield* store.machines.setStatus(MachineId.make("lab-a"), "online", "2026-10-17T10:10:00.000Z");
        yield* sweep.runOnce();
        yield* store.machines.setStatus(MachineId.make("lab-a"), "offline", "2026-10-17T10:20:00.000Z");
        yield* sweep.runOnce();
        expect((yield* types).length).toBe(2);
      }),
    ));
});
