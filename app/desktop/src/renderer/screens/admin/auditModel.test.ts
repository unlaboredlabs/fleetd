// Audit log's filters as audit_list takes them, its times, and Export's file name.
import { expect, it } from "vitest";
import { exportName, inputOf, NO_FILTERS, whenText } from "./auditModel";

const NOW = Date.parse("2026-11-26T12:00:00Z");

it("sends only the filters picked, the range as a start from now", () => {
  expect(inputOf(NO_FILTERS, NOW)).toEqual({});
  expect(inputOf({ person: "p_aaaaaaaa", bot: "p1", kind: "vault", range: "7" }, NOW)).toEqual({
    personId: "p_aaaaaaaa",
    projectId: "p1",
    kind: "vault",
    since: "2026-11-19T12:00:00.000Z",
  });
});

it("reads a time short: today's by the clock, this year's with its day, older with its year", () => {
  expect(whenText(new Date(NOW - 60_000).toISOString(), NOW)).toMatch(/^\d\d:\d\d$/);
  expect(whenText("2026-03-04T09:05:00Z", NOW)).toMatch(/^4 Mar \d\d:\d\d$/);
  expect(whenText("2025-12-01T09:05:00Z", NOW)).toBe("1 Dec 2025");
});

it("names the export after the workspace and the day", () => {
  expect(exportName("Acme's workspace", NOW)).toBe("fleetd-audit-acme-s-workspace-2026-11-26.csv");
  expect(exportName("✱", NOW)).toBe("fleetd-audit-workspace-2026-11-26.csv");
});
