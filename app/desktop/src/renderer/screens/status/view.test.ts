import { beforeAll, describe, expect, it, vi } from "vitest";
import { asGetOutput } from "./contracts";
import { toggleRoute } from "./commands";
import { digestText } from "./digest";
import {
  age,
  figure,
  headlineText,
  limitName,
  machineView,
  nextAgeChange,
  progressRowView,
  scopeFromRoute,
  scopeRoute,
  shownRisks,
  sourceName,
  spark,
  stageName,
  stateView,
  statusFor,
  when,
} from "./view";

import { fixture, fixtureAnswers } from "./fixtures";
const NOW = Date.parse("2026-10-19T10:07:12.000Z");

beforeAll(() => {
  // `when` reads the viewer's zone; pin it so the expectations hold on every machine.
  vi.stubEnv("TZ", "UTC");
});

describe("fixtures", () => {
  it("every status fixture decodes as a status_get answer", () => {
    const answers = Object.entries(fixtureAnswers);
    expect(answers.length).toBe(15);
    for (const [name, output] of answers) expect(asGetOutput(output), name).toBeDefined();
  });
});

describe("the figure", () => {
  it("shows the estimate with verified beside it, the bar in two tones", () => {
    const f = figure(fixture("fleet").progress);
    expect(f).toMatchObject({ pct: 78, verifiedPct: 58, inFlightPct: 20, verifiedNote: "verified 58%", planning: null });
    expect(f.detail).toEqual(["13 of 18 must items verified", "polish 2/5"]);
  });

  it("falls back to the verified-only figure on a hub without the progress model", () => {
    expect(figure(fixture("fleet-legacy").progress)).toMatchObject({ pct: 72, verifiedPct: 72, inFlightPct: 0, verifiedNote: null });
  });

  it("says planning, not 0%, while the lead plans", () => {
    const d = fixture("order-planning");
    expect(figure(d.progress, d.virtualTier)).toMatchObject({ pct: null, planning: 55, detail: [] });
  });

  it("never lets the lighter part run past 100", () => {
    const p = { ...fixture("fleet").progress, estimate: { pct: 100, verifiedPct: 97, inFlightPct: 5, weights: "default" } };
    expect(figure(p).inFlightPct).toBe(3);
  });
});

describe("the sparkline", () => {
  it("draws both lines and one explained marker per drop", () => {
    const series = fixture("fleet").progress.estimate?.series ?? [];
    const g = spark(series, 600, 40);
    expect(g?.drops.map((d) => d.label)).toEqual([
      "↓ 61% → 55%: CI failed on #212: rust (macos) (CI failed)",
      "↓ 80% → 74%: +3 items: currency table export added (scope added)",
    ]);
    expect(g?.estimate.startsWith("M0 40")).toBe(true);
    expect(g?.estimate.endsWith("L600 8.8"), "ends at 78% at the right edge").toBe(true);
  });

  it("names an unknown drop reason generically", () => {
    const series = fixture("fleet-long-text").progress.estimate?.series ?? [];
    expect(spark(series, 600, 40)?.drops.some((d) => d.label.endsWith("(fell back)"))).toBe(true);
  });

  it("needs two points", () => {
    expect(spark([{ at: "2026-10-19T10:00:00Z", pct: 4, verifiedPct: 0 }], 600, 40)).toBeNull();
  });
});

describe("what it waits on", () => {
  it("is the critical row's path in order, and what blocks other work, with measured ages and no estimated time", () => {
    expect(stateView(fixture("order"), NOW)).toEqual({
      through: "P12 Round totals per currency, not per line",
      path: ["review of #213", "CI on #213", "merge", "done-when checks"],
      blocking: [
        { label: "review of #212", since: "for 4m" },
        { label: "P12 Round totals per currency, not per line holds up P14, P15", since: null },
      ],
    });
  });

  it("falls back to the gates, serial first, on a hub without the path", () => {
    expect(stateView(fixture("fleet-legacy"), NOW)).toEqual({
      through: null,
      path: ["P12 full lab run", "CI on #212 (rust (macos) 8m)"],
      blocking: [{ label: "P12 full lab run", since: null }],
    });
  });

  it("never shows a risk about predicted time", () => {
    const doc = fixture("fleet");
    const risks = [...doc.risks, { rule: "slipping", level: "warning", message: "ETA slipped 20h" }, { rule: "estimate_drift", level: "warning", message: "lead estimated 1h" }];
    expect(shownRisks({ ...doc, risks }).map((r) => r.rule)).toEqual(doc.risks.map((r) => r.rule));
  });

  it("no fixture carries an estimated time the view could show", () => {
    for (const [name, output] of Object.entries(fixtureAnswers)) {
      const text = JSON.stringify(output);
      expect(text, name).not.toMatch(/"(p50|p90|accuracy|overdueMinutes|original|lead|current|eta)":"/u);
    }
  });
});

describe("words", () => {
  it("never puts a wire name on screen", () => {
    expect(sourceName("machine:buildbox")).toBe("buildbox");
    expect(sourceName("github:acme/storefront")).toBe("GitHub for acme/storefront");
    expect(sourceName("weird_source:x")).toBe("weird source x");
    expect(limitName("five_hour")).toBe("5h");
    expect(limitName("seven_day")).toBe("wk");
    expect(limitName("something_new")).toBe("something new");
    expect(stageName("first_push")).toBe("first push");
    expect(stageName("stage_from_a_newer_hub")).toBe("stage from a newer hub");
  });

  it("ages redraw only when their text changes", () => {
    expect(age(59_000)).toBe("<1m");
    expect(age(4 * 60_000 + 5_000)).toBe("4m");
    expect(age(3 * 3_600_000)).toBe("3h");
    expect(nextAgeChange([59_000, 4 * 60_000 + 5_000])).toBe(1_000);
    expect(nextAgeChange([3_600_000 + 60_000])).toBe(3_540_000);
    expect(nextAgeChange([])).toBeNull();
  });

  it("says the day only when it isn't today", () => {
    expect(when("2026-10-19T14:00:00.000Z", NOW)).toBe("14:00");
    expect(when("2026-10-22T14:00:00.000Z", NOW)).toBe("Thu 14:00");
    expect(when("2026-11-30T09:00:00.000Z", NOW)).toBe("Nov 30 09:00");
  });

  it("an in-progress row says its stage, its credit and what it waits on, never a time", () => {
    const [t31, t33] = fixture("order").inProgress;
    expect(t31 && progressRowView(t31)).toEqual([
      "first push",
      "46% credited",
      "waiting on review of #213 → CI on #213 → merge → done-when checks",
      "holds up P14, P15",
    ]);
    expect(t33 && progressRowView(t33)).toEqual(["PR open", "61% credited", "waiting on CI on #212 → merge"]);
    expect(t33?.slowerThanUsual).toBe(true);
  });

  it("a machine says how long it's been gone and when it slept", () => {
    const m = fixture("fleet").health.machines[1];
    expect(m && machineView(m, NOW)).toBe("offline 12m · 3× today");
    const slept = { machineId: "devbox", status: "online", dropsToday: 1, slept: { fromMs: NOW - 3_600_000, toMs: NOW - 3_600_000 + 646_000 } };
    expect(machineView(slept, NOW)).toBe("slept 10m46s at 09:17");
  });
});

describe("the headline", () => {
  it("keeps the hub's Not live clause, and adds one when the app isn't live or a source is stale", () => {
    expect(headlineText(fixture("fleet-stale"), true)).toMatch(/^Not live: GitHub unchecked 6m\. /u);
    expect(headlineText(fixture("fleet"), true)).toMatch(/^Not live: buildbox, claude usage on buildbox stale\. Fixing/u);
    const clean = { ...fixture("fleet"), stale: [] };
    expect(headlineText(clean, true)).toBe(clean.headline.text);
    expect(headlineText(clean, false)).toBe(`Not live: ${clean.headline.text}`);
  });
});

describe("routes and ⌘.", () => {
  it("round-trips every scope", () => {
    for (const name of ["fleet", "project", "order"]) {
      const scope = fixture(name).scope;
      expect(scopeFromRoute(scopeRoute(scope))).toEqual(scope);
    }
    expect(scopeFromRoute("#/status?inbox&ask=A7")).toEqual({ kind: "fleet" });
    expect(scopeFromRoute("#/board")).toBeNull();
  });

  it("opens the status of where you are, and goes back from it", () => {
    expect(statusFor("#/order/W14")).toEqual({ kind: "order", workstreamId: "W14" });
    expect(statusFor("#/board/devbox/storefront")).toEqual({ kind: "project", projectRef: { machineId: "devbox", projectId: "storefront" } });
    expect(statusFor("#/settings")).toEqual({ kind: "fleet" });
    expect(toggleRoute("#/order/W14")).toBe("#/status/order/W14");
    expect(toggleRoute("#/status/order/W14")).toBe("#/order/W14");
    expect(toggleRoute("#/status"), "opened elsewhere: back to the board").toBe("#/board");
  });
});

describe("the digest", () => {
  it("says the figure, what changed since the last digest, and when it isn't live", () => {
    const { title, body } = digestText(fixture("fleet-stale"));
    expect(title).toBe("fleetd · 78% · 3 need you");
    expect(body).toBe(
      "Not live: GitHub unchecked 6m. Fixing cart rounding and speeding up product search, waiting on the full lab run. 3 decisions need you. Since the last digest: 7 merged, 3 verified, 2 started, 1 failed.",
    );
    expect(digestText(fixture("order-planning")).title).toBe("fleetd · planning");
  });
});
