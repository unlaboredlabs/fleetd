import type { WakeSchedule } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { allEvents, makeFakeExecutors, nextEvent, NOW, ref, run, settle, startHub } from "../queue/testKit.ts";
import type * as Wakes from "./Wakes.ts";

const T1 = ref("lab-a", "t1");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const wake = (schedule: WakeSchedule, over: Partial<Wakes.WakeSet> = {}): Wakes.WakeSet => ({
  target: T1,
  schedule,
  message: "check in",
  once: true,
  catchUp: "fire_once",
  clientRequestId: "c1",
  createdBy: "key1",
  ...over,
});
const inAMinute = { kind: "at", at: iso(NOW + MIN), tz: "UTC" } as const;
const hourly = { kind: "every", everySec: 3600 } as const;

describe("Wakes", () => {
  it("fires an at-wake on time with a per-firing request id, then is done", async () => {
    const fake = makeFakeExecutors();
    fake.goLive("lab-a");
    await run(
      fake,
      Effect.gen(function* () {
        const { wakes } = yield* startHub();
        const { wakeId, nextRunAt } = yield* wakes.set(wake(inAMinute));
        expect(nextRunAt).toBe(iso(NOW + MIN));
        yield* TestClock.adjust("59 seconds");
        yield* settle;
        expect(fake.sends).toEqual([]);
        yield* TestClock.adjust("1 second");
        const fired = yield* nextEvent("wake.fired", 0);
        expect(fake.sends).toEqual([{ ref: T1, message: "check in", clientRequestId: `wake:${wakeId}:1` }]);
        expect(fired).toMatchObject({
          at: iso(NOW + MIN),
          machineId: "lab-a",
          threadId: "t1",
          data: { wakeId, n: 1, queued: false, runId: "run-1" },
        });
        expect(fired.data).not.toHaveProperty("late");
        expect(yield* wakes.get(wakeId)).toMatchObject({ state: "done", lastFiredAt: iso(NOW + MIN) });
        expect(yield* wakes.get(wakeId)).not.toHaveProperty("nextRunAt");
      }),
    );
  });

  it("repeats an every-wake on its grid, numbering each firing", async () => {
    const fake = makeFakeExecutors();
    fake.goLive("lab-a");
    await run(
      fake,
      Effect.gen(function* () {
        const { wakes } = yield* startHub();
        const { wakeId } = yield* wakes.set(wake(hourly, { once: false }));
        yield* TestClock.adjust("1 hour");
        const first = yield* nextEvent("wake.fired", 0);
        yield* TestClock.adjust("1 hour");
        yield* nextEvent("wake.fired", first.seq);
        expect(fake.sends.map((s) => s.clientRequestId)).toEqual([`wake:${wakeId}:1`, `wake:${wakeId}:2`]);
        expect(yield* wakes.get(wakeId)).toMatchObject({ state: "active", nextRunAt: iso(NOW + 3 * 60 * MIN) });
      }),
    );
  });

  it("fires a wake missed while the hub was down once, marked late, and keeps its grid", async () => {
    const fake = makeFakeExecutors();
    fake.goLive("lab-a");
    await run(
      fake,
      Effect.gen(function* () {
        const before = yield* startHub();
        const { wakeId } = yield* before.wakes.set(wake(hourly, { once: false }));
        yield* before.stop;
        // Down from 10:00 to 13:20: the 11:00, 12:00 and 13:00 runs were missed.
        yield* TestClock.adjust("200 minutes");
        const after = yield* startHub();
        const fired = yield* nextEvent("wake.fired", 0);
        expect(fake.sends).toEqual([{ ref: T1, message: "(late by 140 min) check in", clientRequestId: `wake:${wakeId}:1` }]);
        expect(fired.data).toMatchObject({ late: true, lateMin: 140, scheduledAt: iso(NOW + 60 * MIN) });
        expect(yield* after.wakes.get(wakeId)).toMatchObject({ nextRunAt: iso(NOW + 4 * 60 * MIN) });
      }),
    );
  });

  it("skips a missed run with catchUp skip, emitting wake.missed", async () => {
    const fake = makeFakeExecutors();
    fake.goLive("lab-a");
    await run(
      fake,
      Effect.gen(function* () {
        const before = yield* startHub();
        const { wakeId } = yield* before.wakes.set(wake(inAMinute, { catchUp: "skip" }));
        yield* before.stop;
        yield* TestClock.adjust("30 minutes");
        const after = yield* startHub();
        const missed = yield* nextEvent("wake.missed", 0);
        expect(missed).toMatchObject({ threadId: "t1", data: { wakeId, scheduledAt: iso(NOW + MIN), lateMin: 29 } });
        expect(fake.sends).toEqual([]);
        expect(yield* after.wakes.get(wakeId)).toMatchObject({ state: "done" });
        expect((yield* allEvents).map((e) => e.type)).toEqual(["wake.missed"]);
      }),
    );
  });

  it("queues a firing for an offline machine and delivers it when the machine is back", async () => {
    const fake = makeFakeExecutors();
    await run(
      fake,
      Effect.gen(function* () {
        const { wakes } = yield* startHub();
        const { wakeId } = yield* wakes.set(wake(inAMinute));
        yield* TestClock.adjust("1 minute");
        const fired = yield* nextEvent("wake.fired", 0);
        expect(fired.data).toMatchObject({ wakeId, queued: true, queuedUntil: iso(NOW + MIN + 24 * 60 * MIN) });
        fake.goLive("lab-a");
        const delivered = yield* nextEvent("write.delivered", fired.seq);
        expect(delivered.data).toMatchObject({ wakeId, clientRequestId: `wake:${wakeId}:1` });
        expect(fake.sends.map((s) => s.message)).toEqual(["check in"]);
      }),
    );
  });

  it("follows wall-clock time in the wake's zone across a DST change", async () => {
    const fake = makeFakeExecutors();
    fake.goLive("lab-a");
    await run(
      fake,
      Effect.gen(function* () {
        // Saturday 2026-10-24 10:00 UTC; London leaves BST on Sunday 10-25.
        yield* TestClock.setTime(Date.parse("2026-10-24T10:00:00Z"));
        const { wakes } = yield* startHub();
        const { wakeId, nextRunAt } = yield* wakes.set(
          wake({ kind: "cron", cron: "0 9 * * *", tz: "Europe/London" }, { once: false }),
        );
        expect(nextRunAt).toBe("2026-10-25T09:00:00.000Z"); // 09:00 GMT
        yield* TestClock.setTime(Date.parse("2026-10-25T09:00:00Z"));
        yield* nextEvent("wake.fired", 0);
        expect(yield* wakes.get(wakeId)).toMatchObject({ nextRunAt: "2026-10-26T09:00:00.000Z" });
      }),
    );
  });

  it("never fires a cancelled wake, and returns the same wake for a retried set", async () => {
    const fake = makeFakeExecutors();
    fake.goLive("lab-a");
    await run(
      fake,
      Effect.gen(function* () {
        const { wakes } = yield* startHub();
        const first = yield* wakes.set(wake(inAMinute));
        expect(yield* wakes.set(wake(inAMinute))).toEqual(first);
        expect(yield* wakes.list({})).toHaveLength(1);
        yield* wakes.cancel(first.wakeId);
        yield* TestClock.adjust("1 hour");
        yield* settle;
        expect(fake.sends).toEqual([]);
        expect(yield* wakes.list({ state: "cancelled" })).toMatchObject([{ wakeId: first.wakeId }]);
      }),
    );
  });

  it("refuses a schedule that cannot run", async () => {
    const fake = makeFakeExecutors();
    await run(
      fake,
      Effect.gen(function* () {
        const { wakes } = yield* startHub();
        const refused = (schedule: WakeSchedule) => Effect.flip(wakes.set(wake(schedule)));
        expect((yield* refused({ kind: "at", at: iso(NOW - MIN), tz: "UTC" })).message).toContain("in the past");
        expect((yield* refused({ kind: "cron", cron: "0 0 30 2 *", tz: "UTC" })).message).toBe("this schedule never runs");
        expect((yield* refused({ kind: "cron", cron: "every day", tz: "UTC" })).message).toContain("5 fields");
      }),
    );
  });
});
