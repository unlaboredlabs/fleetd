import { describe, expect, it } from "vitest";
import type { WorkspaceUsageCounts, WorkspaceUsageDay } from "./contracts";
import { against, change, columnsOf, count, hours, idle, money, onCloud, ticks, wait } from "./usage";

const day = (date: string, n: number, spend?: number): WorkspaceUsageDay => ({
  date,
  orders: n,
  merged: n * 2,
  failed: n % 2,
  agentMs: n * 3_600_000,
  ...(spend === undefined ? {} : { spendCents: spend }),
});

describe("the Usage page's figures", () => {
  it("writes counts in full and times as an admin reads them", () => {
    expect(count(1284)).toBe("1,284");
    expect(hours(0)).toBe("0h");
    expect(hours(20 * 60_000)).toBe("20m");
    expect(hours(6.5 * 3_600_000)).toBe("6.5h");
    expect(hours(4_120 * 3_600_000)).toBe("4,120h");
    expect(wait(48 * 60_000)).toBe("48m");
    expect(wait(3 * 3_600_000 + 10 * 60_000)).toBe("3h 10m");
    expect(wait(52 * 3_600_000)).toBe("2d 4h");
    expect(money(124_000, "USD")).toBe("$1,240");
    expect(money(8_650, "EUR")).toBe("€86.50");
  });

  it("says the change against the period before with an arrow, coloured by which way is better", () => {
    expect(change(110, 100, "up")).toEqual({ text: "↑ 10%", tone: "success" });
    expect(change(90, 100, "up")).toEqual({ text: "↓ 10%", tone: "danger" });
    expect(change(12, 10, "down")).toEqual({ text: "↑ 20%", tone: "danger" });
    expect(change(12, 10, "none")).toEqual({ text: "↑ 20%", tone: "quiet" });
    expect(change(100, 100, "up")).toEqual({ text: "→ same", tone: "quiet" });
    expect(change(3_600_000, 3_000_000, "down", "wait")).toEqual({ text: "↑ 10m", tone: "danger" });
    // Nothing before to compare with: no change shown.
    expect(change(5, 0, "up")).toBeUndefined();
    expect(change(undefined, 5, "up")).toBeUndefined();
  });

  it("says a count that was small before as the two counts, not a share", () => {
    // Seen on the phone: 1 approval before and 133 now read "↑ 13200% against the 30 days before".
    expect(change(133, 1, "none", "count")).toEqual({ text: "up from 1", tone: "quiet", plain: true });
    expect(change(22, 0, "down", "count")).toEqual({ text: "up from none", tone: "danger", plain: true });
    expect(change(2, 9, "up", "count")).toEqual({ text: "down from 9", tone: "danger", plain: true });
    expect(change(4, 4, "up", "count")).toEqual({ text: "same as 4", tone: "quiet", plain: true });
    expect(change(0, 0, "up", "count")).toBeUndefined();
    expect(against({ text: "up from 1", tone: "quiet", plain: true }, 30)).toBe("up from 1 in the 30 days before");
    // Ten or more before: a share as ever.
    expect(change(1289, 169, "none", "count")).toEqual({ text: "↑ 663%", tone: "quiet" });
    expect(against({ text: "↑ 663%", tone: "quiet" }, 30)).toBe("↑ 663% against the 30 days before");
  });

  it("draws a column a day up to a month, and a week a column past it", () => {
    const month = Array.from({ length: 30 }, (_, i) => day(`2026-11-${String(i + 1).padStart(2, "0")}`, i));
    expect(columnsOf(month)).toHaveLength(30);
    expect(columnsOf(month)[0]?.label).toBe("Nov 1");
    const quarter = Array.from({ length: 90 }, (_, i) => day(`2026-${i < 30 ? "09" : i < 60 ? "10" : "11"}-${String((i % 30) + 1).padStart(2, "0")}`, 1, 10));
    const weeks = columnsOf(quarter);
    expect(weeks).toHaveLength(13);
    expect(weeks[0]).toMatchObject({ from: "2026-09-01", to: "2026-09-07", label: "Sep 1 to Sep 7", orders: 7, merged: 14, agentMs: 7 * 3_600_000, spendCents: 70 });
    // The last week holds what is left: 90 = 12 × 7 + 6.
    expect(weeks.at(-1)?.orders).toBe(6);
    expect(weeks.reduce((a, c) => a + c.orders, 0)).toBe(90);
    // No spend on a self-hosted workspace's days.
    expect(columnsOf(month)[0]?.spendCents).toBeUndefined();
  });

  it("puts the axis's ticks 1, 2 or 5 apart, never finer than the unit", () => {
    expect(ticks(23)).toEqual([0, 10, 20, 30]);
    expect(ticks(0)).toEqual([0, 1]);
    expect(ticks(40 * 3_600_000, 3_600_000)).toEqual([0, 10, 20, 30, 40].map((h) => h * 3_600_000));
  });

  it("calls a row idle only when it has nothing in the period, time on fleetd's computers included", () => {
    const none: WorkspaceUsageCounts = { agents: 0, agentMs: 0, approvals: 0, failed: 0, merged: 0, messages: 0, orders: 0 };
    expect(idle(none)).toBe(true);
    expect(idle({ ...none, computerMs: 0, spendCents: 0 })).toBe(true);
    expect(idle({ ...none, approvals: 1 })).toBe(false);
    // The cloud's "No one" row with only the leads' boxes: shown, so the people add up to the spend.
    expect(idle({ ...none, computerMs: 700_000, spendCents: 0 })).toBe(false);
    expect(idle({ ...none, computerMs: 700_000, spendCents: 1 })).toBe(false);
  });

  it("is a cloud workspace's once spend and its currency come", () => {
    const zero = { agents: 0, agentMs: 0, approvals: 0, failed: 0, merged: 0, messages: 0, orders: 0 };
    expect(onCloud({ total: zero })).toBe(false);
    expect(onCloud({ total: { ...zero, spendCents: 0 }, currency: "USD" })).toBe(true);
  });
});
