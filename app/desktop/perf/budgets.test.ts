import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { frameStats, keyTimes, quantile, regressionLimit, regressions, startTimes, withinBudget, type Results } from "./budgets.ts";

const base: Results = { firstPaintMs: 300, firstPaintRefMs: 200, firstPaintOverMs: 100, chatShownMs: 500, chatOverMs: 300, idleMemoryMb: 200, idleRssMb: 500, scrollFps: 60, streamFps: 60, keyP95Ms: 6, keyRefP50Ms: 2, keyOverMs: 4 };

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
    // A slow runner (both launches slower, the app's overhead the same; both key presses twice as slow) and summed RSS
    // doubling are not regressions.
    expect(
      regressions({ firstPaintMs: 900, firstPaintRefMs: 800, firstPaintOverMs: 100, chatShownMs: 1100, chatOverMs: 300, idleMemoryMb: 260, idleRssMb: 1000, scrollFps: 61, streamFps: 59, keyP95Ms: 12, keyRefP50Ms: 4, keyOverMs: 8 }, base),
    ).toEqual([{ metric: "idleMemoryMb", value: 260, limit: 230, base: 200 }]);
    expect(regressions({ ...base, firstPaintOverMs: 161, chatOverMs: 391, scrollFps: 50, streamFps: 20, keyP95Ms: 8.1, keyOverMs: 6.1 }, base).map((r) => r.metric)).toEqual([
      "firstPaintOverMs",
      "chatOverMs",
      "scrollFps",
      "streamFps",
      "keyOverMs",
    ]);
  });

  it("reads keypress over bare by round pairs, so a slow spell on one pair moves it no more than any one round", () => {
    const round = (p50: number) => ({ p95: p50 * 2, p50, slow: 0 });
    // The third pair typed through a stall: the composer's p50 read 9 ms and the textarea's 4 beside it.
    const keys = keyTimes({ rounds: [3.5, 3.6, 9, 3.4, 3.5].map(round), bareRounds: [1.5, 1.6, 4, 1.5, 1.6].map(round) });
    expect(keys.keyP95Ms).toBeCloseTo(7);
    expect(keys.keyRefP50Ms).toBeCloseTo(1.6);
    expect(keys.keyOverMs).toBeCloseTo(2);
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
  const rest = { idleMemoryMb: 370, idleRssMb: 600, scrollFps: 60, streamFps: 60, keyP95Ms: baseline.keyP95Ms, keyRefP50Ms: baseline.keyRefP50Ms, keyOverMs: baseline.keyOverMs };
  // The warm launches the desktop-budgets job logged, ms.
  // Main at 6e93c42a7, re-run (Xeon 6975P): red, its runner slow for a few launches in a row.
  const noisy = { app: [368, 911, 717, 762, 377], chat: [478, 1027, 833, 879, 491], bare: [225, 366, 404, 207, 195] };
  // Main at 910b7d595, the same app on the same kind of runner, green.
  const green = { app: [528, 796, 720, 372, 389], chat: [630, 906, 833, 476, 498], bare: [441, 385, 364, 206, 196] };

  it("reads a noisy runner's start by its fastest launches, so the same app passes on both runs", () => {
    // Medians put the noisy run 492 ms over bare (limit 235 then) and the green one 163.
    expect(startTimes(noisy)).toMatchObject({ firstPaintOverMs: 173, chatOverMs: 283 });
    expect(startTimes(green)).toMatchObject({ firstPaintOverMs: 176, chatOverMs: 280 });
    expect(regressions({ ...rest, ...startTimes(noisy) }, baseline)).toEqual([]);
    expect(regressions({ ...rest, ...startTimes(green) }, baseline)).toEqual([]);
  });

  it("still fails a start every launch of which got slower, however noisy the runner", () => {
    const slower = (ms: number) => ({ app: noisy.app.map((t) => t + ms), chat: noisy.chat.map((t) => t + ms), bare: noisy.bare });
    expect(regressions({ ...rest, ...startTimes(slower(40)) }, baseline).map((r) => r.metric)).toEqual([]);
    expect(regressions({ ...rest, ...startTimes(slower(120)) }, baseline).map((r) => r.metric)).toEqual(["firstPaintOverMs", "chatOverMs"]);
  });

  // One commit's key presses on each of Nov 27's one-off runs, ms: the median over round pairs of the composer's p50
  // over the bare textarea's, and the textarea's own; then the same with #2250's :has() rule put back.
  const fixed = {
    xeon6975P: [[2.95, 1.5], [2.55, 1.25], [2.5, 1.2], [2.8, 1.5], [2.4, 1.2], [3.2, 1.6], [3.4, 1.8]],
    xeon8573C: [[3.2, 1.55]],
    epyc7763: [[4.05, 2]],
    epyc9V45: [[3.15, 1.75]],
    epyc9V74: [[3.5, 1.7], [3.6, 1.8]],
  };
  const slowed = {
    xeon6975P: [[4.9, 1.3], [5.85, 1.7], [5.4, 1.4], [5.6, 1.5], [5.9, 1.55]],
    xeon8573C: [[7, 2]],
    epyc7763: [[7.3, 1.9], [8.75, 2.3]],
    epyc9V74: [[6.5, 1.8], [7.4, 2]],
  };
  const keys = ([keyOverMs = 0, keyRefP50Ms = 0]: number[]) => ({ ...rest, ...startTimes(green), keyOverMs, keyRefP50Ms });
  const runs = (kinds: Record<string, number[][]>) => Object.values(kinds).flat();

  it("scales keypress to the runner's bare textarea, so every kind of runner passes the same code with room to spare", () => {
    for (const run of runs(fixed)) {
      expect(regressions(keys(run), baseline)).toEqual([]);
      // The fast 6975P sat at 91% of the p95 gate's limit, and failed PRs at it; none of these reads past 80%.
      const limit = regressionLimit("keyOverMs", ((run[1] ?? 0) * baseline.keyOverMs) / baseline.keyRefP50Ms) ?? 0;
      expect((run[0] ?? 0) / limit).toBeLessThan(0.8);
    }
  });

  it("fails #2250's slowdown, and a composer 40% slower, on every kind of runner", () => {
    for (const run of runs(slowed)) expect(regressions(keys(run), baseline).map((r) => r.metric)).toEqual(["keyOverMs"]);
    // Each fixed run's composer p50 (over plus the textarea) taking 40% longer.
    const slower = runs(fixed).map(([over = 0, ref = 0]) => [(over + ref) * 1.4 - ref, ref]);
    for (const run of slower) expect(regressions(keys(run), baseline).map((r) => r.metric)).toEqual(["keyOverMs"]);
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
