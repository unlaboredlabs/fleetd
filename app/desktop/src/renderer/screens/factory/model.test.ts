import { describe, expect, it } from "vitest";
import type { MetricsDay, MetricsMerge } from "../../../shared/contracts";
import { metricsAnswer } from "./fixture";
import {
  GAP,
  LOG_TICKS,
  ROUTES,
  ROUTE_FIELD,
  columnPath,
  columnsOf,
  delta,
  fmtCount,
  inDays,
  logDomain,
  logScale,
  mergeName,
  mergesCsv,
  niceTicks,
  prList,
  repoName,
  routeTotal,
  skipLine,
  sortMerges,
  sparkPath,
  stack,
  stages,
} from "./model";

const day = (d: string, train = 0, outside = 0): MetricsDay => ({
  day: d,
  merged: { train, fleetdByHand: 0, outside, direct: 0 },
  notCounted: [],
  human: [{ source: "chat", ms: 60_000 * train, touches: train }],
});

const merge = (over: Partial<MetricsMerge>): MetricsMerge => ({
  repo: "github.com/acme/storefront",
  route: "train",
  mergedAt: "2026-10-12T10:00:00.000Z",
  touches: 0,
  ...over,
});

describe("figures", () => {
  it("compacts counts and keeps one decimal on a small rate", () => {
    expect([fmtCount(4.33), fmtCount(12.4), fmtCount(7), fmtCount(1284), fmtCount(12_900)]).toEqual(["4.3", "12", "7", "1.3K", "13K"]);
  });

  it("colours a delta by direction and which way is good, and says no change rather than ↑ 0", () => {
    expect(delta(4.3, 3.1, "up", "count")).toEqual({ text: "↑ 1.2", tone: "good" });
    expect(delta(3 * 3_600_000, 5 * 3_600_000, "down", "ms")).toEqual({ text: "↓ 2h00m", tone: "good" });
    expect(delta(52, 64, "up", "pct")).toEqual({ text: "↓ 12 pts", tone: "bad" });
    expect(delta(64, 63, "up", "pct")).toEqual({ text: "↑ 1 pt", tone: "good" });
    expect(delta(64, 64.2, "up", "pct")).toEqual({ text: "→ no change", tone: "flat" });
    // A first period has nothing to beat.
    expect(delta(4, undefined, "up", "count")).toBeUndefined();
  });

  it("draws a sparkline broken across slices with nothing to measure, ending on the current point", () => {
    const { d, last } = sparkPath([1, undefined, 3, 2], 30, 10);
    expect(d.match(/M/gu)).toHaveLength(2);
    expect(last?.x).toBe(30);
    expect(sparkPath([undefined, undefined], 30, 10).d).toBe("");
  });

  it("names repos on GitHub by owner and name, and others with their host", () => {
    expect(repoName("github.com/acme/web")).toBe("acme/web");
    expect(repoName("gitlab.example.com/team/sub/api")).toBe("team/sub/api on gitlab.example.com");
    const coverage = [{ repo: "github.com/acme/web", host: "github", defaultBranch: "trunk" }];
    expect(mergeName(merge({ repo: "github.com/acme/web", prNumber: 12 }), coverage)).toBe("acme/web#12");
    expect(mergeName(merge({ repo: "github.com/acme/web", route: "direct" }), coverage)).toBe("acme/web, pushed to trunk");
  });

  it("counts what wasn't counted in words", () => {
    expect(skipLine("bot", 2)).toBe("2 bot PRs not counted");
    expect(skipLine("other_base", 1)).toBe("1 PR into another branch not counted");
    expect(skipLine("revert", 3)).toBe("3 other merges not counted");
  });
});

describe("columns", () => {
  it("keeps one column a day up to a month, and folds a longer range into weeks", () => {
    const month = Array.from({ length: 30 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, 1));
    expect(columnsOf(month)).toHaveLength(30);
    const quarter = Array.from({ length: 90 }, (_, i) => day(new Date(Date.UTC(2026, 6, 22) + i * 86_400_000).toISOString().slice(0, 10), 2, 1));
    const weeks = columnsOf(quarter);
    expect(weeks).toHaveLength(13);
    expect(weeks[0]?.days).toBe(7);
    expect(weeks[0]?.label).toBe("Jul 22 to Jul 28");
    expect(weeks.at(-1)?.days).toBe(6);
    expect(routeTotal(weeks[0]?.merged ?? { train: 0, fleetdByHand: 0, outside: 0, direct: 0 })).toBe(21);
    expect(weeks[0]?.human.get("chat")).toEqual({ ms: 7 * 120_000, touches: 14 });
  });

  it("stacks bottom up in the fixed order with a 2 px gap above each segment, and rounds only the top one", () => {
    const segs = stack(
      [
        ["train", 2],
        ["fleetd_by_hand", 0],
        ["outside", 1],
      ],
      (v) => v * 10,
      100,
    );
    expect(segs.map((x) => x.key)).toEqual(["train", "outside"]);
    expect(segs[0]).toMatchObject({ y: 80, h: 20, top: false });
    expect(segs[1]).toMatchObject({ y: 70, h: 10 - GAP, top: true });
    expect(columnPath(0, 0, 10, 20, false)).not.toContain("Q");
    expect(columnPath(0, 0, 10, 20, true)).toContain("Q");
  });

  it("ticks a count axis in whole numbers", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(5_400_000, 60_000).every((t) => t % 60_000 === 0)).toBe(true);
  });
});

describe("order to merged", () => {
  it("spans 10 minutes to a day at least, widened to the data, on a log scale", () => {
    expect(logDomain([3_600_000])).toEqual([600_000, 86_400_000]);
    const [lo, hi] = logDomain([120_000, 9 * 86_400_000]);
    expect([lo, hi]).toEqual([120_000, 9 * 86_400_000]);
    const y = logScale([600_000, 86_400_000], 0, 100);
    expect(y(600_000)).toBe(100);
    expect(y(86_400_000)).toBe(0);
    expect(y(1)).toBe(100);
    expect(LOG_TICKS.map(([, l]) => l)).toContain("1w");
  });

  it("splits a change into its stages", () => {
    const m = merge({
      requestedAt: "2026-10-12T08:00:00.000Z",
      firstPrAt: "2026-10-12T08:40:00.000Z",
      reviewPassedAt: "2026-10-12T09:30:00.000Z",
    });
    expect(stages(m)).toEqual(["requested → PR opened: 40m", "PR opened → review passed: 50m", "review passed → merged: 30m"]);
    expect(stages(merge({}))).toEqual([]);
  });
});

describe("the merge list", () => {
  const list = [
    merge({ prNumber: 3, mergedAt: "2026-10-12T10:00:00.000Z", orderToMergedMs: 5_000 }),
    merge({ prNumber: 1, mergedAt: "2026-10-13T10:00:00.000Z", route: "outside" }),
    merge({ prNumber: 2, mergedAt: "2026-10-11T10:00:00.000Z", orderToMergedMs: 9_000, route: "fleetd_by_hand" }),
  ];

  it("sorts by any column, rows with nothing for it last either way", () => {
    expect(sortMerges(list, { key: "date", desc: true }).map((m) => m.prNumber)).toEqual([1, 3, 2]);
    expect(sortMerges(list, { key: "toMerged", desc: false }).map((m) => m.prNumber)).toEqual([3, 2, 1]);
    expect(sortMerges(list, { key: "toMerged", desc: true }).map((m) => m.prNumber)).toEqual([2, 3, 1]);
    expect(sortMerges(list, { key: "route", desc: false }).map((m) => m.route)).toEqual(["train", "fleetd_by_hand", "outside"]);
  });

  it("narrows to a column's days and names its PRs, five then a count", () => {
    expect(inDays(list, "2026-10-12", "2026-10-13").map((m) => m.prNumber).sort()).toEqual([1, 3]);
    const many = Array.from({ length: 8 }, (_, i) => merge({ prNumber: 100 + i }));
    expect(prList(many)).toBe("#100, #101, #102, #103, #104 +3 more");
    expect(prList([merge({ route: "direct" })])).toBe("a push");
  });

  it("copies as CSV, quoting what needs it", () => {
    const csv = mergesCsv([merge({ prNumber: 7, title: 'Say "hi", then go', orderToMergedMs: 90 * 60_000 })]);
    const [head, row] = csv.trim().split("\n");
    expect(head?.split(",")[0]).toBe("merged_at");
    expect(row).toContain('"Say ""hi"", then go"');
    expect(row).toContain(",90,");
  });
});

describe("the fixture's answer", () => {
  const projects = [
    { machineId: "devbox", projectId: "p1", title: "storefront" },
    { machineId: "buildbox", projectId: "p2", title: "billing" },
  ];
  const now = "2026-10-19T09:03:00.000Z";

  it("adds up: the days, the tiles and the list agree", () => {
    const out = metricsAnswer({ now, projects });
    expect(out.days).toHaveLength(30);
    const fromDays = out.days.reduce((n, d) => n + routeTotal(d.merged), 0);
    expect(fromDays).toBe(out.tiles.merged.n);
    expect(out.merges).toHaveLength(out.mergesTotal);
    for (const r of ROUTES) expect(out.merges.filter((m) => m.route === r)).toHaveLength(out.tiles.merged.byRoute[ROUTE_FIELD[r]]);
    expect(out.repos).toHaveLength(2);
    expect(out.tiles.merged.spark.length).toBeLessThanOrEqual(12);
  });

  it("answers one project with its repo only, and nothing merged with zeros", () => {
    const one = metricsAnswer({ now, projects, project: { machineId: "buildbox", projectId: "p2" } });
    expect(one.repos).toBeUndefined();
    expect(new Set(one.merges.map((m) => m.repo))).toEqual(new Set(["github.com/acme/billing"]));
    const none = metricsAnswer({ now, projects, none: true });
    expect(none.tiles.merged.n).toBe(0);
    expect(none.tiles.orderToMerged.medianMs).toBeUndefined();
  });
});
