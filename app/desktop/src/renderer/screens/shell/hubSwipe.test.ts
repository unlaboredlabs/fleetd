// The sidebar's swipe between hubs, as a gesture: one axis a gesture, a scroll never a swipe, the momentum after the
// fingers lift letting it go and then swallowed, and the spring that settles it never passing its target.
import { describe, expect, it } from "vitest";
import { GAP_MS, IDLE, settleOn, shown, spring, stepHub, wheel, type Gesture, type Wheel } from "./hubSwipe";

/** Runs `events` through a gesture from rest, each 10 ms after the one before. */
const run = (deltas: ReadonlyArray<readonly [number, number]>, from: Gesture = IDLE, start = 0) => {
  let g = from;
  const steps = deltas.map(([dx, dy], i) => {
    const e: Wheel = { dx, dy, at: start + i * 10 };
    const s = wheel(g, e);
    g = s.g;
    return s;
  });
  return { g, steps };
};

describe("wheel", () => {
  it("takes a horizontal swipe as one, the list moving against the wheel", () => {
    const { g, steps } = run([[3, 0], [5, 1], [8, 0], [10, 1]]);
    expect(g.phase).toBe("drag");
    expect(-g.x).toBe(-26);
    // The first small delta doesn't decide yet; from the decision on, every event is the swipe's.
    expect(steps.map((s) => s.claim)).toEqual([false, true, true, true]);
  });

  it("never takes a vertical scroll for a swipe, its sideways drift and momentum included", () => {
    const { g, steps } = run([[1, 4], [2, 8], [12, 6], [20, 4], [30, 2], [2, 1]]);
    expect(g.phase).toBe("vertical");
    expect(steps.some((s) => s.claim)).toBe(false);
  });

  it("lets go as the deltas die away (the momentum after the fingers lift), then swallows the rest until a pause", () => {
    const { g, steps } = run([[4, 0], [10, 0], [20, 0], [24, 0], [18, 0], [12, 0], [8, 0], [5, 0], [3, 0], [2, 0]]);
    const released = steps.findIndex((s) => s.release);
    // The third fall in a row, under 60% of the peak (24).
    expect(released).toBe(6);
    expect(steps.filter((s) => s.release)).toHaveLength(1);
    expect(g.phase).toBe("drain");
    expect(steps.slice(released).every((s) => s.claim)).toBe(true);
    // A pause, and the next one is a new gesture.
    const after = wheel(g, { dx: 6, dy: 0, at: 90 + GAP_MS + 1 });
    expect(after.g.phase).toBe("drag");
  });

  it("starts afresh after a pause, whichever axis came before", () => {
    const { g } = run([[0, 10], [0, 10]]);
    expect(g.phase).toBe("vertical");
    expect(wheel(g, { dx: 10, dy: 0, at: 10 + GAP_MS + 1 }).g.phase).toBe("drag");
  });
});

describe("shown", () => {
  it("follows the fingers up to a whole width toward a hub that is there", () => {
    expect(shown(-100, 256, false, true)).toBe(-100);
    expect(shown(-400, 256, false, true)).toBe(-256);
    expect(shown(120, 256, true, false)).toBe(120);
  });

  it("gives only a little toward an end", () => {
    const give = shown(300, 256, false, true);
    expect(give).toBeGreaterThan(0);
    expect(give).toBeLessThan(256 * 0.16);
    expect(shown(-300, 256, true, false)).toBeCloseTo(-give);
  });
});

describe("settleOn", () => {
  it("settles on the nearer hub, a flick carrying a little further", () => {
    expect(settleOn(-140, 0, 256, true, true)).toBe(-256);
    expect(settleOn(-100, 0, 256, true, true)).toBe(0);
    expect(settleOn(-100, -0.6, 256, true, true)).toBe(-256);
    expect(settleOn(140, 0, 256, true, true)).toBe(256);
    // Never toward a hub that isn't there.
    expect(settleOn(-200, -1, 256, true, false)).toBe(0);
  });
});

describe("spring", () => {
  it("comes to rest on its target without passing it, even thrown at it", () => {
    for (const v of [0, -0.5, -3, 2]) {
      let x = 0;
      let speed = v;
      let past = false;
      for (let i = 0; i < 120; i++) {
        const s = spring(x, speed, -256, 16);
        x = s.x;
        speed = s.v;
        if (x < -256) past = true;
        if (s.done) break;
      }
      expect(past).toBe(false);
      expect(x).toBe(-256);
    }
  });

  it("settles in about a third of a second from a standing start", () => {
    let x = 0;
    let v = 0;
    let t = 0;
    for (; t < 1000; t += 16) {
      const s = spring(x, v, -256, 16);
      x = s.x;
      v = s.v;
      if (s.done) break;
    }
    expect(t).toBeGreaterThan(150);
    expect(t).toBeLessThan(450);
  });
});

describe("stepHub", () => {
  it("goes round the ends, and nowhere with one hub", () => {
    expect(stepHub(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepHub(["a", "b", "c"], "a", -1)).toBe("c");
    expect(stepHub(["a", "b"], "a", 1)).toBe("b");
    expect(stepHub(["a"], "a", 1)).toBeNull();
  });
});
