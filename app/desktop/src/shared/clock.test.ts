import { expect, it } from "vitest";
import { clock, clockFormat } from "./clock";

const afternoon = Date.UTC(2026, 10, 26, 16, 2);
const morning = Date.UTC(2026, 10, 26, 9, 5);

it("says the time as a 12-hour locale does, and as a 24-hour one does", () => {
  expect(clockFormat("UTC", undefined, "en-US").format(afternoon)).toBe("4:02 PM");
  expect(clockFormat("UTC", undefined, "en-US").format(morning)).toBe("9:05 AM");
  expect(clockFormat("UTC", undefined, "en-GB").format(afternoon)).toBe("16:02");
  expect(clockFormat("UTC", undefined, "en-GB").format(morning)).toBe("09:05");
  expect(clockFormat("UTC", { weekday: "short" }, "en-US").format(morning)).toBe("Thu 9:05 AM");
});

it("uses the person's own locale, never a fixed one", () => {
  const theirs = new Intl.DateTimeFormat().resolvedOptions().locale;
  expect(clockFormat("UTC").resolvedOptions().locale).toBe(theirs);
  expect(clock(afternoon, "UTC")).toBe(clockFormat("UTC", undefined, theirs).format(afternoon));
  expect(clock(new Date(afternoon).toISOString(), "UTC")).toBe(clock(afternoon, "UTC"));
  expect(clock("not a time")).toBe("");
});
