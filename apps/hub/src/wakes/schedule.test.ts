import { describe, expect, it } from "vitest";
import { CronError, nextCron, nextRun, offsetMs, parseAt, parseCron, ScheduleError, zonedToUtc } from "./schedule.ts";

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);
const NY = "America/New_York";
const LONDON = "Europe/London";

/** Successive firings after `from`. */
const firings = (cron: string, tz: string, from: string, count: number) => {
  const parsed = parseCron(cron);
  const out: Array<string | undefined> = [];
  let t = at(from);
  for (let i = 0; i < count; i++) {
    const next = nextCron(parsed, t, tz);
    out.push(iso(next));
    if (next === undefined) break;
    t = next;
  }
  return out;
};

describe("time zones", () => {
  it("knows New York's offset either side of DST", () => {
    expect(offsetMs(at("2026-01-15T12:00:00Z"), NY)).toBe(-5 * 3600_000);
    expect(offsetMs(at("2026-07-15T12:00:00Z"), NY)).toBe(-4 * 3600_000);
  });

  it("moves a local time in the spring-forward gap forward by the gap", () => {
    // 2026-03-08 02:30 does not exist in New York; clocks jump from 02:00 EST to 03:00 EDT.
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, NY))).toBe("2026-03-08T07:30:00.000Z");
  });

  it("takes the first of a local time that happens twice when DST ends", () => {
    // 2026-11-01 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    expect(iso(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, NY))).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("parseAt", () => {
  it("treats a time with Z or an offset as absolute, whatever tz says", () => {
    expect(iso(parseAt("2026-10-18T09:00:00Z", NY))).toBe("2026-10-18T09:00:00.000Z");
    expect(iso(parseAt("2026-10-18T09:00:00+02:00", NY))).toBe("2026-10-18T07:00:00.000Z");
  });

  it("reads a time without an offset as wall-clock time in tz", () => {
    expect(iso(parseAt("2026-10-18T09:00", LONDON))).toBe("2026-10-18T08:00:00.000Z");
    expect(iso(parseAt("2026-12-18T09:00", LONDON))).toBe("2026-12-18T09:00:00.000Z");
  });

  it("refuses text that is not a real date-time", () => {
    expect(() => parseAt("tomorrow 9am", NY)).toThrow(ScheduleError);
    expect(() => parseAt("2026-02-30T09:00", NY)).toThrow(ScheduleError);
    expect(() => parseAt("2026-02-10T24:00", NY)).toThrow(ScheduleError);
  });
});

describe("parseCron", () => {
  it("expands lists, ranges, steps, names and macros", () => {
    const c = parseCron("0,30 9-17/4 * jan-mar MON-FRI");
    expect(c.minutes).toEqual([0, 30]);
    expect(c.hours).toEqual([9, 13, 17]);
    expect([...c.months].toSorted()).toEqual([1, 2, 3]);
    expect([...c.weekdays].toSorted()).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("@hourly").minutes).toEqual([0]);
    expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]);
    expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
  });

  it("refuses malformed fields with a reason", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/u);
    expect(() => parseCron("60 * * * *")).toThrow(/minute 60/u);
    expect(() => parseCron("* * * * 1-")).toThrow(CronError);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/u);
    expect(() => parseCron("5-1 * * * *")).toThrow(/backwards/u);
  });
});

describe("nextCron", () => {
  it("runs a weekday 09:00 job in local time across the spring DST change", () => {
    // DST starts Sunday 2026-03-08 in New York: 09:00 is 14:00Z before, 13:00Z after.
    expect(firings("0 9 * * 1-5", NY, "2026-03-05T15:00:00Z", 3)).toEqual([
      "2026-03-06T14:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
      "2026-03-10T13:00:00.000Z",
    ]);
  });

  it("runs a daily job in the skipped hour once, an hour later, and keeps its time the next day", () => {
    expect(firings("30 2 * * *", NY, "2026-03-07T12:00:00Z", 3)).toEqual([
      "2026-03-08T07:30:00.000Z", // 02:30 EST is skipped: runs at 03:30 EDT
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("runs a daily job in the repeated hour only once", () => {
    expect(firings("30 1 * * *", NY, "2026-10-31T12:00:00Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z", // first 01:30 (EDT)
      "2026-11-02T06:30:00.000Z", // 01:30 EST
    ]);
  });

  it("keeps an hourly job on the hour through the autumn change in London", () => {
    // 2026-10-25 01:00-02:00 BST becomes 01:00-02:00 GMT.
    expect(firings("0 * * * *", LONDON, "2026-10-24T23:30:00Z", 3)).toEqual([
      "2026-10-25T00:00:00.000Z", // 01:00 BST
      "2026-10-25T02:00:00.000Z", // 02:00 GMT; the repeated 01:00 runs once
      "2026-10-25T03:00:00.000Z",
    ]);
  });

  it("matches either day field when both are restricted", () => {
    // The 13th, or any Friday: Fri 2026-11-06, Fri 11-13 (both), Fri 11-20.
    expect(firings("0 12 13 * 5", "UTC", "2026-11-01T00:00:00Z", 3)).toEqual([
      "2026-11-06T12:00:00.000Z",
      "2026-11-13T12:00:00.000Z",
      "2026-11-20T12:00:00.000Z",
    ]);
  });

  it("finds a Feb 29 years ahead and gives up on a date that never comes", () => {
    expect(firings("0 0 29 2 *", "UTC", "2026-10-17T00:00:00Z", 1)).toEqual(["2028-02-29T00:00:00.000Z"]);
    expect(nextCron(parseCron("0 0 30 2 *"), at("2026-10-17T00:00:00Z"), "UTC")).toBeUndefined();
  });

  it("is strictly after the given instant", () => {
    expect(firings("0 9 * * *", "UTC", "2026-10-17T09:00:00Z", 1)).toEqual(["2026-10-18T09:00:00.000Z"]);
  });
});

describe("nextRun", () => {
  it("returns an at-time only while it is in the future", () => {
    const schedule = { kind: "at", at: "2026-10-17T10:01:00Z", tz: "UTC" } as const;
    expect(iso(nextRun(schedule, at("2026-10-17T10:00:00Z")))).toBe("2026-10-17T10:01:00.000Z");
    expect(nextRun(schedule, at("2026-10-17T10:01:00Z"))).toBeUndefined();
  });

  it("keeps every-N runs on the grid of the first one, skipping the ones already past", () => {
    const schedule = { kind: "every", everySec: 3600 } as const;
    expect(iso(nextRun(schedule, at("2026-10-17T10:00:00Z")))).toBe("2026-10-17T11:00:00.000Z");
    expect(iso(nextRun(schedule, at("2026-10-17T13:20:00Z"), at("2026-10-17T11:00:00Z")))).toBe("2026-10-17T14:00:00.000Z");
  });
});
