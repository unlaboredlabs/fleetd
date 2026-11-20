import { describe, expect, it } from "vitest";
import { canRebuild, commandsOf, imageRows, imageSize, runsOnRows, setupTargets, touchesComputer } from "./computerModel";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const clock = { nowMs: NOW };
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const BOT = { machineId: "devbox", projectId: "shop", title: "storefront" };
const repo = (name: string, projectId: string) => ({ repoId: `r_${name}`, name, checkout: { machineId: "devbox", projectId } });

describe("setupTargets", () => {
  it("is the bot's own Setup alone while it has no other repo", () => {
    expect(setupTargets(BOT)).toEqual([{ title: "Setup" }]);
    expect(setupTargets({ ...BOT, repos: [repo("storefront", "shop")] })).toEqual([{ title: "Setup" }]);
  });

  it("names each setup by its repo, the bot's own first", () => {
    expect(setupTargets({ ...BOT, repos: [repo("api", "api"), repo("web", "shop")] })).toEqual([
      { title: "Setup: web" },
      { repo: "api", title: "Setup: api" },
    ]);
  });

  it("leaves out the bot's own directory when it isn't one of its repos", () => {
    expect(setupTargets({ ...BOT, repos: [repo("api", "api")] })).toEqual([{ repo: "api", title: "Setup: api" }]);
  });
});

describe("commandsOf", () => {
  it("is its commands, blank ones dropped", () => {
    expect(commandsOf({ commands: ["bun install", "  ", " cargo fetch "] })).toEqual(["bun install", "cargo fetch"]);
    expect(commandsOf(undefined)).toEqual([]);
    expect(commandsOf({})).toEqual([]);
  });
});

describe("imageSize", () => {
  it("says megabytes under a gigabyte, gigabytes with one decimal from one", () => {
    expect(imageSize(640 * 1_048_576)).toBe("640 MB");
    expect(imageSize(1000)).toBe("1 MB");
    expect(imageSize(1_181_116_006)).toBe("1.1 GB");
    expect(imageSize(1_073_741_824)).toBe("1.0 GB");
  });
});

describe("imageRows", () => {
  it("is ready with when it was built and its size", () => {
    expect(imageRows({ state: "ready", builtAt: hoursAgo(3), bytes: 1_181_116_006 }, true, clock)).toEqual([
      { title: "Image", value: "Ready", tone: "plain" },
      { title: "Built", value: "3h ago", tone: "plain" },
      { title: "Size", value: "1.1 GB", tone: "plain" },
    ]);
  });

  it("is not built yet while there are commands and no image", () => {
    expect(imageRows({ state: "none", where: "boat" }, true, clock)).toEqual([{ title: "Image", value: "Not built yet", tone: "plain" }]);
  });

  it("is building, with the older image that still serves", () => {
    expect(imageRows({ state: "building", startedAt: hoursAgo(0) }, true, clock)).toEqual([{ title: "Image", value: "Building…", tone: "busy" }]);
    expect(imageRows({ state: "building", builtAt: hoursAgo(26), bytes: 640 * 1_048_576 }, true, clock)).toEqual([
      { title: "Image", value: "Building…", tone: "busy" },
      { title: "Built", value: "yesterday", tone: "plain" },
      { title: "Size", value: "640 MB", tone: "plain" },
    ]);
  });

  it("is failed with its log, and the older image that still serves", () => {
    expect(imageRows({ state: "failed", failedAt: hoursAgo(0), log: "error: cargo fetch\n" }, true, clock)).toEqual([{ title: "Image", value: "Failed", tone: "danger", log: "error: cargo fetch" }]);
    expect(imageRows({ state: "failed", log: " ", builtAt: hoursAgo(2) }, true, clock)).toEqual([
      { title: "Image", value: "Failed", tone: "danger" },
      { title: "Built", value: "2h ago", tone: "plain" },
    ]);
  });

  it("is nothing on a machine that builds no images", () => {
    // A self-hosted hub's machine: the node says none, and not where.
    expect(imageRows({ state: "none" }, true, clock)).toEqual([]);
  });

  it("is nothing without commands, or from a hub that doesn't say", () => {
    expect(imageRows({ state: "none", where: "boat" }, false, clock)).toEqual([]);
    expect(imageRows(undefined, true, clock)).toEqual([]);
  });
});

describe("canRebuild", () => {
  it("is while its machine builds images, there are commands and no build runs", () => {
    expect(canRebuild({ state: "ready", builtAt: hoursAgo(1) }, true)).toBe(true);
    expect(canRebuild({ state: "failed" }, true)).toBe(true);
    expect(canRebuild({ state: "none", where: "boat" }, true)).toBe(true);
    expect(canRebuild({ state: "building" }, true)).toBe(false);
    expect(canRebuild({ state: "none", where: "boat" }, false)).toBe(false);
    // A machine that builds no images: nothing to rebuild.
    expect(canRebuild({ state: "none" }, true)).toBe(false);
    expect(canRebuild(undefined, true)).toBe(false);
  });
});

describe("touchesComputer", () => {
  it("is the bot's own project.settings", () => {
    expect(touchesComputer({ type: "project.settings", machineId: "devbox", projectId: "shop" }, BOT)).toBe(true);
    expect(touchesComputer({ type: "project.settings", machineId: "devbox", projectId: "api" }, BOT)).toBe(false);
    expect(touchesComputer({ type: "project.added", machineId: "devbox", projectId: "shop" }, BOT)).toBe(false);
  });
});

describe("Runs on", () => {
  const choices = [
    { kind: "boat", cpu: 2, memGb: 4, label: "boat.dev · 2 vCPU / 4 GB" },
    { kind: "boat", cpu: 4, memGb: 8, label: "boat.dev · 4 vCPU / 8 GB" },
    { kind: "boat", cpu: 8, memGb: 16, label: "boat.dev · 8 vCPU / 16 GB", unavailable: "boat.dev isn't connected: an admin connects it in Settings › Hub › Machines" },
  ];

  it("is Automatic, then each real machine in the hub's order, provider and size together, the pick checked", () => {
    const rows = runsOnRows({ computer: { kind: "boat", cpu: 4, memGb: 8 }, computers: choices });
    expect(rows.map((r) => [r.title, r.selected])).toEqual([
      ["Automatic", false],
      ["boat.dev · 2 vCPU / 4 GB", false],
      ["boat.dev · 4 vCPU / 8 GB", true],
      ["boat.dev · 8 vCPU / 16 GB", false],
    ]);
    expect(rows[0]!.pick).toBeNull();
    expect(rows[2]!.pick).toEqual({ kind: "boat", cpu: 4, memGb: 8 });
    // One that can't be used now says why, never only greyed out.
    expect(rows[3]!.why).toBe("boat.dev isn't connected: an admin connects it in Settings › Hub › Machines");
    expect(rows[3]!.note).toEqual({ why: "boat.dev isn't connected: an admin connects it in Settings › Hub › Machines" });
    expect(rows.some((r) => /small|medium|large/i.test(r.title))).toBe(false);
  });

  it("says a reason the rows side by side share once, under the last of them, with its fix", () => {
    const why = "boat.dev's key failed its last test: refused";
    const fix = "make a new key in boat.dev's dashboard";
    const boat = (cpu: number, memGb: number) => ({ kind: "boat", cpu, memGb, label: `boat.dev · ${String(cpu)} vCPU / ${String(memGb)} GB`, unavailable: why, fix });
    const rows = runsOnRows({ computers: [boat(2, 4), boat(4, 8), boat(8, 16)] });
    expect(rows.map((r) => [r.title, r.why !== undefined, r.note])).toEqual([
      ["Automatic", false, undefined],
      ["boat.dev · 2 vCPU / 4 GB", true, undefined],
      ["boat.dev · 4 vCPU / 8 GB", true, undefined],
      ["boat.dev · 8 vCPU / 16 GB", true, { why, fix }],
    ]);
  });

  it("checks Automatic with no pick, and has no rows with nothing to pick or from a hub too old to say", () => {
    expect(runsOnRows({ computers: choices })[0]!.selected).toBe(true);
    expect(runsOnRows({ computers: [] })).toEqual([]);
    expect(runsOnRows({})).toEqual([]);
    expect(runsOnRows(undefined)).toEqual([]);
  });
});
