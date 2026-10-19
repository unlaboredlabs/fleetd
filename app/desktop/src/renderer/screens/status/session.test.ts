import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures";
import { armAgeRedraw, type Timers } from "./hooks";
import { hubNow, Looked, phase, type StatusRead } from "./session";

const doc = fixture("fleet");
const read = (over: Partial<StatusRead>): StatusRead => ({ doc, receivedMs: 0, fresh: true, error: null, ...over });

describe("what the Status view shows", () => {
  it("is the skeleton until this connection's status_get answered, never a kept number", () => {
    // The data layer drops every answer when the link drops or a snapshot arrives, so no doc is what a reconnect leaves.
    expect(phase(read({ doc: undefined, fresh: false }))).toBe("skeleton");
    expect(phase(read({ doc: undefined }))).toBe("skeleton");
  });

  it("is live only with a doc from a fresh link whose last read succeeded", () => {
    expect(phase(read({}))).toBe("live");
    expect(phase(read({ error: "boom" })), "a failed refresh keeps the doc, marked not live").toBe("notLive");
    expect(phase(read({ fresh: false }))).toBe("notLive");
  });

  it("carries the hub's clock forward from the doc's now", () => {
    const now = Date.parse(doc.now);
    expect(hubNow(read({ receivedMs: 1_000 }), 61_000)).toBe(now + 60_000);
    expect(hubNow(read({ doc: undefined }), 5)).toBe(5);
  });

  it("counts a look after three focused seconds in total", () => {
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

describe("the age clock on a quiet live view", () => {
  it("still redraws when new answers keep re-arming it", () => {
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
    // One age on screen, "stale 11m" since 09:55:45 at the doc's 10:07:12: it next reads differently 33 s later,
    // longer than the gap between answers, which is where a clock taken at the last paint froze it.
    const ages = (n: number): number[] => [n - Date.parse("2026-10-19T09:55:45.000Z")];
    let r = read({});
    let redraws = 0;
    let cancel = armAgeRedraw(r, ages, t, () => (redraws += 1));
    for (let tick = 0; tick < 3 && redraws === 0; tick++) {
      for (const step = now + 25_000; now < step; now += 1_000) {
        for (const timer of timers.filter((x) => x.live && x.at <= now)) {
          timer.live = false;
          timer.fn();
        }
      }
      // Each answer hands the view a new read, which re-arms the timer.
      r = { ...r };
      cancel();
      cancel = armAgeRedraw(r, ages, t, () => (redraws += 1));
    }
    expect(redraws, "an age changes within a minute, so the view must redraw within one").toBeGreaterThan(0);
    expect(now).toBeLessThanOrEqual(50_000);
  });
});
