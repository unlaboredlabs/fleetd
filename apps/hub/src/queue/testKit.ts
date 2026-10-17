// Test kit for the queue and wakes: one shared in-memory database, event log, fake executors and TestClock,
// with "hub processes" (queue + wakes) that can be started and stopped over it to test restarts.
import type { HubEvent, HubEventType, MachineId, ThreadId, ThreadRef } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as Executors from "../executor/Executors.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as Usage from "../usage/Usage.ts";
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

/** A usage layer that holds `held` threads until `release` is called for them; nothing is held by default. */
export const makeFakeUsage = () => {
  const held = new Map<string, Deferred.Deferred<void>>();
  const key = (r: ThreadRef) => `${r.machineId}/${r.threadId}`;
  const reason = "usage: paused until Tue 09:00 UTC (Claude limit on lab-a's login)";
  const service = Usage.Usage.of({
    gate: () => Effect.die("unused"),
    hold: (r) => Effect.sync(() => (held.has(key(r)) ? reason : undefined)),
    parkedOf: () => Effect.die("unused"),
    whenClear: (r) => Effect.suspend(() => (held.has(key(r)) ? Deferred.await(held.get(key(r))!) : Effect.void)),
    status: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    drain: Effect.void,
  });
  return {
    service,
    hold: (r: ThreadRef) => void held.set(key(r), Deferred.makeUnsafe<void>()),
    release: (r: ThreadRef) =>
      Effect.suspend(() => {
        const done = held.get(key(r));
        held.delete(key(r));
        return done === undefined ? Effect.void : Deferred.succeed(done, undefined);
      }),
  };
};

/** One hub process over the shared database; `stop` is the hub going down. */
export const startHub = (options: WriteQueue.WriteQueueOptions = {}, usage = makeFakeUsage().service) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      Wakes.layer.pipe(Layer.provideMerge(WriteQueue.layer(options)), Layer.provide(Layer.succeed(Usage.Usage, usage))),
      scope,
    );
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
