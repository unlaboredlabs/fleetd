import { describe, expect, it } from "vitest";
import type { Machine, MachineLive } from "./contracts";
import { agoText, durationText, machineParts, slotsText } from "./machineText";

const now = Date.parse("2026-10-18T10:07:00Z");
const machine = (over: Partial<Machine> = {}): Machine => ({
  machineId: "devbox",
  name: "devbox",
  tags: [],
  status: "online",
  lastSeenAt: "2026-10-18T10:06:50Z",
  nodeVersion: "0.4.0",
  ...over,
});
const live = (over: Partial<MachineLive> = {}): MachineLive => ({ machineId: "devbox", name: "devbox", status: "online", running: 2, asOf: "2026-10-18T10:07:00Z", ...over });
const texts = (m: Machine, l?: MachineLive) => machineParts(m, l, now).map((p) => p.text);

describe("a machine's line", () => {
  it("says how long an offline machine has been gone and nothing else", () => {
    expect(texts(machine({ status: "offline", lastSeenAt: "2026-10-18T09:55:00Z" }), live())).toEqual(["offline, last seen 12 min ago"]);
  });

  it("shows a sleep for an hour after the wake, from live or the snapshot", () => {
    const woke = now - 5 * 60_000;
    expect(texts(machine(), live({ slept: { fromMs: woke - 646_000, toMs: woke } }))).toEqual(["2 running", "slept 10m46s"]);
    expect(texts(machine({ lastSlept: { fromMs: woke - 40_000, toMs: woke } }))).toEqual(["slept 40s"]);
    expect(texts(machine({ lastSlept: { fromMs: now - 3 * 3600_000, toMs: now - 2 * 3600_000 } }))).toEqual([]);
  });

  it("shows load, memory and claude usage only when reported, with the worst usage tone", () => {
    const parts = machineParts(
      machine({ status: "degraded" }),
      live({
        load: {
          cpus: 32,
          load1: 3.14,
          memUsedPct: 41,
          limits: [
            { limitType: "five_hour", utilization: 0.58, status: "allowed" },
            { limitType: "seven_day", utilization: 0.41, status: "allowed_warning" },
            { limitType: "seven_day_opus", status: "allowed" },
          ],
        },
      }),
      now,
    );
    expect(parts.map((p) => p.text)).toEqual(["degraded", "2 running", "load 3.1/32", "mem 41%", "claude 58% 5h · 41% wk"]);
    expect(parts.at(-1)?.tone).toBe("warning");
  });

  it("formats durations, ages and slots", () => {
    expect([durationText(46_000), durationText(646_000), durationText(7_500_000)]).toEqual(["46s", "10m46s", "2h05m"]);
    expect([agoText(10_000), agoText(3 * 3600_000), agoText(86_400_000)]).toEqual(["just now", "3 h ago", "1 day ago"]);
    expect(slotsText({ cap: 40, used: 8, queued: 1, perProject: [] })).toBe("agents 8 / 40 · 1 queued");
    expect(slotsText({ cap: 40, used: 8, queued: 0, perProject: [] })).toBe("agents 8 / 40");
  });
});
