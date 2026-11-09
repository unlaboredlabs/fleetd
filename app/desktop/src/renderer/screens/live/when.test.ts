import { afterEach, describe, expect, it, vi } from "vitest";
import { age, fullWhen, when } from "./when";

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOW = Date.parse("2026-10-19T10:07:12.000Z");

describe("when", () => {
  it("says measured ages, never estimates", () => {
    expect(age(4 * 60_000 + 5_000)).toBe("4m");
    expect(age(30_000)).toBe("<1m");
    expect(age(3 * 60 * 60_000)).toBe("3h");
    expect(age(3 * 24 * 60 * 60_000)).toBe("3d");
  });

  it("always says which day a time was, so an old one never passes for today", () => {
    // Read in the viewer's zone; pinned so the words below hold on every machine.
    vi.stubEnv("TZ", "UTC");
    expect(when("2026-10-19T08:18:00.000Z", NOW)).toBe("today 08:18");
    expect(when("2026-10-18T16:40:00.000Z", NOW)).toBe("yesterday 16:40");
    expect(when("2026-10-16T14:00:00.000Z", NOW)).toBe("Fri 14:00");
    expect(when("2026-10-07T14:00:00.000Z", NOW)).toBe("Oct 7");
    expect(when("2025-12-30T14:00:00.000Z", NOW)).toBe("Dec 30, 2025");
    expect(fullWhen("2026-10-16T14:00:00.000Z")).toBe("Fri Oct 16, 14:00");
  });
});
