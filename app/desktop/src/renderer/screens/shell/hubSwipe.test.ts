// The sidebar's swipe between hubs, as a gesture: one axis a gesture, a scroll never a swipe and never swallowed, a
// glide never moving the list, the next touch a new gesture at once; where a touch begins told by the platform (Chromium
// on a Mac: its first event the only cancelable one) or by the deltas alone (Linux, Safari, Firefox), on the same Mac
// trackpad sequences. And the spring that settles it never passing its target.
import { describe, expect, it } from "vitest";
import { IDLE, settleOn, shown, spring, stepHub, wheel, type Gesture, type Step } from "./hubSwipe";
import { FINGERS, fingers, momentum, scrollDown, swipe, swipeFingers, type Scroll } from "./hubSwipe.samples";

/**
 * Plays the wheel events a page gets of a trackpad's scrolls through a gesture from rest: with `touches`, each saying
 * whether it begins a touch, as Chromium on a Mac does (the fingers' began). Each one's step, in order.
 */
const play = (scrolls: readonly Scroll[], touches: boolean, from: Gesture = IDLE, pause = 16) => {
  let g = from;
  // On from the gesture given, `pause` ms after its last event.
  let t = Number.isFinite(from.at) ? from.at + pause : 1000;
  const steps: Step[] = [];
  let releases = 0;
  for (const s of scrolls) {
    if (s.dx !== 0 || s.dy !== 0) {
      const step = wheel(g, { dx: s.dx, dy: s.dy, at: t, ...(touches ? { began: s.phase === FINGERS.began } : {}) });
      g = step.g;
      steps.push(step);
      if (step.release) releases++;
    }
    t += s.wait;
  }
  return { g, steps, releases, claimed: steps.filter((s) => s.claim).length };
};

describe.each([
  ["the platform's word on where a touch begins", true],
  ["the deltas alone", false],
])("wheel, told by %s", (_, touches) => {
  it("takes a swipe as one: it lets go once, and its glide is swallowed", () => {
    const { g, steps, releases } = play(swipe(1), touches);
    expect(releases).toBe(1);
    expect(g.phase).toBe("glide");
    expect(g.swiped).toBe(true);
    // From the event that picks the axis on, every one is the swipe's, its glide's included.
    const first = steps.findIndex((s) => s.claim);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(4);
    expect(steps.slice(first).every((s) => s.claim)).toBe(true);
  });

  it("takes the next swipe at once, back or on, while the last one's glide is still arriving", () => {
    for (const side of [-1, 1] as const) {
      const first = play(swipe(1, 20), touches);
      const { g, releases } = play(swipe(side), touches, first.g);
      expect(first.releases + releases).toBe(2);
      // The second gesture went its own way.
      expect(Math.sign(g.x)).toBe(side);
    }
  });

  it("never lets a glide go a second time, however long", () => {
    // A flick's glide, long and strong: two seconds of it.
    const flick = play([...swipeFingers(1), ...momentum([30, 0], { decay: 0.97 })], touches);
    expect(flick.releases).toBe(1);
    expect(flick.steps.length).toBeGreaterThan(100);
  });

  it("never takes a scroll up or down the list, or across it, for a swipe, and never swallows it", () => {
    const diagonal = [...fingers([[2, 2], [5, 4], [9, 8], [12, 11], [10, 10], [6, 6]]), ...momentum([5, 5])];
    for (const scroll of [scrollDown(), diagonal]) {
      const { claimed, releases } = play(scroll, touches);
      expect(claimed).toBe(0);
      expect(releases).toBe(0);
    }
  });

  it("never swallows a scroll that starts while a swipe's glide is still arriving", () => {
    const first = play(swipe(1, 20), touches);
    const { claimed, g } = play(scrollDown(), touches, first.g);
    expect(claimed).toBe(0);
    expect(g.swiped).toBe(false);
  });
});

describe("wheel, told by the deltas alone", () => {
  it("starts afresh after a pause, whichever axis came before", () => {
    const { g } = play(scrollDown(), false);
    expect(g.phase).toBe("vertical");
    expect(wheel(g, { dx: 10, dy: 0, at: g.at + 101 }).g.phase).toBe("drag");
  });

  it("lets go at once of a glide that runs on past a pause, as a run sideways that only shrinks", () => {
    const first = play(swipe(1, 20), false);
    const { steps, releases, g } = play(momentum([9, 0], { decay: 0.97 }), false, first.g, 150);
    expect(releases).toBe(1);
    expect(steps.find((s) => s.release)?.back).toBe(true);
    expect(g.phase).toBe("glide");
  });

  it("takes a first event that is already far sideways for fingers, after rest: a flick, or a start handed over as one lump", () => {
    for (const deltas of [[30, 28, 26, 22, 18, 14], [14, 12, 16, 20, 20, 16, 12], [24, 12, 18, 20, 20, 16, 12]]) {
      const { steps } = play([...fingers(deltas.map((d) => [d, 0] as const)), ...momentum([10, 0])], false);
      expect(steps.some((s) => s.back === true)).toBe(false);
      expect(steps.filter((s) => s.release)).toHaveLength(1);
    }
  });

  it("takes a flick for fingers once the last glide has been still 400 ms (from rest), and one back at once mid-glide", () => {
    const flick = (side: 1 | -1) => [...fingers([30, 28, 26, 22, 18, 14].map((d) => [d * side, 0] as const)), ...momentum([10 * side, 0])];
    const rest = play(flick(1), false, play(swipe(1), false).g, 410);
    expect(rest.steps.some((s) => s.back === true)).toBe(false);
    expect(rest.releases).toBe(1);
    const back = play(flick(-1), false, play(swipe(1, 8), false).g);
    expect(back.releases).toBe(1);
    expect(Math.sign(back.g.x)).toBe(-1);
    // And back after a pause of any length: a glide never turns back, so that is fingers too, a lump start included.
    for (const pause of [16, 120, 250, 380, 450]) {
      for (const deltas of [[30, 28, 26, 22, 18, 14], [14, 12, 16, 20, 20, 16, 12]]) {
        const run = [...fingers(deltas.map((d) => [-d, 0] as const)), ...momentum([-10, 0])];
        const after = play(run, false, play(swipe(1), false).g, pause);
        expect(after.steps.some((s) => s.back === true), `${String(pause)} ms, ${String(deltas[0])} first`).toBe(false);
        expect(after.releases).toBe(1);
      }
    }
  });
});

describe("wheel, told by the platform where a touch begins", () => {
  it("takes a new touch as a new gesture whatever its pace, the last one's glide still arriving", () => {
    // Fingers that touch again and go on the same way as fast as the glide was going: no speed says so, the platform does.
    const first = play(swipe(1, 8), true);
    const { releases } = play([...fingers(Array.from({ length: 10 }, () => [12, 0] as const)), ...momentum([12, 0])], true, first.g);
    expect(first.releases + releases).toBe(2);
  });

  it("never lets one touch go twice, its fingers slowing and speeding up again under a lift guessed early", () => {
    const { releases } = play([...fingers([2, 8, 16, 20, 12, 8, 5, 4, 10, 18, 20, 12].map((d) => [d, 0] as const)), ...momentum([12, 0])], true);
    expect(releases).toBe(1);
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
