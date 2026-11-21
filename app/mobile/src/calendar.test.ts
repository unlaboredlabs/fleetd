import { describe, expect, it } from "vitest";
import { canGoLater, monthOf, monthTitle, nextMonth, weeksOf } from "./calendar";

// A fixed clock: never today's date.
const NOW = new Date(2026, 10, 18, 9).getTime();

describe("the month a day is picked from", () => {
  it("lays a month out in weeks from Monday, blanks either side", () => {
    // November 2026 starts on a Sunday.
    const weeks = weeksOf({ year: 2026, month: 10 }, NOW);
    expect(weeks[0]?.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0]?.[6]).toMatchObject({ day: "2026-11-01", date: 1 });
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks.flat().filter((c) => c !== null)).toHaveLength(30);
  });

  it("marks today and keeps the days after it out of reach", () => {
    const days = weeksOf({ year: 2026, month: 10 }, NOW).flat();
    expect(days.find((c) => c?.today === true)?.day).toBe("2026-11-18");
    expect(days.find((c) => c?.day === "2026-11-19")?.future).toBe(true);
    expect(days.find((c) => c?.day === "2026-11-17")?.future).toBe(false);
  });

  it("goes back across a year, and forward no further than this month", () => {
    expect(nextMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(canGoLater(monthOf(NOW), NOW)).toBe(false);
    expect(canGoLater(nextMonth(monthOf(NOW), -1), NOW)).toBe(true);
    expect(monthTitle({ year: 2026, month: 10 })).toBe("November 2026");
  });
});
