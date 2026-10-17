// Test kit for the queue and wakes: one shared in-memory database, event log, fake executors and TestClock,
// with "hub processes" (queue + wakes) that can be started and stopped over it to test restarts.
import type { HubEvent, HubEventType, MachineId, ThreadId, ThreadRef } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as Executors from "../executor/Executors.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as Wakes from "../wakes/Wakes.ts";
import * as WriteQueue from "./WriteQueue.ts";

export const ref = (machineId: string, threadId: string): ThreadRef => ({
  machineId: machineId as MachineId,
  threadId: threadId as ThreadId,
});

export const makeFakeExecutors = () => {
  const connected = new Set<string>();
  const sends: Array<{ readonly ref: ThreadRef; readonly message: string; readonly clientRequestId: string }> = [];
  const waiters: Array<{ readonly id: string; readonly resume: () => void }> = [];
  let refused = new Set<string>();
  const service = Executors.Executors.of({
    attach: () => Effect.void,
    detach: () => Effect.void,
    isConnected: (id) => Effect.sync(() => connected.has(id)),
    awaitLive: (id) =>
      Effect.suspend(() =>
        connected.has(id) ? Effect.void : Effect.callback<void>((resume) => void waiters.push({ id, resume: () => resume(Effect.void) })),
      ),
    launch: () => Effect.die("unused"),
    send: (target, message, clientRequestId) =>
      Effect.suspend((): Effect.Effect<{ runId: string; queued: boolean }, Executors.ExecutorError> => {
        if (!connected.has(target.machineId)) return Effect.fail(new Executors.MachineNotConnected({ machineId: target.machineId }));
        if (refused.has(clientRequestId)) {
          return Effect.fail(new Executors.T3RequestFailed({ machineId: target.machineId, operation: "send", cause: "refused" }));
        }
        sends.push({ ref: target, message, clientRequestId });
        return Effect.succeed({ runId: `run-${sends.length}`, queued: false });
      }),
    interrupt: () => Effect.die("unused"),
    tail: () => Effect.die("unused"),
    actions: () => Effect.die("unused"),
  });
  return {
    service,
    sends,
    goLive: (id: string) => {
      connected.add(id);
      for (const w of waiters.filter((w) => w.id === id)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resume();
      }
    },
    goOffline: (id: string) => void connected.delete(id),
    refuse: (...clientRequestIds: Array<string>) => void (refused = new Set(clientRequestIds)),
  };
};

export type FakeExecutors = ReturnType<typeof makeFakeExecutors>;
type Base = HubDb.HubDb | EventLog.EventLog | Executors.Executors | TestClock.TestClock;

export const NOW = Date.parse("2026-10-17T10:00:00.000Z");

/** Runs `effect` over a fresh database with the clock at NOW. */
export const run = <A, E>(fake: FakeExecutors, effect: Effect.Effect<A, E, Base | Scope.Scope>) =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(NOW), effect).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(EventLog.layer, Layer.succeed(Executors.Executors, fake.service)).pipe(
          Layer.provideMerge(HubDb.layerMemory),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  );

/** One hub process over the shared database; `stop` is the hub going down. */
export const startHub = (options: WriteQueue.WriteQueueOptions = {}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(Wakes.layer.pipe(Layer.provideMerge(WriteQueue.layer(options))), scope);
    return {
      queue: Context.get(context, WriteQueue.WriteQueue),
      wakes: Context.get(context, Wakes.Wakes),
      stop: Scope.close(scope, Exit.void),
    };
  });

/** The next event of `type` after `cursor`. The TestClock never moves by itself, so this waits for an append. */
export const nextEvent = (type: HubEventType, cursor: number) =>
  Effect.gen(function* () {
    const page = yield* (yield* EventLog.EventLog).wait({ cursor, types: [type], timeoutSec: 86_400 });
    return page.events[0]!;
  });

/** Every event so far, oldest first. */
export const allEvents = Effect.gen(function* () {
  const page = yield* (yield* EventLog.EventLog).wait({ cursor: 0, timeoutSec: 0 });
  return page.events as ReadonlyArray<HubEvent>;
});

/** Lets forked fibers run to their next suspension. */
export const settle = Effect.repeat(Effect.yieldNow, { times: 20 });
