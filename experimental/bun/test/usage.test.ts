// The usage layer (crates/fleetd/src/hub/usage/{state,service_tests,calls}.rs tests).
import { describe, expect, test } from "bun:test";
import type { HubEvent } from "../src/shared/contracts.ts";
import type { LoginLimit } from "../src/shared/node_link.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { classifyLimit, limitData } from "../src/hub/usage/classify.ts";
import { Usage, type UsageLog } from "../src/hub/usage/service.ts";
import { LEAD_RESUME_EVERY_MS, registerLeadCalls } from "../src/hub/usage/calls.ts";
import { register } from "../src/hub/usage/tools.ts";
import {
  BRAKE_STALE_MS,
  brake,
  brakeText,
  type Owner,
  type ParkedKind,
  resumedEvent,
  type Resumed,
  UsageState,
} from "../src/hub/usage/state.ts";
import { usage } from "../src/hub/usage/wire.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { NewEvent, WaitInput } from "../src/hub/store/events.ts";
import { isoMs } from "../src/hub/store/time.ts";
import { key, kit } from "./work-kit.ts";

const HOUR = 3_600_000;
const USAGE = ["usage_limit", "Claude usage limit reached. Send the message again once the limit resets."] as const;
const PROXY_400 = ["pool_exhausted", "API Error: 400 unknown provider for model claude-opus-5-5"] as const;

/** thread.usage_limited as the executor builds it from a failed summary. */
function limited(seq: number, atMs: number, thread: string, [cls, message]: readonly [string, string], reset?: number): HubEvent {
  const limit = classifyLimit({
    errorClass: cls,
    ...(reset !== undefined ? { resetAt: isoMs(reset) } : {}),
    at: isoMs(atMs),
    model: "claude-opus-5-5",
  });
  return {
    seq,
    at: isoMs(atMs),
    type: "thread.usage_limited",
    machineId: "lab-a",
    threadId: thread,
    summary: `${thread} hit a usage limit`,
    data: { error: { class: cls, message }, ...(limit ? limitData(limit) : {}) },
  } as HubEvent;
}

const appended = (seq: number, e: NewEvent): HubEvent => ({ ...e, seq }) as HubEvent;
const owner = (kind: ParkedKind, taskId?: string): Owner => ({ kind, ...(taskId ? { taskId } : {}) });

describe("state", () => {
  test("trips one breaker on two same-class limits within 10 minutes and resumes lead, review, write at the reset", () => {
    const s = new UsageState();
    const reset = 2 * HOUR;
    s.apply(limited(1, 0, "t2", USAGE, reset), owner("write", "T1"), undefined);
    expect(s.trip("lab-a", isoMs(0))).toBeUndefined();
    expect(s.gate("lab-a", 0)).toBeUndefined();
    s.apply(limited(2, 60_000, "t1", USAGE, reset), owner("lead"), undefined);
    const [event, until] = s.trip("lab-a", isoMs(60_000))!;
    expect(event.summary).toBe(
      "The usage limit was reached on lab-a's login; resets Thu 02:00 UTC; the lead and 1 task parked",
    );
    expect(until).toBe(isoMs(reset));
    expect((event.data as Record<string, unknown>).parked).toEqual({ leads: 1, tasks: 1 });
    s.apply(appended(3, event), undefined, undefined);
    expect(s.trip("lab-a", isoMs(60_000))).toBeUndefined();
    s.apply(limited(4, 120_000, "t3", USAGE, reset), owner("review", "T2"), undefined);
    expect(s.countsOn("lab-a")).toEqual({ leads: 1, tasks: 2 });
    expect(s.gate("lab-a", 120_000)).toBe("usage: paused until Thu 02:00 UTC (usage limit on lab-a's login)");
    expect(s.hold({ machineId: "lab-a", threadId: "t9" }, undefined, 120_000)).toBeDefined();
    expect(s.due(reset - 1)).toEqual([]);
    const due = s.due(reset);
    expect(due.length).toBe(1);
    expect(due[0]?.breakerCleared).toBe(true);
    expect(s.takeInOrder(due[0]!.threads).map((p) => p.thread.threadId)).toEqual(["t1", "t3", "t2"]);
    expect(s.gate("lab-a", reset)).toBeUndefined();
  });

  test("a limit on one account pauses only the work on it", () => {
    const alice = "p_aaaaaaaa";
    const s = new UsageState();
    const reset = 2 * HOUR;
    s.apply(limited(1, 0, "t1", USAGE, reset), owner("write", "T1"), alice);
    s.apply(limited(2, 60_000, "t2", USAGE, reset), owner("write", "T2"), alice);
    expect(s.trip("lab-a", isoMs(60_000))).toBeUndefined();
    const [event, until] = s.trip(`lab-a@${alice}`, isoMs(60_000))!;
    expect(until).toBe(isoMs(reset));
    expect(event.machineId).toBe("lab-a");
    expect((event.data as Record<string, unknown>).account).toEqual({ kind: "person", personId: alice });
    expect(event.summary).toContain(`${alice}'s subscription on lab-a`);
    const breaker = appended(3, event);
    const replayed = new UsageState();
    for (const e of [limited(1, 0, "t1", USAGE, reset), limited(2, 60_000, "t2", USAGE, reset)]) {
      replayed.apply(e, owner("write"), alice);
    }
    for (const state of [s, replayed]) {
      state.apply(breaker, undefined, undefined);
      expect(state.gate(`lab-a@${alice}`, 60_000)).toBeDefined();
      expect(state.gate("lab-a", 60_000)).toBeUndefined();
      expect(state.gate("lab-a@hub", 60_000)).toBeUndefined();
    }
    const bob = { machineId: "lab-a", threadId: "t9" };
    expect(s.hold(bob, "hub", 60_000)).toBeUndefined();
    expect(s.hold(bob, alice, 60_000)).toBeDefined();
    expect(s.countsOn(`lab-a@${alice}`).tasks).toBe(2);
    expect(s.countsOn("lab-a").tasks).toBe(0);
    const due = s.due(reset);
    expect(due.map((d) => d.machineId)).toEqual([`lab-a@${alice}`]);
    const resumed = resumedEvent(due[0]!.machineId, isoMs(reset), [], true, "reset")!;
    expect(resumed.machineId).toBe("lab-a");
    expect(((resumed.data as Record<string, any>).account as Record<string, string>).personId).toBe(alice);
    s.apply(appended(4, resumed), undefined, undefined);
    expect(s.gate(`lab-a@${alice}`, reset)).toBeUndefined();
  });

  test("limits more than 10 minutes apart, or twice on one thread, don't trip", () => {
    const s = new UsageState();
    s.apply(limited(1, 0, "t2", USAGE, 3 * HOUR), owner("write", "T1"), undefined);
    s.apply(limited(2, 11 * 60_000, "t1", USAGE, 3 * HOUR), owner("lead"), undefined);
    expect(s.trip("lab-a", isoMs(11 * 60_000))).toBeUndefined();
    const t = new UsageState();
    t.apply(limited(1, 0, "t2", USAGE, HOUR), owner("write", "T1"), undefined);
    t.apply(limited(2, 60_000, "t2", USAGE, HOUR), owner("write", "T1"), undefined);
    expect(t.trip("lab-a", isoMs(60_000))).toBeUndefined();
    expect(t.countsOn("lab-a")).toEqual({ leads: 0, tasks: 1 });
  });

  test("one pool_exhausted pauses until usage_resume", () => {
    const s = new UsageState();
    s.apply(limited(1, 0, "t2", PROXY_400), owner("write", "T1"), undefined);
    const [event, until] = s.trip("lab-a", isoMs(0))!;
    expect(event.summary).toBe(
      "your proxy has no account available for claude-opus-5-5; fleetd paused work on lab-a — check your proxy, then run usage_resume",
    );
    expect(until).toBeUndefined();
    s.apply(appended(2, event), undefined, undefined);
    expect(s.gate("lab-a", 24 * HOUR)).toBe("usage: paused until usage_resume (your proxy has no account for claude-opus-5-5)");
    expect(s.due(24 * HOUR)).toEqual([]);
    const sent: Resumed[] = s
      .takeInOrder(s.parkedOn("lab-a"))
      .map((p) => ({ threadId: p.thread.threadId, kind: p.kind, ...(p.taskId ? { taskId: p.taskId } : {}) }));
    const resumed = resumedEvent("lab-a", isoMs(24 * HOUR), sent, true, "ada")!;
    expect(resumed.summary).toBe('Usage pause on lab-a lifted (usage_resume by ada); sent "continue" to 1 parked thread');
    s.apply(appended(3, resumed), undefined, undefined);
    expect(s.gate("lab-a", 24 * HOUR)).toBeUndefined();
  });

  test("a park alone resumes at its reset without a breaker", () => {
    const s = new UsageState();
    s.apply(limited(1, 0, "t2", USAGE, HOUR), owner("write", "T1"), undefined);
    expect(s.due(HOUR - 1)).toEqual([]);
    const due = s.due(HOUR);
    expect([due.length, due[0]?.breakerCleared, due[0]?.threads.length]).toEqual([1, false, 1]);
    const e = resumedEvent("lab-a", isoMs(HOUR), [{ threadId: "t2", kind: "write", taskId: "T1" }], false, "reset")!;
    expect(e.summary).toBe('Usage limit reset on lab-a; sent "continue" to 1 parked thread');
    expect(resumedEvent("lab-a", isoMs(HOUR), [], false, "reset")).toBeUndefined();
  });
});

describe("the soft brake", () => {
  const agreed = (limits: LoginLimit[], braked: boolean, nowMs: number) => brake(limits, braked, nowMs, nowMs);
  const window = (kind: string, used: number | undefined, status: string, resetMs: number): LoginLimit => ({
    limitType: kind,
    ...(used !== undefined ? { utilization: used } : {}),
    resetsAt: isoMs(resetMs),
    status,
    observedAt: isoMs(0),
  });
  const text = (b: ReturnType<typeof brake>, m: string) => (b ? brakeText(b, m) : undefined);

  test("pauses at 90% and lifts below 85% or at the reset", () => {
    const reset = 14 * HOUR;
    const at = (used: number, braked: boolean) => agreed([window("five_hour", used, "allowed", reset)], braked, 0);
    expect(at(0.89, false)).toBeUndefined();
    expect(text(at(0.91, false), "builder-1")).toBe(
      "Paused new agents: 5-hour limit 91% on builder-1 as of Thu 00:00 UTC, resets Thu 14:00 UTC (pauses at 90%, lifts below 85%)",
    );
    expect(at(0.87, true)).toBeDefined();
    expect(at(0.84, true)).toBeUndefined();
    expect(agreed([window("five_hour", 0.95, "allowed", reset)], true, reset)).toBeUndefined();
  });

  test("the most used window brakes, and a warning counts only without a figure", () => {
    const reset = 14 * HOUR;
    const both = [window("five_hour", 0.92, "allowed", reset), window("seven_day", 0.97, "allowed_warning", 100 * HOUR)];
    expect(text(agreed(both, false, 0), "mbp")).toBe(
      "Paused new agents: 7-day limit 97% on mbp as of Thu 00:00 UTC, resets Mon 04:00 UTC (pauses at 90%, lifts below 85%)",
    );
    expect(agreed([window("seven_day", 0.75, "allowed_warning", reset)], false, 0)).toBeUndefined();
    expect(text(agreed([window("seven_day_opus", undefined, "allowed_warning", reset)], true, 0), "mbp")).toBe(
      "Paused new agents: 7-day Opus limit warning on mbp as of Thu 00:00 UTC, resets Thu 14:00 UTC (pauses at 90%, lifts below 85%)",
    );
    expect(agreed([window("five_hour", undefined, "allowed", reset)], false, 0)).toBeUndefined();
    expect(agreed([], true, 0)).toBeUndefined();
  });

  test("a reading's age, on the node's clock, ends one with no reset; one with its reset ahead holds", () => {
    const warned: LoginLimit = { limitType: "seven_day", status: "allowed_warning", observedAt: isoMs(0) };
    expect(text(agreed([warned], true, BRAKE_STALE_MS), "mbp")).toBe(
      "Paused new agents: 7-day limit warning on mbp as of Thu 00:00 UTC (pauses at 90%, lifts below 85%)",
    );
    expect(agreed([warned], true, BRAKE_STALE_MS + 1)).toBeUndefined();
    expect(agreed([{ limitType: "seven_day", status: "allowed_warning" }], true, 0)).toBeUndefined();
    const read = window("seven_day", 0.95, "allowed", 3 * 24 * HOUR);
    expect(text(agreed([read], true, 20 * 60_000), "mbp")).toBe(
      "Paused new agents: 7-day limit 95% on mbp as of Thu 00:00 UTC, resets Sun 00:00 UTC (pauses at 90%, lifts below 85%)",
    );
    expect(agreed([read], true, 3 * 24 * HOUR)).toBeUndefined();
    const noReset: LoginLimit = { limitType: "five_hour", utilization: 0.95, status: "allowed", observedAt: isoMs(0) };
    expect(brake([noReset], false, HOUR + 60_000, 60_000)).toBeDefined();
    expect(brake([noReset], true, 20 * 60_000 - HOUR, 20 * 60_000)).toBeUndefined();
    expect(text(agreed([{ ...window("five_hour", 0.95, "allowed", 0), resetsAt: "soon" }], false, 0), "mbp")).toBe(
      "Paused new agents: 5-hour limit 95% on mbp as of Thu 00:00 UTC (pauses at 90%, lifts below 85%)",
    );
  });
});

/** 2026-10-25T22:40:38Z. */
const T0 = 1_792_968_038_000;
const MIN = 60_000;
const COOLDOWN = "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down";

/** An in-memory log, a manual clock whose sleeps resolve as it moves, and the "continue"s sent. */
class Fake implements UsageLog {
  events: HubEvent[] = [];
  sent: string[] = [];
  ms = T0;
  private sleepers: { due: number; resolve: () => void }[] = [];

  push(atMs: number, type: string, thread: string, data: Record<string, unknown>) {
    this.events.push({
      seq: this.events.length + 1,
      at: isoMs(atMs),
      type,
      machineId: "devbox",
      threadId: thread,
      summary: `${thread} ${type}`,
      data,
    } as HubEvent);
    this.wake();
  }
  limited(atMs: number, thread: string, cls: string, resetMs?: number, failureModel?: string) {
    const limit = classifyLimit({
      errorClass: cls,
      ...(resetMs !== undefined ? { resetAt: isoMs(resetMs) } : {}),
      at: isoMs(atMs),
      model: "claude-opus-5-5",
      ...(failureModel ? { failureModel } : {}),
    })!;
    this.push(atMs, "thread.usage_limited", thread, { status: "failed", error: { class: cls, message: COOLDOWN }, ...limitData(limit) });
  }
  cooldown(atMs: number, thread: string) {
    this.limited(atMs, thread, "rate_limit", undefined, "claude-opus-5-5");
  }
  turn(atMs: number, type: string, thread: string) {
    this.push(atMs, type, thread, { status: "running", model: "claude-opus-5-5" });
  }
  last(type: string) {
    return this.events.findLast((e) => e.type === type);
  }

  append(e: NewEvent): HubEvent {
    const event = { ...e, seq: this.events.length + 1 } as HubEvent;
    this.events.push(event);
    this.wake();
    return event;
  }
  head() {
    return this.events.length;
  }
  private waiters: (() => void)[] = [];
  /** As the real log: returns at once with what matches, else waits for the next append (or the signal). */
  async wait(input: WaitInput, signal?: AbortSignal) {
    const page = () => ({
      events: this.events.slice(input.cursor ?? 0).filter((e) => input.types?.includes(e.type)),
      cursor: this.events.length,
      more: false,
    });
    while (input.timeoutSec > 0 && page().events.length === 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return page();
  }
  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.sleepers.push({ due: this.ms + ms, resolve }));
  }
  clearSleepers() {
    this.sleepers = [];
  }
  /** Moves the clock and lets the woken timers run. */
  async advance(ms: number) {
    await settle();
    this.ms += ms;
    const due = this.sleepers.filter((s) => s.due <= this.ms);
    this.sleepers = this.sleepers.filter((s) => s.due > this.ms);
    for (const s of due) s.resolve();
    await settle();
  }
}

/** Lets queued timers and ops run to their next sleep. */
async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

const OWNERS: Record<string, Owner> = {
  lead: { kind: "lead" },
  w1: { kind: "write", taskId: "T1" },
  w2: { kind: "write", taskId: "T2" },
  r1: { kind: "review", taskId: "T3" },
};

function service() {
  const fake = new Fake();
  const u = new Usage({
    events: fake,
    clock: { now: () => fake.ms },
    sleep: (ms) => fake.sleep(ms),
    ownerOf: (t) => OWNERS[t.threadId],
    stillParked: () => true,
    accountOf: () => undefined,
    sendContinue: async (t) => void fake.sent.push(t.threadId),
  });
  return { fake, u };
}

async function proxyPause(fake: Fake, u: Usage) {
  fake.cooldown(T0, "w1");
  fake.cooldown(T0 + 400, "r1");
  fake.cooldown(T0 + 900, "w2");
  await u.drain();
}

describe("the service", () => {
  test("a proxy cooldown pauses with no made-up reset", async () => {
    const { fake, u } = service();
    await proxyPause(fake, u);
    const breaker = fake.last("usage.breaker")!;
    expect(breaker.summary).toBe("Rate-limited by your proxy on devbox; checking again shortly; 2 tasks parked");
    const data = breaker.data as Record<string, unknown>;
    expect(data.until).toBeUndefined();
    expect(data.checkAt).toBe(isoMs(T0 + MIN));
    expect(u.gate("devbox")).toBe("usage: rate-limited by your proxy on devbox, checking again shortly");
    const status = await u.status("devbox", { error: "offline" });
    expect([status.breaker.until, status.breaker.checkAt, status.breaker.proxy]).toEqual([undefined, isoMs(T0 + MIN), true]);
    expect(status.login).toBe("unknown");
  });

  test("the lead's successful turn on the paused login resumes every parked agent", async () => {
    const { fake, u } = service();
    fake.turn(T0 - 5_000, "thread.started", "lead");
    await proxyPause(fake, u);
    fake.turn(T0 + 2_000, "thread.completed", "lead");
    await u.drain();
    expect(u.gate("devbox")).toBeDefined();
    fake.turn(T0 + 10_000, "thread.started", "lead");
    fake.push(T0 + 20_000, "thread.failed", "lead", { status: "failed" });
    fake.turn(T0 + 25_000, "thread.completed", "lead");
    await u.drain();
    expect(u.gate("devbox")).toBeDefined();
    expect(fake.sent).toEqual([]);
    fake.turn(T0 + 30_000, "thread.started", "lead");
    fake.push(T0 + 45_000, "thread.completed", "lead", { status: "completed", model: "claude-opus-5-5-20261020" });
    await u.drain();
    expect(u.gate("devbox")).toBeUndefined();
    expect(fake.sent).toEqual(["r1", "w1", "w2"]);
    const resumed = fake.last("usage.resumed")!;
    expect(resumed.summary).toBe(
      'Usage pause on devbox lifted (a turn on its login succeeded); sent "continue" to 3 parked threads',
    );
    expect((resumed.data as Record<string, unknown>).by).toBe("turn");
  });

  test("with no reset, one parked thread is tried on a backoff until its turn completes", async () => {
    const { fake, u } = service();
    await proxyPause(fake, u);
    await fake.advance(MIN - 1);
    expect(fake.sent).toEqual([]);
    await fake.advance(1);
    expect(fake.sent).toEqual(["r1"]);
    expect(u.gate("devbox")).toBeDefined();
    expect(fake.last("usage.resumed")?.summary).toBe('Trying devbox\'s login again; sent "continue" to 1 parked thread');
    const first = T0 + MIN;
    fake.turn(first + 1_000, "thread.started", "r1");
    await u.drain();
    await fake.advance(2 * MIN);
    expect(u.gate("devbox")).toBeDefined();
    expect(fake.sent).toEqual(["r1"]);
    const failed = first + 2 * MIN + 30_000;
    fake.cooldown(failed, "r1");
    await u.drain();
    await fake.advance(30_000 + 2 * MIN - 1);
    expect(fake.sent).toEqual(["r1"]);
    await fake.advance(1);
    expect(fake.sent).toEqual(["r1", "r1"]);
    const second = failed + 2 * MIN;
    fake.turn(second + 1_000, "thread.started", "r1");
    fake.cooldown(second + 41_000, "r1");
    await u.drain();
    expect(u.gate("devbox")).toBeDefined();
    await fake.advance(10 * MIN);
    expect(fake.sent).toEqual(["r1", "r1", "r1"]);
    fake.turn(second + 10 * MIN + 1_000, "thread.started", "r1");
    fake.turn(second + 10 * MIN + 41_000, "thread.completed", "r1");
    await u.drain();
    expect(u.gate("devbox")).toBeUndefined();
    expect(fake.sent).toEqual(["r1", "r1", "r1", "w1", "w2"]);
    expect(fake.last("usage.resumed")?.summary).toBe(
      'Usage pause on devbox lifted (a turn on its login succeeded); sent "continue" to 2 parked threads',
    );
  });

  test("a check with nothing left to try says so", async () => {
    const { fake, u } = service();
    fake.cooldown(T0, "x1");
    fake.cooldown(T0 + 500, "x2");
    await u.drain();
    expect(u.gate("devbox")).toBeDefined();
    await fake.advance(MIN);
    expect(u.gate("devbox")).toBeUndefined();
    expect(fake.sent).toEqual([]);
    const lifted = fake.last("usage.resumed")!;
    expect(lifted.summary).toBe(
      "Usage pause on devbox lifted (nothing was left parked to check it with; the next turn there tries the login)",
    );
    expect((lifted.data as Record<string, unknown>).by).toBe("unchecked");
  });

  test("a park alone with no reset is tried again after a minute, then two", async () => {
    const { fake, u } = service();
    fake.cooldown(T0, "w1");
    await u.drain();
    expect(fake.last("usage.breaker")).toBeUndefined();
    const parked = u.parkedOf({ machineId: "devbox", threadId: "w1" })!;
    expect([parked.resumeAt, parked.checkAt, parked.proxy]).toEqual([undefined, isoMs(T0 + MIN), true]);
    await fake.advance(MIN);
    expect(fake.sent).toEqual(["w1"]);
    fake.cooldown(T0 + MIN + 5_000, "w1");
    await u.drain();
    await fake.advance(2 * MIN + 4_999);
    expect(fake.sent).toEqual(["w1"]);
    await fake.advance(1);
    expect(fake.sent).toEqual(["w1", "w1"]);
  });

  const leadsTurnOnSonnet = (fake: Fake) => {
    fake.turn(T0 + 30_000, "thread.started", "lead");
    fake.push(T0 + 45_000, "thread.completed", "lead", { status: "completed", model: "claude-sonnet-5-5" });
  };

  test("a known reset waits for itself whatever turns complete meanwhile; so does a drained proxy pool", async () => {
    const reset = T0 + 3 * HOUR;
    {
      const { fake, u } = service();
      fake.limited(T0, "w1", "usage_limit", reset);
      fake.limited(T0 + 500, "r1", "usage_limit", reset);
      await u.drain();
      expect((fake.last("usage.breaker")?.data as Record<string, unknown>).until).toBe(isoMs(reset));
      leadsTurnOnSonnet(fake);
      await u.drain();
      expect(u.gate("devbox")).toBeDefined();
      expect(fake.sent).toEqual([]);
      expect(fake.last("usage.resumed")).toBeUndefined();
    }
    {
      const { fake, u } = service();
      fake.limited(T0, "w1", "usage_limit", reset);
      await u.drain();
      leadsTurnOnSonnet(fake);
      await u.drain();
      expect(fake.sent).toEqual([]);
    }
    {
      const { fake, u } = service();
      fake.limited(T0, "w1", "pool_exhausted", undefined, "claude-opus-5-5");
      await u.drain();
      expect(fake.last("usage.breaker")).toBeDefined();
      leadsTurnOnSonnet(fake);
      await u.drain();
      expect(u.gate("devbox")).toBeDefined();
      expect(fake.sent).toEqual([]);
    }
  });

  test("a completed turn lifts only what named no reset", async () => {
    const { fake, u } = service();
    await proxyPause(fake, u);
    fake.limited(T0 + 2_000, "lead", "usage_limit", T0 + 3 * HOUR);
    await u.drain();
    fake.turn(T0 + 30_000, "thread.started", "x9");
    fake.turn(T0 + 45_000, "thread.completed", "x9");
    await u.drain();
    expect(u.gate("devbox")).toBeUndefined();
    expect(fake.sent).toEqual(["r1", "w1", "w2"]);
  });

  test("a replay at start rebuilds the pause and fires its reset", async () => {
    const { fake, u } = service();
    const reset = T0 + HOUR;
    fake.limited(T0, "w1", "usage_limit", reset);
    fake.limited(T0 + 500, "r1", "usage_limit", reset);
    await u.drain();
    const breaker = fake.last("usage.breaker")!;
    // A new hub over the same log, the old one gone with its timers.
    fake.events = fake.events.filter((e) => e.seq <= breaker.seq);
    fake.clearSleepers();
    const again = new Usage({
      events: fake,
      clock: { now: () => fake.ms },
      sleep: (ms) => fake.sleep(ms),
      ownerOf: (t) => OWNERS[t.threadId],
      stillParked: () => true,
      accountOf: () => undefined,
      sendContinue: async (t) => void fake.sent.push(t.threadId),
    });
    const stop = new AbortController();
    void again.serve(stop.signal);
    await settle();
    expect(again.gate("devbox")).toBe("usage: paused until Sun 23:40 UTC (usage limit on devbox's login)");
    await fake.advance(HOUR);
    expect(fake.sent).toEqual(["r1", "w1"]);
    expect(again.gate("devbox")).toBeUndefined();
    stop.abort();
  });
});

describe("the hub's tools and lead call", () => {
  test("usage_status and usage_resume over the hub, and a lead's resume once per 10 minutes", async () => {
    const { hub, tools, clock, ok, refused } = kit(T0);
    register(tools);
    store(hub).machineUpsert({ machineId: "devbox", name: "devbox", status: "online" } as never);
    const log = events(hub);
    for (const [i, thread] of ["w1", "w2"].entries()) {
      log.append({
        at: isoMs(T0 + i * 1000),
        type: "thread.usage_limited",
        machineId: "devbox",
        threadId: thread,
        summary: "hit the usage limit",
        data: { usageClass: "usage_limit", resumeAt: isoMs(T0 + HOUR) },
      });
    }
    await usage(hub).drain();
    const status = await ok(key("read"), "usage_status", {});
    expect(status.machines.map((m: any) => [m.machineId, m.login, m.breaker.state])).toEqual([["devbox", "unknown", "open"]]);
    expect(status.next).toStartWith("Paused: devbox.");
    expect(await refused(key("read"), "usage_status", { machineId: "nope" })).toBe("not_found");

    registerLeadCalls(hub);
    const caller = {
      projectRef: { machineId: "devbox", projectId: "app" },
      by: "lead:devbox/app",
      agent: { kind: "lead" },
    } as never;
    const call = (machineId?: string) =>
      leadCalls(hub).handler("usage_resume")!(caller, { op: "usage_resume", ...(machineId ? { machineId } : {}) } as never);
    await expect(call("other")).rejects.toThrow("A lead resumes only the machine its project runs on (devbox), not other.");
    const first = (await call()) as Record<string, unknown>;
    expect(first).toMatchObject({ machineId: "devbox", resumed: 0, breakerCleared: true });
    clock.ms += LEAD_RESUME_EVERY_MS - 1;
    await expect(call()).rejects.toThrow("You resumed devbox at");
    const resumed = await ok(key("operate"), "usage_resume", { machineId: "devbox" });
    expect([resumed.resumed, resumed.status.breaker.state]).toEqual([0, "closed"]);
  });
});
