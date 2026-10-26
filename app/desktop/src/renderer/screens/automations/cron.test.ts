import { describe, expect, it } from "vitest";
import { describeCron } from "./cron";

const text = (cron: string, tz = "") => {
  const r = describeCron(cron, tz);
  return r.ok ? r.text : `error: ${r.error}`;
};

describe("describeCron", () => {
  it("reads the common schedules in plain words", () => {
    expect(text("0 9 * * 1-5", "Europe/Berlin")).toBe("At 09:00, Monday to Friday (Europe/Berlin)");
    expect(text("30 12 * * *")).toBe("Every day at 12:30");
    expect(text("*/15 * * * *")).toBe("Every 15 minutes");
    expect(text("0 * * * *")).toBe("Every hour");
    expect(text("5 */6 * * *")).toBe("Every 6 hours at 05 past");
    expect(text("0 9 * * mon")).toBe("At 09:00, on Monday");
    expect(text("0 9,13,17 * * *")).toBe("Every day at 09:00, 13:00 and 17:00");
    expect(text("0 10 * * 0,6")).toBe("At 10:00, on weekends");
    expect(text("0 9 1 * *")).toBe("At 09:00, on day 1 of the month");
    expect(text("0 0 1 1 *")).toBe("At 00:00, on day 1 of the month, in January");
    expect(text("@daily", "UTC")).toBe("Every day at 00:00 (UTC)");
    expect(text("0 8-18 * * 1-5")).toBe("Every hour from 08:00 to 18:00, Monday to Friday");
  });

  it("reads both day fields as either one, as cron runs them", () => {
    expect(text("0 9 1 * 1")).toBe("At 09:00, on day 1 of the month or on Monday");
  });

  it("takes 7 as Sunday", () => {
    expect(text("0 9 * * 7")).toBe("At 09:00, on Sunday");
  });

  it("says why a cron doesn't read", () => {
    expect(text("0 9 * *")).toMatch(/five fields/u);
    expect(text("61 * * * *")).toBe("error: minute 61 is outside 0-59.");
    expect(text("0 9 * * 5-1")).toBe("error: '5-1' runs backwards.");
    expect(text("0 9 * * xyz")).toBe("error: 'xyz' is not a valid day of week.");
  });
});
