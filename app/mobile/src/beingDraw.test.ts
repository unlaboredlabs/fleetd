import { describe, expect, it } from "vitest";
import { drawEveryMs, drawStep } from "./beingDraw";
import { LARGE } from "./desktop";

/** How many drawings `seconds` of frames at `hz` make. */
const drawings = (hz: number, seconds: number, every: number): number => {
  let since = 0;
  let drawn = 0;
  for (let i = 0; i < hz * seconds; i++) {
    const step = drawStep(since, 1000 / hz, every);
    since = step.since;
    if (step.draw) drawn++;
  }
  return drawn;
};

describe("A moving bot's drawings", () => {
  it("come 30 a second in a list and 60 for a large bot, however fast the screen", () => {
    expect(drawings(120, 10, drawEveryMs(52))).toBe(300);
    expect(drawings(60, 10, drawEveryMs(52))).toBe(300);
    expect(drawings(120, 10, drawEveryMs(LARGE))).toBe(600);
    expect(drawings(60, 10, drawEveryMs(LARGE))).toBe(600);
  });

  it("go on at once after a long frame, without a burst to catch up", () => {
    const every = drawEveryMs(52);
    const late = drawStep(0, 500, every);
    expect(late.draw).toBe(true);
    expect(late.since).toBeLessThanOrEqual(every);
    expect(drawStep(late.since, 8, every).draw).toBe(late.since + 8 >= every - 1);
  });
});
