// The leads area (crates/fleetd/src/hub/leads: wakes.rs's debouncer tests, lead.rs, workstreams.rs, cut_off.rs).
import { expect, test } from "bun:test";
import { registerAll } from "../src/gen/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { end } from "../src/hub/leads/cut_off.ts";
import { leads } from "../src/hub/leads/index.ts";
import { Debouncer, WAKE_COALESCE_MS, WAKE_DEBOUNCE_MS, WAKE_MAX_WAIT_MS } from "../src/hub/leads/lead_wakes.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { workstreams } from "../src/hub/leads/workstreams.ts";
import { events } from "../src/hub/store/events.ts";
import type { HubEvent } from "../src/shared/contracts.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

/** A manual clock whose sleeps resolve as it advances. */
function manual() {
  const clock = { ms: 0, now: () => clock.ms };
  const sleepers: { at: number; resolve: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => sleepers.push({ at: clock.ms + ms, resolve }));
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const advance = async (secs: number) => {
    const target = clock.ms + secs * 1000;
    for (;;) {
      sleepers.sort((a, b) => a.at - b.at);
      const next = sleepers[0];
      if (!next || next.at > target) break;
      sleepers.shift();
      clock.ms = Math.max(clock.ms, next.at);
      next.resolve();
      await settle();
    }
    clock.ms = target;
    await settle();
  };
  return { clock, sleep, advance, settle };
}

function debouncer() {
  const m = manual();
  const d = new Debouncer<number>(m.clock.now, WAKE_DEBOUNCE_MS, WAKE_MAX_WAIT_MS, WAKE_COALESCE_MS, m.sleep);
  const flushes: [string, number[], number][] = [];
  const push = (key: string, item: number, now = false) => d.push(key, item, now, (k, items) => void flushes.push([k, items, m.clock.ms]));
  return { ...m, d, flushes, push };
}

test("coalesces into one flush ten seconds after the last trigger", async () => {
  const { push, advance, flushes } = debouncer();
  push("1", 1);
  await advance(5);
  push("1", 2);
  await advance(9);
  push("1", 3);
  await advance(9);
  expect(flushes).toEqual([]);
  await advance(1);
  expect(flushes).toEqual([["1", [1, 2, 3], 24_000]]);
  await advance(60);
  expect(flushes.length).toBe(1);
});

test("a steady stream flushes sixty seconds after the first trigger, then opens a fresh window", async () => {
  const { push, advance, flushes } = debouncer();
  for (let i = 1; i <= 7; i++) {
    push("1", i);
    await advance(8);
  }
  expect(flushes).toEqual([]);
  push("1", 8);
  await advance(3);
  expect(flushes).toEqual([]);
  await advance(1);
  expect(flushes).toEqual([["1", [1, 2, 3, 4, 5, 6, 7, 8], 60_000]]);
  push("1", 9);
  await advance(9);
  expect(flushes.length).toBe(1);
  await advance(1);
  expect(flushes[1]).toEqual(["1", [9], 70_000]);
});

test("a now item flushes soon with what comes by then, unless the key just flushed", async () => {
  const { push, advance, settle, flushes } = debouncer();
  push("1", 1);
  await advance(3);
  push("1", 2, true);
  await advance(2);
  push("1", 3, true);
  await advance(2);
  push("1", 4);
  await settle();
  expect(flushes).toEqual([]);
  await advance(1);
  expect(flushes).toEqual([["1", [1, 2, 3, 4], 8_000]]);
  await advance(1);
  push("1", 5, true);
  push("1", 6);
  await advance(9);
  expect(flushes.length).toBe(1);
  await advance(1);
  expect(flushes[1]).toEqual(["1", [5, 6], 19_000]);
  push("2", 7, true);
  await advance(5);
  expect(flushes[2]).toEqual(["2", [7], 24_000]);
  await advance(5);
  push("1", 8, true);
  await advance(5);
  expect(flushes[3]).toEqual(["1", [8], 34_000]);
});

test("a joined item rides along and starts no flush", async () => {
  const { d, push, advance, flushes } = debouncer();
  expect(d.join("1", 9)).toBe(9);
  await advance(60);
  expect(flushes).toEqual([]);
  push("1", 1);
  await advance(9);
  expect(d.join("1", 2)).toBeUndefined();
  await advance(1);
  expect(flushes).toEqual([["1", [1, 2], 70_000]]);
});

function withLead() {
  const t = testHub();
  const launches: { machineId: string; prompt: string; system?: string; role: string }[] = [];
  const sends: [string, string][] = [];
  // After the start, which wires the real ports: these stand in for the executor and the queue.
  start(t.hub);
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (machineId: string, input: { prompt: string; systemPrompt?: string }, role: string) => {
      launches.push({ machineId, prompt: input.prompt, ...(input.systemPrompt ? { system: input.systemPrompt } : {}), role });
      return `lead-${launches.length}`;
    },
    send: async (_thread: unknown, message: string, crid: string) => {
      sends.push([message, crid]);
      return false;
    },
  });
  return { ...t, launches, sends };
}

test("lead_start launches once with the lead prompt and digest; a wake reaches it with its event lines", async () => {
  const { hub, clock, launches, sends, done } = withLead();
  const tools = new Registry();
  registerAll(tools);
  const ws = workstreams(hub).intake({ projectRef: PROJECT, text: "add dark mode", clientRequestId: "c1", channel: "app", by: "human" });
  expect(ws.workstreamId).toBe("W1");
  // Made before the lead started: its first message lists it, so no wake says it again.
  clock.ms += 1000;
  const out = (await tools.call(hub, caller("operate"), "lead_start", { machineId: "lab-a", projectId: "p1" })) as { output: Record<string, unknown> };
  expect(out.output).toMatchObject({ threadId: "lead-1", state: "starting", sessionGeneration: 0 });
  expect(launches.length).toBe(1);
  expect(launches[0]?.role).toBe("lead");
  expect(launches[0]?.prompt).toContain("# project Shop (lab-a/p1)");
  expect(launches[0]?.prompt).toContain("- W1 open: add dark mode");
  expect(launches[0]?.system).toContain("## Automations");
  await tools.call(hub, caller("operate"), "lead_start", { machineId: "lab-a", projectId: "p1" });
  expect(launches.length).toBe(1);
  expect(events(hub).page(0).events.filter((e) => e.type === "lead.started").length).toBe(1);
  // A trigger after the lead started wakes it.
  leads(hub).wakes.trigger(PROJECT, { kind: "line", line: "task_result", text: "- T1 finished: dark mode" });
  await Bun.sleep(10_100);
  expect(sends.length).toBe(1);
  expect(sends[0]?.[0]).toContain("- T1 finished: dark mode");
  expect(sends[0]?.[1]).toStartWith("fleetd-wake:lab-a/p1:0:");
  const woken = events(hub).page(0).events.find((e) => e.type === "lead.woken");
  expect(woken).toMatchObject({ summary: "Lead of p1 woken with 1 trigger", data: { triggers: ["task_result"] } });
  done();
  // 10 s of it is the wake's own wait, in real time: a loaded machine needs room for the rest.
}, 30_000);

test("brief_create opens or edits an order; close refuses a closed one", async () => {
  const { hub, done } = withLead();
  const lead = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" as const } };
  const brief = { doneWhen: ["the toggle works"] };
  const opened = (await leadCalls(hub).handler("brief_create")?.(lead, { op: "brief_create", text: "Dark mode", brief })) as Record<string, unknown>;
  expect(opened).toMatchObject({ workstreamId: "W1", state: "open", next: "Brief set. Spawn its agents with `spawn_agent` for W1." });
  const same = (await leadCalls(hub).handler("brief_create")?.(lead, { op: "brief_create", workstreamId: "W1", brief })) as Record<string, unknown>;
  expect(same.next).toStartWith("Unchanged.");
  const closed = (await leadCalls(hub).handler("close")?.(lead, { op: "close", workstreamId: "W1", why: "shipped" })) as Record<string, unknown>;
  expect(closed).toEqual({ workstreamId: "W1", state: "done", next: "Closed." });
  const again = await Promise.resolve(leadCalls(hub).handler("close")?.(lead, { op: "close", workstreamId: "W1", why: "x" })).catch((e: Error) => e.message);
  expect(again).toBe("W1 is already done.");
  const types = events(hub)
    .page(0)
    .events.filter((e) => e.type.startsWith("workstream."))
    .map((e) => e.type);
  expect(types).toEqual(["workstream.created", "workstream.running", "workstream.done"]);
  done();
});

test("a lead cut off by its node is woken every time; one whose own turn hung, once until a turn completes", () => {
  const leadsList = [{ projectRef: PROJECT, threadId: "lead-1", startedAt: "", sessionGeneration: 0 }];
  const ev = (type: string, data: Record<string, unknown>) => ({ seq: 1, at: "", type, machineId: "lab-a", threadId: "lead-1", summary: "", data }) as HubEvent;
  expect(end(ev("thread.failed", { endCause: "node_restarted" }), leadsList)?.end.kind).toBe("node_lost");
  expect(end(ev("thread.failed", { reason: "stalled", error: { message: "idle 30 min" } }), leadsList)?.end).toMatchObject({ kind: "own" });
  expect(end(ev("thread.interrupted", {}), leadsList)).toBeUndefined();
  expect(end(ev("thread.completed", {}), leadsList)?.end.kind).toBe("completed");
  expect(end({ ...ev("thread.failed", {}), threadId: "other" }, leadsList)).toBeUndefined();
});

test("workstream_list and project_set", async () => {
  const { hub, done } = withLead();
  const tools = new Registry();
  registerAll(tools);
  workstreams(hub).intake({ projectRef: PROJECT, text: "one", clientRequestId: "c1", channel: "app", by: "human" });
  workstreams(hub).intake({ projectRef: PROJECT, text: "two", clientRequestId: "c2", channel: "app", by: "human" });
  const listed = (await tools.call(hub, caller("read"), "workstream_list", { machineId: "lab-a", projectId: "p1", limit: 1 })) as { output: any };
  expect(listed.output.workstreams.map((w: { title: string }) => w.title)).toEqual(["two"]);
  expect(listed.output.truncated).toBe(true);
  const set = (await tools.call(hub, caller("operate"), "project_set", { machineId: "lab-a", projectId: "p1", profiles: [] })) as { output: any };
  expect(set.output.profiles.length).toBeGreaterThan(0);
  done();
});

test("the intake area opens an order once per request, announced, and wakes the lead", async () => {
  const { hub, done } = withLead();
  const input = { projectRef: PROJECT, text: "Fix the check `rust` on main", clientRequestId: "train:1", channel: "train" as const, by: "train" };
  const { intake } = await import("../src/hub/leads/workstreams.ts");
  expect(intake(hub).intake(input)).toEqual({ workstreamId: "W1" });
  expect(intake(hub).submit(input)).toEqual({ workstreamId: "W1" });
  expect(events(hub).page(0).events.filter((e) => e.type === "workstream.created").map((e) => e.summary)).toEqual(["New intent W1: Fix the check `rust` on main"]);
  expect(leads(hub).wakes.pending(PROJECT)).toBe(true);
  expect(await intake(hub).close(PROJECT, "W1", "fixed", "train")).toMatchObject({ state: "done" });
  done();
});

test("with the real ports, a lead start reaches the executor, and autoStart holds with why", async () => {
  const t = testHub();
  start(t.hub);
  const tools = new Registry();
  registerAll(tools);
  const out = (await tools.call(t.hub, caller("operate"), "lead_start", { machineId: "lab-a", projectId: "p1" })) as { error?: { error?: Error } };
  expect(out.error?.error?.message).toBeDefined();
  expect(out.error?.error?.message).not.toContain("not wired");
  const held = await leads(t.hub).autoStart(PROJECT);
  expect(held.kind).toBe("held");
  if (held.kind === "held") expect(held.message).toBe(held.error.message);
  t.done();
});
