import { expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { type Sent, type ThreadWriter, WriteError, WriteQueue } from "../src/hub/queue/index.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { ThreadRef } from "../src/shared/contracts.ts";

const NOW = 1_792_000_000_000;
const t1: ThreadRef = { machineId: "lab-a", threadId: "t1" };

/** A writer the test drives: machines go live and away, sends are kept, a refusal is set per message. */
class FakeWriter implements ThreadWriter {
  live = new Set<string>();
  sent: string[] = [];
  refuse = new Map<string, WriteError>();
  behind = false;
  unusable: WriteError | undefined;
  private waiters: (() => void)[] = [];
  goLive(m: string) {
    this.live.add(m);
    for (const w of this.waiters.splice(0)) w();
  }
  isConnected(m: string) {
    return this.live.has(m);
  }
  awaitLive(m: string, signal?: AbortSignal) {
    if (this.live.has(m)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async sendWith(_t: ThreadRef, message: string): Promise<Sent> {
    const refused = this.refuse.get(message);
    if (refused) throw refused;
    this.sent.push(message);
    return { runId: `run-${this.sent.length}`, ...(this.behind ? { behindRun: true } : {}) };
  }
  refusal() {
    return this.unusable;
  }
}

function kit(ttlMs = 24 * 3600_000) {
  const clock = { ms: NOW, now() { return this.ms; } };
  const db = HubDb.memory();
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, db, clock);
  const writer = new FakeWriter();
  const queue = new WriteQueue(hub, writer, ttlMs);
  const events = () => db.all<{ data: string }>("SELECT data FROM events ORDER BY seq").map((r) => JSON.parse(r.data) as { type: string; summary: string; data: Record<string, unknown> });
  return { hub, clock, writer, queue, events };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("sends at once to a connected machine with nothing queued", async () => {
  const { writer, queue, events } = kit();
  writer.goLive("lab-a");
  expect(await queue.send(t1, "hi", "r1")).toEqual({ runId: "run-1", queued: false });
  expect(writer.sent).toEqual(["hi"]);
  expect(events()).toEqual([]);
});

test("queues offline and delivers in order when back, each with one write.delivered", async () => {
  const { writer, queue, events } = kit();
  queue.start();
  expect(await queue.send(t1, "one", "r1")).toEqual({ queued: true, queuedUntil: isoMs(NOW + 24 * 3600_000) });
  await queue.send(t1, "two", "r2");
  await queue.send(t1, "three", "r3", "wk_x");
  // Retried with the same request id: one entry.
  await queue.send(t1, "one", "r1");
  expect(writer.sent).toEqual([]);
  writer.goLive("lab-a");
  await settle();
  expect(writer.sent).toEqual(["one", "two", "three"]);
  const delivered = events().filter((e) => e.type === "write.delivered");
  expect(delivered.length).toBe(3);
  expect(delivered[0]?.summary).toBe("Queued message to thread t1 on lab-a delivered after 1 min");
  expect(delivered[0]?.data).toEqual({ clientRequestId: "r1", queuedAt: isoMs(NOW), runId: "run-1" });
  expect(delivered[2]?.data.wakeId).toBe("wk_x");
  // Nothing queued and connected: straight through.
  expect((await queue.send(t1, "four", "r4")).queued).toBe(false);
  queue.stop();
});

test("expires a write at its TTL, never delivering it", async () => {
  const { clock, writer, queue, events } = kit(60);
  queue.start();
  await queue.send(t1, "stale", "r1");
  clock.ms += 61;
  await new Promise((r) => setTimeout(r, 120));
  const [expired] = events();
  expect(expired?.type).toBe("write.expired");
  expect(expired?.summary).toBe("Queued message to thread t1 on lab-a expired undelivered after 1 min");
  expect(expired?.data).toMatchObject({ reason: "ttl", clientRequestId: "r1" });
  writer.goLive("lab-a");
  await queue.send(t1, "fresh", "r2");
  await settle();
  expect(writer.sent).toEqual(["fresh"]);
  queue.stop();
});

test("a linked machine whose runner can't run refuses at once; a refused queued write is dropped and the rest go on", async () => {
  const { writer, queue, events, hub } = kit();
  writer.goLive("lab-a");
  writer.unusable = new WriteError("NodeRequestFailed", "claude is not logged in for fleetd on lab-a", "run claude auth login");
  await expect(queue.send(t1, "x", "r0")).rejects.toThrow("claude is not logged in");
  expect(hub.db.all("SELECT 1 FROM queued_writes").length).toBe(0);
  writer.unusable = undefined;
  writer.live.clear();
  queue.start();
  await queue.send(t1, "bad", "r1");
  await queue.send(t1, "good", "r2");
  writer.refuse.set("bad", new WriteError("NodeRequestFailed", "no"));
  const warn = console.warn;
  console.warn = () => {};
  writer.goLive("lab-a");
  await settle();
  console.warn = warn;
  expect(writer.sent).toEqual(["good"]);
  expect(events().map((e) => [e.type, e.data.reason])).toEqual([
    ["write.expired", "refused"],
    ["write.delivered", undefined],
  ]);
  queue.stop();
});

test("a queued steer can be withdrawn, and one that expires tells its receipt", async () => {
  const { queue, clock } = kit(50);
  const told: [string, string][] = [];
  queue.onSteerExpired((s, why) => told.push([s, why]));
  await queue.send(t1, "steer one", "r1", undefined, { mode: "boundary", steer: "S1" });
  await queue.send(t1, "steer two", "r2", undefined, { mode: "now", steer: "S2" });
  expect(queue.hasSteer("S1")).toBe(true);
  expect(queue.withdrawSteer("S1")).toBe(true);
  expect(queue.hasSteer("S1")).toBe(false);
  queue.start();
  clock.ms += 51;
  await new Promise((r) => setTimeout(r, 120));
  expect(told).toEqual([["S2", "ttl"]]);
  queue.stop();
});

test("keeps the queue across a restart", async () => {
  const { hub, writer, queue } = kit();
  await queue.send(t1, "survives", "r1");
  queue.stop();
  const again = new WriteQueue(hub, writer);
  writer.goLive("lab-a");
  again.start();
  await settle();
  expect(writer.sent).toEqual(["survives"]);
  again.stop();
});
