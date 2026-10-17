import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { allEvents, makeFakeExecutors, nextEvent, NOW, ref, run, settle, startHub } from "./testKit.ts";

const T1 = ref("lab-a", "t1");
const T2 = ref("lab-a", "t2");

describe("WriteQueue", () => {
  it("sends at once to a connected machine with nothing queued", async () => {
    const fake = makeFakeExecutors();
    fake.goLive("lab-a");
    await run(
      fake,
      Effect.gen(function* () {
        const { queue } = yield* startHub();
        expect(yield* queue.send(T1, "hi", "r1")).toEqual({ runId: "run-1", queued: false });
        expect(fake.sends).toEqual([{ ref: T1, message: "hi", clientRequestId: "r1" }]);
        expect(yield* allEvents).toEqual([]);
      }),
    );
  });

  it("queues for an offline machine and delivers in order when it is back", async () => {
    const fake = makeFakeExecutors();
    await run(
      fake,
      Effect.gen(function* () {
        const { queue } = yield* startHub();
        expect(yield* queue.send(T1, "one", "r1")).toEqual({ queued: true, queuedUntil: new Date(NOW + 86_400_000).toISOString() });
        yield* queue.send(T2, "two", "r2");
        yield* queue.send(T1, "three", "r3", { wakeId: "wk_x" });
        yield* settle;
        expect(fake.sends).toEqual([]);

        yield* TestClock.adjust("10 minutes");
        fake.goLive("lab-a");
        const last = yield* nextEvent("write.delivered", 2);
        expect(fake.sends.map((s) => s.message)).toEqual(["one", "two", "three"]);
        const delivered = (yield* allEvents).filter((e) => e.type === "write.delivered");
        expect(delivered.map((e) => [e.threadId, (e.data as { clientRequestId: string }).clientRequestId])).toEqual([
          ["t1", "r1"],
          ["t2", "r2"],
          ["t1", "r3"],
        ]);
        expect(delivered[0]).toMatchObject({
          machineId: "lab-a",
          summary: "Queued message to thread t1 on lab-a delivered after 10 min",
          data: { queuedAt: new Date(NOW).toISOString(), runId: "run-1" },
        });
        expect(delivered[2]!.data).toMatchObject({ wakeId: "wk_x" });
        expect(last.seq).toBe(3);

        // Drained: the next send goes straight out again.
        expect(yield* queue.send(T1, "four", "r4")).toEqual({ runId: "run-4", queued: false });
      }),
    );
  });

  it("keeps one entry for a retried clientRequestId", async () => {
    const fake = makeFakeExecutors();
    await run(
      fake,
      Effect.gen(function* () {
        const { queue } = yield* startHub();
        const first = yield* queue.send(T1, "hi", "r1");
        yield* TestClock.adjust("1 minute");
        expect(yield* queue.send(T1, "hi", "r1")).toEqual(first);
        fake.goLive("lab-a");
        yield* nextEvent("write.delivered", 0);
        yield* settle;
        expect(fake.sends).toHaveLength(1);
      }),
    );
  });

  it("expires a write at its TTL, never delivering it", async () => {
    const fake = makeFakeExecutors();
    await run(
      fake,
      Effect.gen(function* () {
        const { queue } = yield* startHub({ ttl: "40 seconds" });
        yield* queue.send(T1, "stale", "r1");
        yield* TestClock.adjust("20 seconds");
        yield* queue.send(T1, "fresh", "r2");
        yield* TestClock.adjust("19 seconds");
        yield* settle;
        expect(yield* allEvents).toEqual([]);
        yield* TestClock.adjust("1 second");
        const expired = yield* nextEvent("write.expired", 0);
        expect(expired).toMatchObject({
          at: new Date(NOW + 40_000).toISOString(),
          threadId: "t1",
          summary: "Queued message to thread t1 on lab-a expired undelivered after 1 min",
          data: { clientRequestId: "r1", reason: "ttl" },
        });
        fake.goLive("lab-a");
        yield* nextEvent("write.delivered", expired.seq);
        expect(fake.sends.map((s) => s.message)).toEqual(["fresh"]);
      }),
    );
  });

  it("drops a write T3 refuses on a live connection and goes on with the rest", async () => {
    const fake = makeFakeExecutors();
    fake.refuse("r1");
    await run(
      fake,
      Effect.gen(function* () {
        const { queue } = yield* startHub();
        yield* queue.send(T1, "bad", "r1");
        yield* queue.send(T1, "good", "r2");
        fake.goLive("lab-a");
        const delivered = yield* nextEvent("write.delivered", 0);
        expect(delivered.data).toMatchObject({ clientRequestId: "r2" });
        expect((yield* allEvents).map((e) => [e.type, (e.data as { reason?: string }).reason])).toEqual([
          ["write.expired", "refused"],
          ["write.delivered", undefined],
        ]);
      }),
    );
  });

  it("keeps the queue across a hub restart", async () => {
    const fake = makeFakeExecutors();
    await run(
      fake,
      Effect.gen(function* () {
        const first = yield* startHub();
        yield* first.queue.send(T1, "survives", "r1");
        yield* first.stop;
        fake.goLive("lab-a");
        yield* startHub();
        yield* nextEvent("write.delivered", 0);
        expect(fake.sends.map((s) => s.message)).toEqual(["survives"]);
      }),
    );
  });
});
