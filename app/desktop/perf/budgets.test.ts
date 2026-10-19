import { describe, expect, it } from "vitest";
import { frameStats, quantile, regressionLimit, regressions, withinBudget, type Results } from "./budgets.ts";

const base: Results = { firstPaintMs: 300, idleRssMb: 200, idleUniqueMb: 150, scrollFps: 60, keyP95Ms: 6 };

describe("budgets", () => {
  it("passes strictly under a ceiling and at or over a floor", () => {
    expect(withinBudget("firstPaintMs", 599)).toBe(true);
    expect(withinBudget("firstPaintMs", 600)).toBe(false);
    expect(withinBudget("scrollFps", 57)).toBe(true);
    expect(withinBudget("scrollFps", 56.9)).toBe(false);
  });

  it("allows the larger of the ratio and the slack before calling a regression", () => {
    // 30% of 300 = 90 beats the 60 ms slack.
    expect(regressionLimit("firstPaintMs", 300)).toBe(390);
    // 30% of 100 = 30 is under the slack.
    expect(regressionLimit("firstPaintMs", 100)).toBe(160);
    expect(regressionLimit("scrollFps", 60)).toBe(54);
  });

  it("reports only the metrics that got worse past their limit", () => {
    expect(regressions({ firstPaintMs: 389, idleRssMb: 260, idleUniqueMb: 170, scrollFps: 61, keyP95Ms: 2 }, base)).toEqual([
      { metric: "idleRssMb", value: 260, limit: 230 },
    ]);
    expect(regressions({ ...base, scrollFps: 50, keyP95Ms: 11 }, base).map((r) => r.metric)).toEqual(["scrollFps", "keyP95Ms"]);
  });
});

describe("stats", () => {
  it("takes nearest-rank quantiles", () => {
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(quantile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it("counts frames per second and the long ones", () => {
    const smooth = Array.from({ length: 61 }, (_, i) => i * 16.67);
    expect(frameStats(smooth, 16.67).fps).toBeCloseTo(60, 0);
    expect(frameStats(smooth, 16.67).dropped).toBe(0);
    // One 50 ms frame among ten.
    const janky = [0, 16, 32, 48, 98, 114, 130, 146, 162, 178, 194];
    expect(frameStats(janky, 16).dropped).toBeCloseTo(0.1);
  });
});
