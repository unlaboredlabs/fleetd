import { describe, expect, it } from "vitest";
import type { CallOutcome } from "../../../shared/hub";
import type { StatusDoc, StatusScope } from "./contracts";
import { fixture } from "./fixtures";
import { StatusController, type StatusHub, type Timers } from "./controller";
import { initial, Looked, phase, reduce, WAIT_DEADLINE_MS, WAIT_SEC, type Action, type Effect, type StatusSession } from "./session";

const fleet: StatusScope = { kind: "fleet" };
const doc = (version: number, scope: StatusScope = fleet): StatusDoc => ({ ...fixture("fleet"), scope, version });

/** Runs actions from a live link, returning the state and every effect, in order. */
const run = (actions: readonly Action[], from: StatusSession = { ...initial, linkUp: true }, now = 1_000) => {
  let s = from;
  const effects: Effect[] = [];
  for (const a of actions) {
    const [next, out] = reduce(s, a, now);
    s = next;
    effects.push(...out);
  }
  return { s, effects };
};
const ok = (output: unknown) => ({ ok: true as const, output });
const answer = (tool: "status_get" | "status_wait", generation: number, output: unknown): Action => ({ t: "answer", tool, generation, outcome: ok(output) });

describe("the status session", () => {
  it("gets, then holds one wait after each version, and never polls", () => {
    const opened = run([{ t: "open", scope: fleet }]);
    expect(phase(opened.s)).toBe("skeleton");
    expect(opened.effects.map((e) => e.call.tool)).toEqual(["status_get"]);
    const g = opened.s.generation;

    const live = run([answer("status_get", g, { doc: doc(4) })], opened.s);
    expect(phase(live.s)).toBe("live");
    expect(live.effects).toEqual([{ call: { tool: "status_wait", input: { scope: fleet, after: 4, timeoutSec: WAIT_SEC } }, generation: g }]);
    expect(live.s.waitDeadline).toBe(1_000 + WAIT_DEADLINE_MS);

    const unchanged = run([answer("status_wait", g, { unchanged: true, version: 4 })], live.s);
    expect(unchanged.effects.map((e) => [e.call.tool, "after" in e.call.input ? e.call.input.after : null])).toEqual([["status_wait", 4]]);

    const moved = run([answer("status_wait", g, { doc: doc(5), version: 5 })], unchanged.s);
    expect(moved.s.doc?.version).toBe(5);
    expect(moved.effects).toHaveLength(1);
  });

  it("greys on a dropped link, then shows a skeleton until the hub answers again", () => {
    const { s } = run([{ t: "open", scope: fleet }, answer("status_get", 1, { doc: doc(4) })]);
    const down = run([{ t: "link", up: false }], s);
    expect(phase(down.s)).toBe("notLive");
    expect(down.s.doc?.version).toBe(4);
    expect(down.s.waitDeadline).toBeNull();
    const up = run([{ t: "link", up: true }], down.s);
    expect(phase(up.s), "never the cached doc as if live").toBe("skeleton");
    expect(up.effects.map((e) => e.call.tool)).toEqual(["status_get"]);
    expect(up.s.session).toBeGreaterThan(s.session);
  });

  it("drops answers asked before a close, a scope switch or a reconnect", () => {
    const { s } = run([{ t: "open", scope: fleet }]);
    const old = s.generation;
    const switched = run([{ t: "open", scope: { kind: "order", workstreamId: "W14" } }, answer("status_get", old, { doc: doc(4) })], s);
    expect(phase(switched.s)).toBe("skeleton");
    expect(switched.effects.map((e) => e.call.tool)).toEqual(["status_get"]);

    const bounced = run([{ t: "link", up: false }, { t: "link", up: true }, answer("status_get", old, { doc: doc(4) })], s);
    expect(phase(bounced.s)).toBe("skeleton");
  });

  it("refuses a doc for another scope instead of showing it", () => {
    const { s } = run([{ t: "open", scope: fleet }, answer("status_get", 1, { doc: doc(4, { kind: "order", workstreamId: "W1" }) })]);
    expect(phase(s)).toBe("skeleton");
    expect(s.error).toMatch(/another scope/u);
    expect(s.retry).toBe(true);
  });

  it("a failed or malformed answer stops being live and offers Retry", () => {
    const { s } = run([{ t: "open", scope: fleet }, answer("status_get", 1, { doc: doc(4) })]);
    const failed = run([{ t: "answer", tool: "status_wait", generation: s.generation, outcome: { ok: false, message: "boom" } }], s);
    expect(phase(failed.s)).toBe("notLive");
    expect(failed.s.retry).toBe(true);
    expect(failed.s.session, "no tween across the gap").toBeGreaterThan(s.session);
    expect(run([{ t: "retry" }], failed.s).effects.map((e) => e.call.tool)).toEqual(["status_get"]);

    const junk = run([answer("status_wait", s.generation, { version: "4" })], s);
    expect(phase(junk.s)).toBe("notLive");
  });

  it("a wait past its deadline is not live at once and asks again, once", () => {
    const { s } = run([{ t: "open", scope: fleet }, answer("status_get", 1, { doc: doc(4) })]);
    const deadline = s.waitDeadline ?? 0;
    expect(run([{ t: "deadline", generation: s.generation }], s, deadline - 1).effects).toEqual([]);
    const missed = run([{ t: "deadline", generation: s.generation }], s, deadline);
    expect(phase(missed.s)).toBe("notLive");
    expect(missed.s.error).toMatch(/hasn't answered for 35s/u);
    expect(missed.effects.map((e) => e.call.tool)).toEqual(["status_get"]);
    // The lost wait's answer, if it ever comes, is dropped; and the old timer firing again does nothing.
    expect(run([answer("status_wait", s.generation, { doc: doc(9) })], missed.s).s.doc?.version).toBe(4);
    expect(run([{ t: "deadline", generation: s.generation }], missed.s, deadline + 60_000).effects).toEqual([]);
  });

  it("records the look on leaving only after a real look, and only on a live link", () => {
    const { s } = run([{ t: "open", scope: fleet }, answer("status_get", 1, { doc: doc(4) })]);
    expect(run([{ t: "close", looked: true }], s).effects).toEqual([
      { call: { tool: "status_seen", input: { scope: fleet, seq: 4810 } }, generation: -1 },
    ]);
    expect(run([{ t: "close", looked: false }], s).effects).toEqual([]);
    expect(run([{ t: "link", up: false }, { t: "close", looked: true }], s).effects).toEqual([]);
    expect(phase(run([{ t: "close", looked: true }], s).s)).toBe("closed");
  });

  it("a look counts after three focused seconds in total", () => {
    const l = new Looked();
    l.set(true, 0);
    l.set(false, 2_000);
    l.set(true, 10_000);
    expect(l.take(10_500)).toBe(false);
    l.set(true, 0);
    l.set(false, 2_000);
    l.set(true, 10_000);
    expect(l.take(11_000)).toBe(true);
    expect(l.take(60_000), "taking resets it").toBe(false);
  });
});

describe("the controller", () => {
  const harness = () => {
    let now = 0;
    const timers: { at: number; fn: () => void; live: boolean }[] = [];
    const t: Timers = {
      now: () => now,
      set: (fn, ms) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return () => (timer.live = false);
      },
    };
    const calls: { tool: string; resolve: (o: CallOutcome) => void }[] = [];
    let link: ((up: boolean) => void) | null = null;
    const hub: StatusHub = {
      call: (tool) => new Promise((resolve) => calls.push({ tool, resolve })),
      onLink: (l) => {
        link = l;
        l(true);
        return () => (link = null);
      },
    };
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers.filter((x) => x.live && x.at <= now)) {
        timer.live = false;
        timer.fn();
      }
    };
    return { c: new StatusController(hub, t), calls, timers, advance, link: () => link };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("keeps one wait out with one deadline timer, and resyncs when the wait is lost", async () => {
    const h = harness();
    h.c.open(fleet);
    h.calls[0]?.resolve({ ok: true, output: { doc: doc(4) } });
    await settle();
    expect(h.calls.map((c) => c.tool)).toEqual(["status_get", "status_wait"]);
    expect(h.timers.filter((t) => t.live)).toHaveLength(1);
    h.advance(WAIT_DEADLINE_MS);
    expect(phase(h.c.state)).toBe("notLive");
    expect(h.calls.map((c) => c.tool)).toEqual(["status_get", "status_wait", "status_get"]);
    expect(h.timers.filter((t) => t.live), "no timer while no wait is out").toHaveLength(0);
  });

  it("stops following the link when the view closes", () => {
    const h = harness();
    h.c.open(fleet);
    expect(h.link()).not.toBeNull();
    h.c.close(false);
    expect(h.link()).toBeNull();
  });
});
