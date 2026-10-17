import { MachineId, type HubEvent } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as EventLog from "./EventLog.ts";
import * as HubDb from "./HubDb.ts";

const run = <A>(effect: Effect.Effect<A, never, EventLog.EventLog>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(EventLog.layer.pipe(Layer.provideMerge(HubDb.layerMemory), Layer.provideMerge(TestClock.layer()))),
    ),
  );

const lab = (id: string) => MachineId.make(id);
const event = (type: HubEvent["type"], machine = "lab-a"): Omit<HubEvent, "seq"> => ({
  at: "2026-10-17T10:00:00.000Z",
  type,
  machineId: lab(machine),
  summary: `${type} on ${machine}`,
});

const append = (...events: ReadonlyArray<Omit<HubEvent, "seq">>) =>
  Effect.gen(function* () {
    const log = yield* EventLog.EventLog;
    return yield* Effect.forEach(events, log.append);
  });
const wait = (input: EventLog.WaitInput) =>
  Effect.gen(function* () {
    return yield* (yield* EventLog.EventLog).wait(input);
  });
const forkWait = (input: EventLog.WaitInput) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(wait(input));
    yield* Effect.yieldNow;
    return fiber;
  });

describe("EventLog", () => {
  it("returns events after the cursor at once, and nothing for a cursor at head", () =>
    run(
      Effect.gen(function* () {
        yield* append(event("thread.started"), event("thread.completed"), event("thread.failed"));
        const page = yield* wait({ cursor: 1, timeoutSec: 50 });
        expect(page.events.map((e) => [e.seq, e.type])).toEqual([
          [2, "thread.completed"],
          [3, "thread.failed"],
        ]);
        expect(page).toMatchObject({ cursor: 3, more: false });
        expect(yield* wait({ cursor: 3, timeoutSec: 0 })).toEqual({ events: [], cursor: 3, more: false });
      }),
    ));

  it("without a cursor starts at the current end and wakes on the next append", () =>
    run(
      Effect.gen(function* () {
        yield* append(event("thread.started"));
        const fiber = yield* forkWait({ timeoutSec: 50 });
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* append(event("thread.completed"));
        const page = yield* Fiber.join(fiber);
        expect(page.events.map((e) => e.seq)).toEqual([2]);
        expect(page.cursor).toBe(2);
      }),
    ));

  it("times out after timeoutSec with no events and the cursor at head", () =>
    run(
      Effect.gen(function* () {
        yield* append(event("thread.started"));
        const fiber = yield* forkWait({ cursor: 1, timeoutSec: 50 });
        yield* TestClock.adjust("49 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(fiber)).toEqual({ events: [], cursor: 1, more: false });
      }),
    ));

  it("keeps waiting past events the type and machine filters skip, and moves the cursor past them", () =>
    run(
      Effect.gen(function* () {
        const fiber = yield* forkWait({ cursor: 0, types: ["thread.completed"], machineId: lab("lab-b"), timeoutSec: 50 });
        yield* append(event("thread.started", "lab-b"), event("thread.completed", "lab-a"));
        yield* Effect.yieldNow;
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* append(event("thread.completed", "lab-b"));
        const page = yield* Fiber.join(fiber);
        expect(page.events.map((e) => [e.seq, e.machineId])).toEqual([[3, "lab-b"]]);

        // A filtered wait that times out still advances the cursor over what it skipped.
        yield* append(event("machine.online", "lab-b"));
        const skipped = yield* forkWait({ cursor: 3, types: ["thread.failed"], timeoutSec: 5 });
        yield* TestClock.adjust("4 seconds");
        expect(skipped.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(skipped)).toEqual({ events: [], cursor: 4, more: false });
      }),
    ));

  it("pages at 100 events with more set", () =>
    run(
      Effect.gen(function* () {
        yield* append(...Array.from({ length: 150 }, () => event("thread.started")));
        const first = yield* wait({ cursor: 0, timeoutSec: 0 });
        expect([first.events.length, first.cursor, first.more]).toEqual([100, 100, true]);
        const second = yield* wait({ cursor: first.cursor, timeoutSec: 0 });
        expect([second.events.length, second.events[0]?.seq, second.cursor, second.more]).toEqual([50, 101, 150, false]);
      }),
    ));

  it("treats a cursor past head as head", () =>
    run(
      Effect.gen(function* () {
        yield* append(event("thread.started"));
        expect(yield* wait({ cursor: 99, timeoutSec: 0 })).toEqual({ events: [], cursor: 1, more: false });
      }),
    ));

  it("trims long summaries and oversized data", () =>
    run(
      Effect.gen(function* () {
        const [small, big] = yield* append(
          { ...event("thread.failed"), summary: "x".repeat(300), data: { ok: 1 } },
          { ...event("thread.failed"), data: { blob: "y".repeat(3000) } },
        );
        expect(small?.summary).toHaveLength(200);
        expect(small?.data).toEqual({ ok: 1 });
        expect(big?.data).toEqual({ truncated: true });
        const page = yield* wait({ cursor: 0, timeoutSec: 0 });
        expect(page.events).toEqual([small, big]);
      }),
    ));

  it("drops events older than 30 days without reusing their seq", () =>
    run(
      Effect.gen(function* () {
        yield* append(event("thread.started"), event("thread.completed"));
        yield* TestClock.adjust("29 days");
        yield* append(event("thread.failed"));
        expect((yield* wait({ cursor: 0, timeoutSec: 0 })).events).toHaveLength(3);
        yield* TestClock.adjust("2 days");
        const [latest] = yield* append(event("thread.interrupted"));
        expect(latest?.seq).toBe(4);
        const page = yield* wait({ cursor: 0, timeoutSec: 0 });
        expect(page.events.map((e) => e.seq)).toEqual([3, 4]);
      }),
    ));
});
