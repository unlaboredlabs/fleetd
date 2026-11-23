import { describe, expect, it } from "vitest";
import { frameStats, quantile, regressionLimit, regressions, withinBudget, type Results } from "./budgets.ts";

const base: Results = { firstPaintMs: 300, firstPaintRefMs: 200, firstPaintOverMs: 100, chatShownMs: 500, chatOverMs: 300, idleMemoryMb: 200, idleRssMb: 500, scrollFps: 60, streamFps: 60, keyP95Ms: 6 };

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
    // 7% of 60 = 4.2 beats the 3 fps slack.
    expect(regressionLimit("scrollFps", 60)).toBeCloseTo(55.8);
    // CI gates first paint only over the bare Electron window, never absolutely.
    expect(regressionLimit("firstPaintMs", 300)).toBeUndefined();
  });

  it("reports only the gated metrics that got worse past their limit", () => {
    // A slow runner (both launches slower, the app's overhead the same) and summed RSS doubling are not regressions.
    expect(
      regressions({ firstPaintMs: 900, firstPaintRefMs: 800, firstPaintOverMs: 100, chatShownMs: 1100, chatOverMs: 300, idleMemoryMb: 260, idleRssMb: 1000, scrollFps: 61, streamFps: 59, keyP95Ms: 2 }, base),
    ).toEqual([{ metric: "idleMemoryMb", value: 260, limit: 230, base: 200 }]);
    expect(regressions({ ...base, firstPaintOverMs: 161, chatOverMs: 391, scrollFps: 50, streamFps: 20, keyP95Ms: 15 }, base).map((r) => r.metric)).toEqual([
      "firstPaintOverMs",
      "chatOverMs",
      "scrollFps",
      "streamFps",
      "keyP95Ms",
    ]);
  });

  it("scales the start's baselines to the runner's own bare Electron start", () => {
    // perf/baseline-linux.json's start, the median EPYC 7763 run of main's.
    const linux: Results = { ...base, firstPaintMs: 513, firstPaintRefMs: 288, firstPaintOverMs: 225, chatShownMs: 663, chatOverMs: 375 };
    // The red run on main at 5b4d3ba86 (an EPYC 7763, the slowest runner), whose start loads within a kilobyte of the
    // green commit before it, and main's next run, on a Xeon 6975P: neither is a regression.
    expect(regressions({ ...linux, firstPaintRefMs: 285, firstPaintOverMs: 254, chatShownMs: 688, chatOverMs: 403 }, linux)).toEqual([]);
    expect(regressions({ ...linux, firstPaintRefMs: 211, firstPaintOverMs: 167, chatShownMs: 491, chatOverMs: 280 }, linux)).toEqual([]);
    // 100 ms more before the chat reads on that Xeon is one, though the 7763's limit in ms is past it.
    expect(regressions({ ...linux, firstPaintRefMs: 211, firstPaintOverMs: 167, chatShownMs: 591, chatOverMs: 380 }, linux)).toEqual([
      { metric: "chatOverMs", value: 380, limit: expect.closeTo(357, 0) as number, base: expect.closeTo(275, 0) as number },
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
