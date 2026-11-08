import { expect, test } from "bun:test";
import { key, thresholdMs, Watchdog, type WatchPort } from "../src/hub/watchdog/index.ts";
import { sweep } from "../src/hub/sweep/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { eventsOf, testHub } from "./people-kit.ts";

class Fake implements WatchPort {
  now = 0;
  run: string | undefined = "r1";
  open = false;
  lastFrame = 0;
  calls: string[] = [];
  emitted: { kind: string; detail: string; data: Record<string, unknown> }[] = [];
  nowMs() {
    return this.now;
  }
  running(): [string, string][] {
    return this.run ? [[key("lab-a", "t1"), this.run]] : [];
  }
  latestRun() {
    return { runId: this.run, running: this.run !== undefined };
  }
  async follow() {
    this.calls.push("follow");
    this.open = true;
    this.lastFrame = this.now;
    return true;
  }
  release() {
    this.calls.push("release");
    this.open = false;
  }
  progress() {
    return this.open ? { lastFrameMs: this.lastFrame } : undefined;
  }
  async interrupt() {
    this.calls.push(`interrupt ${this.run}`);
  }
  emit(_: string, kind: string, detail: string, data: Record<string, unknown>) {
    this.emitted.push({ kind, detail, data });
  }
}

test("a stall fails the run once and interrupts it; a new run is watched again; an ended one is released", async () => {
  const f = new Fake();
  const w = new Watchdog(10 * 60_000, f);
  for (let m = 0; m <= 12; m++) {
    f.now = m * 60_000;
    await w.check();
  }
  expect(f.emitted.length).toBe(1);
  expect(f.emitted[0]?.kind).toBe("thread.failed");
  expect(f.emitted[0]?.detail).toBe("stalled: no progress for 10 min outside a tool, so fleetd interrupted it");
  expect(f.emitted[0]?.data).toMatchObject({ reason: "stalled", runId: "r1", inTool: false, idleSec: 600, thresholdSec: 600 });
  expect(f.calls).toEqual(["follow", "interrupt r1"]);
  f.run = undefined;
  await w.check();
  expect(f.calls.at(-1)).toBe("release");
  expect(thresholdMs(600_000, { statedTimeoutMs: 1_200_000, unstated: false })).toBe(1_800_000);
  expect(thresholdMs(600_000, { unstated: true })).toBe(1_200_000);
});

test("resubscribe opens a stream for each running thread without one", async () => {
  const f = new Fake();
  const w = new Watchdog(600_000, f);
  expect(await w.resubscribe()).toBe(1);
  expect(await w.resubscribe()).toBe(0);
});

test("the sweep reports a machine offline with running threads once per spell, and runs registered checks", async () => {
  const { hub } = testHub();
  const s = store(hub);
  s.machineUpsert({ machineId: "lab-a", status: "offline", lastSeenAt: "2026-11-08T10:00:00.000Z" } as never);
  hub.db.conn.run(
    `INSERT INTO threads (machine_id, thread_id, project_id, last_progress_at, data) VALUES ('lab-a', 't1', 'p1', 'x', '{"machineId":"lab-a","threadId":"t1","projectId":"p1","status":"running","title":"t"}')`,
  );
  let ran = 0;
  sweep(hub).register({ name: "broken", run: () => { throw new Error("boom"); } });
  sweep(hub).register({ name: "counted", run: () => { ran++; } });
  const warn = console.warn;
  console.warn = () => {};
  await sweep(hub).runOnce();
  await sweep(hub).runOnce();
  console.warn = warn;
  expect(ran).toBe(2);
  const offline = eventsOf(hub, "machine.offline");
  expect(offline.length).toBe(1);
  expect(offline[0]?.summary).toBe("lab-a is still offline with 1 running thread; their runs are not being watched");
  expect(offline[0]?.data).toEqual({ since: "2026-11-08T10:00:00.000Z", runningThreads: ["t1"], count: 1 });
});

test("the hub's watch reads the executor through a static import, so the compiled binary finds it", async () => {
  const { hubWatch } = await import("../src/hub/watchdog/index.ts");
  const { executors } = await import("../src/hub/executor/index.ts");
  const { hub } = testHub();
  const watch = hubWatch(hub);
  // The executor answers, though it can't follow a thread's stream yet: nothing to watch, nothing thrown.
  expect(typeof executors(hub).running).toBe("function");
  expect(watch.running()).toEqual([]);
  expect(await new Watchdog(600_000, watch).resubscribe()).toBe(0);
});
