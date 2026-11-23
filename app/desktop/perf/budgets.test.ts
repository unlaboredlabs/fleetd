import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { frameStats, median, quantile, regressionLimit, regressions, startTimes, withinBudget, type Results } from "./budgets.ts";

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

describe("CI's runs against perf/baseline-linux.json", () => {
  const baseline = JSON.parse(readFileSync(new URL("./baseline-linux.json", import.meta.url), "utf8")) as Results;
  const rest = { idleMemoryMb: 370, idleRssMb: 600, scrollFps: 60, streamFps: 60 };
  // The warm launches the desktop-budgets job logged, ms.
  // Main at 6e93c42a7, re-run (Xeon 6975P): red, its runner slow for a few launches in a row.
  const noisy = { app: [368, 911, 717, 762, 377], chat: [478, 1027, 833, 879, 491], bare: [225, 366, 404, 207, 195] };
  // Main at 910b7d595, the same app on the same kind of runner, green.
  const green = { app: [528, 796, 720, 372, 389], chat: [630, 906, 833, 476, 498], bare: [441, 385, 364, 206, 196] };
  // Main at 6e93c42a7, first attempt (Xeon 8370C): red on keypress, a p95 of 12.6 to 14.9 ms in all five rounds.
  const slowKeys = { app: [512, 1004, 494, 483, 507], chat: [666, 1154, 642, 628, 653], bare: [280, 454, 260, 270, 269], keyP95Ms: median([14.2, 14.9, 13.7, 12.6, 12.6]) };

  it("reads a noisy runner's start by its fastest launches, so the same app passes on both runs", () => {
    // Medians put the noisy run 492 ms over bare (limit 235 then) and the green one 163.
    expect(startTimes(noisy)).toMatchObject({ firstPaintOverMs: 173, chatOverMs: 283 });
    expect(startTimes(green)).toMatchObject({ firstPaintOverMs: 176, chatOverMs: 280 });
    expect(regressions({ ...rest, ...startTimes(noisy), keyP95Ms: 7.9 }, baseline)).toEqual([]);
    expect(regressions({ ...rest, ...startTimes(green), keyP95Ms: 8.5 }, baseline)).toEqual([]);
  });

  it("still fails a start every launch of which got slower, however noisy the runner", () => {
    const slower = (ms: number) => ({ app: noisy.app.map((t) => t + ms), chat: noisy.chat.map((t) => t + ms), bare: noisy.bare });
    expect(regressions({ ...rest, ...startTimes(slower(40)), keyP95Ms: 7.9 }, baseline).map((r) => r.metric)).toEqual([]);
    expect(regressions({ ...rest, ...startTimes(slower(120)), keyP95Ms: 7.9 }, baseline).map((r) => r.metric)).toEqual(["firstPaintOverMs", "chatOverMs"]);
  });

  it("scales keypress to the runner, so a slower kind of runner isn't a regression but slower keys on it are", () => {
    expect(regressions({ ...rest, ...startTimes(slowKeys), keyP95Ms: slowKeys.keyP95Ms }, baseline)).toEqual([]);
    expect(regressions({ ...rest, ...startTimes(slowKeys), keyP95Ms: slowKeys.keyP95Ms * 1.3 }, baseline).map((r) => r.metric)).toEqual(["keyP95Ms"]);
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
