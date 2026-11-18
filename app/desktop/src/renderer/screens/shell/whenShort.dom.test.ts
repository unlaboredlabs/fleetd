// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { whenShort } from "./Sidebar";

// What the sidebar's modules read of the preload as they load.
vi.hoisted(() => {
  (window as unknown as { fleetd: object }).fleetd = { platform: "linux", fixture: null };
});

describe("whenShort", () => {
  // Its formatters are made once and kept: each case reads as toLocale*String with the same options reads.
  const now = new Date(2026, 10, 18, 15, 30);
  it("says a time today, Yesterday, a weekday this week, else a date, the year only when it isn't this one", () => {
    const today = new Date(2026, 10, 18, 9, 14);
    const tuesday = new Date(2026, 10, 15, 8, 0);
    const earlier = new Date(2026, 9, 3, 8, 0);
    const lastYear = new Date(2025, 9, 3, 8, 0);
    expect(whenShort(today.toISOString(), now)).toBe(today.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(whenShort(new Date(2026, 10, 17, 23, 0).toISOString(), now)).toBe("Yesterday");
    expect(whenShort(tuesday.toISOString(), now)).toBe(tuesday.toLocaleDateString(undefined, { weekday: "short" }));
    expect(whenShort(earlier.toISOString(), now)).toBe(earlier.toLocaleDateString(undefined, { day: "numeric", month: "short" }));
    expect(whenShort(lastYear.toISOString(), now)).toBe(lastYear.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" }));
    // Asked again, the kept formatter says the same.
    expect(whenShort(today.toISOString(), now)).toBe(today.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(whenShort("not a date", now)).toBe("");
  });
});
