import { describe, expect, it } from "vitest";
import type { PerfNow } from "./desktop";
import { stripOf } from "./perfStrip";

const now = (over: Partial<PerfNow> = {}): PerfNow => ({
  viewer: { measured: true, made: 30, arrived: 11, drawn: 11, kbps: 1600 },
  history: [{ made: 30, shown: 11 }],
  picture: undefined,
  quietMs: 40,
  perf: { sent: 300, seq: 300, madeFps: 30, madeKbps: 1600, encoder: "jpeg", cores: 32, cpuPct: 61, memPct: 24, link: { rttMs: 5, queueMs: 0, skipped: 0 } },
  perfAgeMs: 300,
  ...over,
});

describe("the phone's performance strip", () => {
  it("is smooth at the phone's own rate, whatever more the screen sends", () => {
    const s = stripOf(now(), undefined);
    expect(s.verdict.word).toBe("Smooth");
    expect(s.brief).toBe("11/s · 5.0 ms · CPU 61%");
  });
  it("lists the open card's measures in order, in a third of the phone's width", () => {
    const s = stripOf(now(), undefined);
    expect(s.rows.map((r) => r.label)).toEqual(["Shown, of 12 max", "Sent", "Data", "Round trip", "Encoder", "CPU", "Memory", "Path"]);
    expect(s.rows.find((r) => r.label === "Path")?.value).toBe("Workspace");
    expect(s.rows.find((r) => r.label === "Encoder")?.value).toBe("Chrome’s JPEGs");
  });
  it("says the way holds it when only a few get through", () => {
    const held = now({ viewer: { measured: true, made: 3, arrived: 3, drawn: 3, kbps: 5900 }, perf: { ...now().perf!, capBy: "link", link: { rttMs: 77, queueMs: 0, skipped: 0, budgetKbps: 6000 } } });
    expect(stripOf(held, undefined).verdict).toMatchObject({ word: "Slowed on the way", line: "Only 3 a second get through, at 6.0 Mbit/s" });
  });
  it("says a screen whose machine sends no measures isn't measured", () => {
    const s = stripOf(now({ viewer: { measured: false, made: 0, arrived: 11, drawn: 11, kbps: 1600 }, perf: undefined }), undefined);
    expect(s.verdict.word).toBe("Not measured");
    expect(s.rows.map((r) => r.label)).not.toContain("Sent");
  });
  it("says nothing it didn't measure", () => {
    const s = stripOf(now({ perf: undefined }), undefined);
    expect(s.brief).toBe("11/s");
    expect(s.rows.map((r) => r.label)).not.toContain("CPU");
  });
});
