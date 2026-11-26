import { describe, expect, it } from "vitest";
import { minuteClock, type Timers } from "./minuteClock";

const fake = (start: number) => {
  let now = start;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  const t: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { t, advance, live: () => timers.size };
};

describe("minuteClock", () => {
  it("runs one timer for every view that follows it, and none once they've all gone", () => {
    const f = fake(10_000);
    const clock = minuteClock(f.t);
    const offs = Array.from({ length: 80 }, () => clock.subscribe(() => undefined));
    expect(f.live()).toBe(1);
    for (const off of offs) off();
    expect(f.live()).toBe(0);
  });

  it("ticks just past each minute, telling every view at once", () => {
    const f = fake(10_000);
    const clock = minuteClock(f.t);
    let heard = 0;
    clock.subscribe(() => heard++);
    clock.subscribe(() => heard++);
    f.advance(49_000);
    expect(heard).toBe(0);
    f.advance(2_000);
    expect(heard).toBe(2);
    expect(clock.now()).toBe(60_050);
    f.advance(60_000);
    expect(heard).toBe(4);
    expect(f.live()).toBe(1);
  });

  it("holds the same time between ticks, and starts from now when a view follows it again", () => {
    const f = fake(0);
    const clock = minuteClock(f.t);
    const off = clock.subscribe(() => undefined);
    f.advance(30_000);
    expect(clock.now()).toBe(0);
    off();
    f.advance(600_000);
    clock.subscribe(() => undefined);
    expect(clock.now()).toBe(630_000);
  });
});
