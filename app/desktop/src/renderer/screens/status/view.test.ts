import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectStatusRow } from "../../../shared/contracts";
import type { ProjectRow } from "../../src/data/selectors";
import { barOf, orderRows } from "./rows";
import { age, dropLines, fullWhen, heldLine, staleWords, weekLine, when } from "./view";

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOW = Date.parse("2026-10-19T10:07:12.000Z");

const row = (title: string, state: string, extra: Partial<ProjectStatusRow> = {}): ProjectStatusRow => ({
  projectRef: { machineId: "devbox", projectId: title },
  title,
  state,
  agentsRunning: 0,
  asOf: "2026-10-19T10:07:12.000Z",
  ...extra,
});

const project = (title: string, chat: { needsYou?: boolean; working?: boolean } = {}): ProjectRow => ({
  key: `devbox/${title}`,
  project: { machineId: "devbox", projectId: title, title, lastActivityAt: "2026-10-19T10:00:00.000Z", threads: { active: 0, total: 0 }, workspaceRoot: `/home/dev/${title}` } as unknown as ProjectRow["project"],
  needsYou: chat.needsYou ?? false,
  working: chat.working ?? false,
  running: 0,
  state: "idle",
});

describe("the 7-day fact", () => {
  it("says the count and the share through fleetd, and nothing for repos the metrics don't read", () => {
    expect(weekLine(12, 63.6)).toBe("12 merged in 7 days · 64% through fleetd");
    expect(weekLine(0, undefined)).toBe("0 merged in 7 days");
    expect(weekLine(undefined, undefined)).toBeUndefined();
  });
});

describe("status rows", () => {
  it("put what needs you first, then blocked, working, idle; by title within each", () => {
    const rows = [row("web", "idle"), row("api", "working"), row("shop", "idle"), row("mail", "blocked"), row("app", "working")];
    const chat = [project("shop", { needsYou: true })];
    expect(orderRows(rows, chat).map((r) => [r.row.title, r.word])).toEqual([
      ["shop", "waiting_on_you"],
      ["mail", "blocked"],
      ["api", "working"],
      ["app", "working"],
      ["web", "idle"],
    ]);
  });

  it("say waiting on you only when the chat does, so Status, the sidebar dot and the chat header agree", () => {
    // The row's own "waiting on you" never counts; the hub's chat state is the one source for it.
    expect(orderRows([row("billing", "waiting_on_you")], [project("billing")])[0]?.word).toBe("idle");
    expect(orderRows([row("billing", "idle")], [project("billing", { needsYou: true })])[0]?.word).toBe("waiting_on_you");
    // From the row: blocked, and a working (PRs in CI or review) its agents can't show.
    expect(orderRows([row("shop", "blocked")], [project("shop", { working: true })])[0]?.word).toBe("blocked");
    expect(orderRows([row("shop", "working")], [project("shop")])[0]?.word).toBe("working");
    expect(orderRows([row("shop", "idle")], [project("shop", { working: true })])[0]?.word).toBe("working");
    // A state a newer hub sends reads as idle; no chat state yet reads as not waiting.
    expect(orderRows([row("x", "paused_for_lunch")], undefined)[0]?.word).toBe("idle");
  });

  it("draw the two-tone bar only when something is counted: nothing to count shows no number", () => {
    const estimate = { pct: 78, verifiedPct: 58, inFlightPct: 20 };
    expect(barOf(row("a", "working", { progress: estimate }))).toEqual({ pct: 78, verifiedPct: 58, inFlightPct: 20 });
    expect(barOf(row("b", "idle"))).toBeNull();
    // The lighter part never claims past 100, whatever rounding did.
    expect(barOf(row("d", "working", { progress: { ...estimate, pct: 100, verifiedPct: 97, inFlightPct: 5 } }))?.inFlightPct).toBe(3);
  });
});

describe("words", () => {
  it("are measured times, never estimates", () => {
    expect(age(4 * 60_000 + 5_000)).toBe("4m");
    expect(staleWords({ since: "2026-10-19T09:55:45.000Z", reason: "no heartbeat from buildbox" }, NOW)).toBe("Out of date for 11m: no heartbeat from buildbox");
  });

  it("always say which day a merge was, so an old one never passes for today", () => {
    // Read in the viewer's zone; pinned so the words below hold on every machine.
    vi.stubEnv("TZ", "UTC");
    expect(when("2026-10-19T08:18:00.000Z", NOW)).toBe("today 08:18");
    expect(when("2026-10-18T16:40:00.000Z", NOW)).toBe("yesterday 16:40");
    expect(when("2026-10-16T14:00:00.000Z", NOW)).toBe("Fri 14:00");
    expect(when("2026-10-07T14:00:00.000Z", NOW)).toBe("Oct 7");
    expect(when("2025-12-30T14:00:00.000Z", NOW)).toBe("Dec 30, 2025");
    expect(fullWhen("2026-10-16T14:00:00.000Z")).toBe("Fri Oct 16, 14:00");
  });

  it("explain the last three drops, newest first", () => {
    const at = "2026-10-19T10:00:00.000Z";
    const series = [
      { at, pct: 40, verifiedPct: 30 },
      { at, pct: 55, verifiedPct: 30, drop: { reason: "ci_failed", fromPct: 61, text: "CI failed on #212" } },
      { at, pct: 74, verifiedPct: 50, drop: { reason: "scope_change", fromPct: 80, text: "+3 items: currency export added" } },
    ];
    expect(dropLines(series)).toEqual(["↓ 80% → 74%: +3 items: currency export added", "↓ 61% → 55%: CI failed on #212"]);
  });

  it("says the figure holds only while the newest point is paused", () => {
    const at = "2026-10-19T10:00:00.000Z";
    const held = { at, pct: 64, verifiedPct: 52, paused: "paused: an agent hit a usage limit" };
    expect(heldLine([{ at, pct: 60, verifiedPct: 52 }, held])).toBe("Held at 64% (paused: an agent hit a usage limit)");
    // Resumed: the paused point is history, and the figure moves again.
    expect(heldLine([held, { at, pct: 66, verifiedPct: 52 }])).toBeUndefined();
    expect(heldLine([])).toBeUndefined();
  });
});
