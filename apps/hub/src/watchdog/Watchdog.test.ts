import { MachineId, ProjectId, ThreadId, type ThreadRef } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Executors from "../executor/Executors.ts";
import { type Progress, ThreadWatch } from "../executor/ThreadWatch.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { configFromEnv, DEFAULT_CONFIG, NUDGE, thresholdMs, Watchdog, type WatchdogConfig } from "./Watchdog.ts";
import * as WatchdogModule from "./Watchdog.ts";

const MIN = 60_000;
const ref: ThreadRef = { machineId: MachineId.make("lab-a"), threadId: ThreadId.make("t1") };

/** One thread on a fake T3, driven by the test. */
const makeFake = () => {
  const thread = {
    runId: "r1",
    running: true,
    streamOpen: false,
    lastFrameMs: 0,
    tool: undefined as Progress["tool"],
  };
  const calls: Array<string> = [];
  const watch = ThreadWatch.of({
    running: () => Effect.sync(() => (thread.running ? [{ ref, runId: thread.runId }] : [])),
    latestRun: () => Effect.sync(() => ({ runId: thread.runId, running: thread.running })),
    follow: () =>
      Effect.gen(function* () {
        calls.push("follow");
        thread.streamOpen = true;
        thread.lastFrameMs = yield* Clock.currentTimeMillis;
      }),
    release: () => Effect.sync(() => void calls.push("release")),
    progress: () =>
      Effect.sync(() =>
        thread.streamOpen ? { lastFrameMs: thread.lastFrameMs, ...(thread.tool ? { tool: thread.tool } : {}) } : undefined,
      ),
  });
  const executors = {
    interrupt: (_: ThreadRef, clientRequestId: string) => Effect.sync(() => void calls.push(`interrupt ${clientRequestId}`)),
    send: (_: ThreadRef, message: string, clientRequestId: string) =>
      Effect.sync(() => {
        calls.push(`send ${clientRequestId} ${message === NUDGE ? "NUDGE" : message}`);
        return { queued: false };
      }),
  } as unknown as Executors.Executors["Service"];
  return { thread, calls, watch, executors };
};

const run = (config: Partial<WatchdogConfig>, body: (fake: ReturnType<typeof makeFake>) => Effect.Effect<void, never, EventLog.EventLog>) => {
  const fake = makeFake();
  const deps = Layer.mergeAll(
    Layer.succeed(ThreadWatch, fake.watch),
    Layer.succeed(Executors.Executors, fake.executors),
    EventLog.layer,
    HubStore.layer,
  ).pipe(Layer.provideMerge(HubDb.layerMemory), Layer.provideMerge(TestClock.layer()));
  const seed = Effect.gen(function* () {
    const store = yield* HubStore.HubStore;
    yield* store.threads.upsert({
      machineId: ref.machineId,
      threadId: ref.threadId,
      projectId: ProjectId.make("p1"),
      title: "sleepy",
      status: "running",
      headline: "",
      latestMessageTail: "",
      lastProgressAt: "2026-10-17T10:00:00.000Z",
      stale: false,
      asOf: "2026-10-17T10:00:00.000Z",
    });
  });
  return Effect.runPromise(
    seed.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          yield* Watchdog;
          yield* body(fake);
        }).pipe(Effect.provide(WatchdogModule.layer({ ...DEFAULT_CONFIG, checkEveryMs: MIN, ...config }))),
      ),
      Effect.scoped,
      Effect.provide(deps),
    ),
  );
};

const eventsSoFar = Effect.gen(function* () {
  const log = yield* EventLog.EventLog;
  const page = yield* log.wait({ cursor: 0, timeoutSec: 0 });
  return page.events.map((e) => ({ type: e.type, data: e.data as Record<string, unknown>, summary: e.summary }));
});
const types = Effect.map(eventsSoFar, (es) => es.map((e) => e.type));
const toMinute = (minute: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* TestClock.adjust(minute * MIN - now);
  });

describe("watchdog ladder", () => {
  it("stalls, interrupts, nudges once, then fails on the second stall without retrying", () =>
    run({}, ({ thread, calls }) =>
      Effect.gen(function* () {
        yield* toMinute(1);
        expect(calls).toEqual(["follow"]); // the stream opens at minute 1, the first frame
        yield* toMinute(10);
        expect(yield* types).toEqual([]);
        yield* toMinute(11);
        const [stalled] = yield* eventsSoFar;
        expect(stalled).toMatchObject({ type: "thread.stalled", data: { runId: "r1", inTool: false, idleSec: 600, thresholdSec: 600 } });
        expect(stalled!.summary).toBe(`"sleepy" on lab-a stalled: no progress for 10 min outside a tool; interrupting and nudging once`);
        expect(calls.slice(1)).toEqual(["interrupt watchdog:r1:interrupt"]);

        // The nudge waits for the interrupted run to end, and goes out once.
        yield* toMinute(13);
        expect(calls.filter((c) => c.startsWith("send"))).toEqual([]);
        thread.running = false;
        yield* toMinute(16);
        expect(calls.filter((c) => c.startsWith("send"))).toEqual(["send watchdog:r1:continue NUDGE"]);

        // The continuation runs, makes some progress, then stalls: the chain fails.
        thread.runId = "r2";
        thread.running = true;
        yield* toMinute(18);
        thread.lastFrameMs = 18 * MIN;
        yield* toMinute(27);
        expect(yield* types).toEqual(["thread.stalled"]);
        yield* toMinute(28);
        const failed = (yield* eventsSoFar)[1];
        expect(failed).toMatchObject({ type: "thread.failed", data: { runId: "r2", reason: "stalled", status: "failed" } });
        expect(calls.at(-1)).toBe("interrupt watchdog:r2:fail");

        // Even if the interrupt does not take, nothing more happens to this run.
        yield* toMinute(90);
        expect(yield* types).toEqual(["thread.stalled", "thread.failed"]);
        expect(calls.filter((c) => c.startsWith("send"))).toHaveLength(1);
        thread.running = false;
        yield* toMinute(91);
        expect(calls.at(-1)).toBe("release");
      }),
    ));

  it("a continuation that finishes ends the chain, so a later stall starts a fresh ladder", () =>
    run({}, ({ thread, calls }) =>
      Effect.gen(function* () {
        yield* toMinute(11);
        thread.running = false;
        yield* toMinute(12);
        thread.runId = "r2";
        thread.running = true;
        yield* toMinute(13);
        thread.running = false; // r2 completes
        yield* toMinute(14);
        expect(calls.at(-1)).toBe("release");
        thread.runId = "r3";
        thread.running = true;
        thread.streamOpen = false;
        yield* toMinute(26);
        expect(yield* types).toEqual(["thread.stalled", "thread.stalled"]);
        expect((yield* eventsSoFar)[1]!.data).toMatchObject({ runId: "r3" });
      }),
    ));

  it("frames keep a run alive however long it takes", () =>
    run({}, ({ thread }) =>
      Effect.gen(function* () {
        for (let minute = 5; minute <= 120; minute += 5) {
          yield* toMinute(minute);
          thread.lastFrameMs = minute * MIN;
        }
        expect(yield* types).toEqual([]);
      }),
    ));

  it("inside a tool, waits for the tool's timeout plus the grace", () =>
    run({}, ({ thread }) =>
      Effect.gen(function* () {
        thread.tool = { unstated: true };
        yield* toMinute(20);
        expect(yield* types).toEqual([]);
        yield* toMinute(21);
        expect((yield* eventsSoFar)[0]).toMatchObject({ type: "thread.stalled", data: { inTool: true, thresholdSec: 1200 } });
      }),
    ));

  it("short thresholds from config, as the lab uses", () =>
    run(
      configFromEnv({ FLEETD_STALL_OUTSIDE_SEC: "20", FLEETD_STALL_TOOL_TIMEOUT_SEC: "10", FLEETD_STALL_INSIDE_GRACE_SEC: "20", FLEETD_WATCHDOG_EVERY_SEC: "1" }),
      ({ thread }) =>
        Effect.gen(function* () {
          thread.tool = { unstated: true };
          yield* TestClock.adjust("30 seconds");
          expect(yield* types).toEqual([]);
          yield* TestClock.adjust("1 second");
          expect(yield* types).toEqual(["thread.stalled"]);
        }),
    ));
});

describe("thresholds", () => {
  it("outside a tool, inside one with no stated timeout, and inside one that states its own", () => {
    expect(thresholdMs(DEFAULT_CONFIG, undefined)).toBe(10 * MIN);
    expect(thresholdMs(DEFAULT_CONFIG, { unstated: true })).toBe(20 * MIN);
    expect(thresholdMs(DEFAULT_CONFIG, { statedTimeoutMs: 30 * MIN, unstated: false })).toBe(40 * MIN);
    // A short stated timeout next to a tool that states none still gets the default.
    expect(thresholdMs(DEFAULT_CONFIG, { statedTimeoutMs: MIN, unstated: true })).toBe(20 * MIN);
  });

  it("reads seconds from the environment and ignores junk", () => {
    expect(configFromEnv({})).toEqual(DEFAULT_CONFIG);
    expect(configFromEnv({ FLEETD_STALL_OUTSIDE_SEC: "20", FLEETD_STALL_INSIDE_GRACE_SEC: "x", FLEETD_WATCHDOG_EVERY_SEC: "-1" })).toEqual({
      ...DEFAULT_CONFIG,
      outsideToolMs: 20_000,
    });
  });
});
