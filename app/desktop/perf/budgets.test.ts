import { describe, expect, it } from "vitest";
import { frameStats, quantile, regressionLimit, regressions, withinBudget, type Results } from "./budgets.ts";

const base: Results = { firstPaintMs: 300, firstPaintRefMs: 200, firstPaintOverMs: 100, idleMemoryMb: 200, idleRssMb: 500, scrollFps: 60, keyP95Ms: 6 };

describe("budgets", () => {
  it("passes strictly under a ceiling and at or over a floor; a metric without a budget has no verdict", () => {
    expect(withinBudget("firstPaintMs", 599)).toBe(true);
    expect(withinBudget("firstPaintMs", 600)).toBe(false);
    expect(withinBudget("scrollFps", 57)).toBe(true);
    expect(withinBudget("scrollFps", 56.9)).toBe(false);
    expect(withinBudget("idleRssMb", 10_000)).toBeUndefined();
  });

  it("allows the larger of the ratio and the slack before calling a regression", () => {
    // 30% of 300 = 90 beats the 60 ms slack.
    expect(regressionLimit("firstPaintOverMs", 300)).toBe(390);
    // 30% of 100 = 30 is under the slack.
    expect(regressionLimit("firstPaintOverMs", 100)).toBe(160);
    expect(regressionLimit("scrollFps", 60)).toBe(54);
    // CI gates first paint only over the bare Electron window, never absolutely.
    expect(regressionLimit("firstPaintMs", 300)).toBeUndefined();
  });

  it("reports only the gated metrics that got worse past their limit", () => {
    // A slow runner (both launches slower, the app's overhead the same) and summed RSS doubling are not regressions.
    expect(
      regressions({ firstPaintMs: 900, firstPaintRefMs: 800, firstPaintOverMs: 100, idleMemoryMb: 260, idleRssMb: 1000, scrollFps: 61, keyP95Ms: 2 }, base),
    ).toEqual([{ metric: "idleMemoryMb", value: 260, limit: 230 }]);
    expect(regressions({ ...base, firstPaintOverMs: 161, scrollFps: 50, keyP95Ms: 15 }, base).map((r) => r.metric)).toEqual([
      "firstPaintOverMs",
      "scrollFps",
      "keyP95Ms",
    ]);
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
