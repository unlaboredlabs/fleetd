import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectStatusRow } from "../../../shared/contracts";
import type { ProjectRow } from "../../src/data/selectors";
import { barOf, orderRows } from "./rows";
import { age, dropLines, staleWords, when } from "./view";

const NOW = Date.parse("2026-10-19T10:07:12.000Z");

beforeAll(() => {
  // `when` reads the viewer's zone; pin it so the expectations hold on every machine.
  vi.stubEnv("TZ", "UTC");
});

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

  it("draw the two-tone bar only when something is counted: planning and nothing-to-count show no number", () => {
    const estimate = { pct: 78, verifiedPct: 58, inFlightPct: 20, weights: "project" as const };
    expect(barOf(row("a", "working", { progress: estimate }))).toEqual({ bar: { pct: 78, verifiedPct: 58, inFlightPct: 20 }, planning: false });
    expect(barOf(row("b", "idle"))).toEqual({ bar: null, planning: false });
    const planning = { ...estimate, pct: 0, verifiedPct: 0, inFlightPct: 0, planning: { active: true, pct: 55, sharePct: 8, since: "2026-10-19T09:59:00.000Z" } };
    expect(barOf(row("c", "working", { progress: planning }))).toEqual({ bar: null, planning: true });
    // The lighter part never claims past 100, whatever rounding did.
    expect(barOf(row("d", "working", { progress: { ...estimate, pct: 100, verifiedPct: 97, inFlightPct: 5 } })).bar?.inFlightPct).toBe(3);
  });
});

describe("words", () => {
  it("are measured times, never estimates", () => {
    expect(age(4 * 60_000 + 5_000)).toBe("4m");
    expect(when("2026-10-19T14:00:00.000Z", NOW)).toBe("14:00");
    expect(when("2026-10-22T14:00:00.000Z", NOW)).toBe("Thu 14:00");
    expect(staleWords({ since: "2026-10-19T09:55:45.000Z", reason: "no heartbeat from buildbox" }, NOW)).toBe("stale 11m: no heartbeat from buildbox");
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
});
