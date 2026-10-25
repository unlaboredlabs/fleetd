/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, decodeFilters, inRange, period, previousWords, queryOf } from "./filters";

// 2026-10-19 09:03 local.
const NOW = new Date(2026, 9, 19, 9, 3).getTime();

describe("filters", () => {
  it("open on the last 30 whole days, today included", () => {
    expect(DEFAULT_FILTERS.range).toBe("month");
    const [since, until] = period(DEFAULT_FILTERS, NOW);
    expect(new Date(since)).toEqual(new Date(2026, 8, 20));
    expect(until).toBeUndefined();
    expect(new Date(period({ range: "week", compare: false }, NOW)[0])).toEqual(new Date(2026, 9, 13));
    expect(new Date(period({ range: "quarter", compare: false }, NOW)[0])).toEqual(new Date(2026, 6, 22));
  });

  it("ask for the project, the zone and compare, and for until only on a custom range", () => {
    const project = { machineId: "devbox", projectId: "storefront" };
    expect(queryOf({ range: "week", compare: true }, project, NOW, "Europe/Paris")).toEqual({
      since: new Date(2026, 9, 13).toISOString(),
      tz: "Europe/Paris",
      compare: true,
      projectRef: project,
    });
    const custom = { range: "custom", compare: false, custom: { since: NOW - 86_400_000, until: NOW } } as const;
    expect(queryOf(custom, null, NOW, "UTC")).toEqual({ since: new Date(NOW - 86_400_000).toISOString(), until: new Date(NOW).toISOString(), tz: "UTC", compare: false });
  });

  it("say the range and the period before in words", () => {
    expect(inRange(DEFAULT_FILTERS)).toBe("in 30 days");
    expect(inRange({ range: "custom", compare: false, custom: { since: 0 } })).toBe("in this range");
    expect(previousWords({ range: "week", compare: false }, NOW)).toBe("vs the 7 days before");
  });

  it("read back what was saved, and drop what this app doesn't understand", () => {
    expect(decodeFilters({ range: "quarter", compare: true })).toEqual({ range: "quarter", compare: true });
    expect(decodeFilters({ range: "decade" })).toEqual(DEFAULT_FILTERS);
    expect(decodeFilters({ range: "custom", custom: { since: 5, until: 9 } })).toEqual({ range: "custom", compare: false, custom: { since: 5, until: 9 } });
    // A custom range with no start is not one.
    expect(decodeFilters({ range: "custom", compare: true })).toEqual({ ...DEFAULT_FILTERS, compare: true });
    expect(decodeFilters(null)).toEqual(DEFAULT_FILTERS);
  });
});

// The four route hues and the minutes chart's fifth, as validated with the dataviz skill's validate_palette.js against
// --bg in each theme (light: every check passes, slots 3 to 5 under 3:1 with labels and the list as relief; dark: every
// check passes). A change to a slot needs the validator run again and these updated with its output.
const VALIDATED = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
};

describe("the series palette", () => {
  const css = readFileSync(new URL("../../ui/tokens.css", import.meta.url), "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(selector);
    return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  };
  const slots = (body: string) => [1, 2, 3, 4, 5].map((n) => new RegExp(`--series-${n}:\\s*(#[0-9a-f]{6})`, "iu").exec(body)?.[1]?.toLowerCase());

  it("is the validated one, in its fixed order, in both themes", () => {
    expect(slots(block('[data-theme="light"]'))).toEqual(VALIDATED.light);
    expect(slots(block('[data-theme="dark"] {'))).toEqual(VALIDATED.dark);
  });
});
