import { describe, expect, it } from "vitest";
import { NO_NAMES, clockMs, delta, fmtBytes, fmtDur, inexact, markedDur, missing, pct, spanTitle } from "./format";
import { compareLine, pieces } from "./insightText";
import type { Coverage, Span } from "./types";

describe("figures", () => {
  it("read durations like the CLI", () => {
    expect(fmtDur(840)).toBe("840 ms");
    expect(fmtDur(3_240)).toBe("3.2s");
    expect(fmtDur(42_900)).toBe("42s");
    expect(fmtDur(130_000)).toBe("2m10s");
    expect(fmtDur(242_000)).toBe("4m02s");
    expect(fmtDur(360_400)).toBe("6m");
    expect(fmtDur(34 * 60_000 + 10_000)).toBe("34m");
    expect(fmtDur(102 * 60_000)).toBe("1h42m");
    expect(fmtDur(185 * 60_000 + 20_000)).toBe("3h05m");
    expect(fmtDur(-5)).toBe("0 ms");
  });

  it("read sizes, clocks, shares and changes plainly", () => {
    expect(fmtBytes(312)).toBe("312 B");
    expect(fmtBytes(48 * 1024 + 100)).toBe("48 KB");
    expect(fmtBytes(1_258_291)).toBe("1.2 MB");
    expect(fmtBytes(118 * 1024 * 1024)).toBe("118 MB");
    expect(clockMs(Date.parse("2026-10-18T10:21:04.500Z"))).toBe("10:21:04");
    expect(pct(39, 100)).toBe("39%");
    expect(pct(1, 1000)).toBe("<1%");
    expect(pct(0, 100)).toBe("0%");
    expect(delta(100, 102)).toBe("▲ 2%");
    expect(delta(100, 69)).toBe("▼ 31%");
    expect(delta(0, 5)).toBe("new");
    expect(delta(7, 7)).toBe("same");
  });
});

const span = (kind: Span["kind"], extra: Partial<Span> = {}): Span => ({
  id: 1,
  kind,
  cat: "tools",
  lane: "thread:m/s-1",
  startMs: 0,
  endMs: 48_000,
  status: "ok",
  ...extra,
});

describe("what isn't exact", () => {
  it("marks each inexact figure with its own sign", () => {
    expect(inexact(span("model.first_token"), NO_NAMES, false)?.mark).toBe("≈");
    expect(inexact(span("tool.read"), NO_NAMES, true)?.mark).toBe("≤");
    expect(inexact(span("ci.check"), NO_NAMES, false)?.mark).toBe("±1 s");
    expect(inexact(span("tool.bash", { threadId: "lead-x" }), { ...NO_NAMES, leads: new Set(["lead-x"]) }, false)?.mark).toBe("split");
    expect(inexact(span("tool.bash"), NO_NAMES, false)).toBeUndefined();
    expect(markedDur(48_000, "≤")).toBe("≤ 48s");
    expect(markedDur(48_000, "±1 s")).toBe("48s ±1 s");
  });

  it("titles a span by its check, its ask, its command, or its kind", () => {
    expect(spanTitle(span("ci.check", { extra: { check: "lint" } }))).toBe("lint");
    expect(spanTitle(span("wait.ask", { extra: { key: "deploy.region" } }))).toBe("ask deploy.region");
    expect(spanTitle(span("tool.bash", { label: "cargo test" }))).toBe("cargo test");
    expect(spanTitle(span("run.startup"))).toBe("startup");
  });

  it("says missing data only where it applies", () => {
    const cut: Coverage = { complete: false, gaps: [], detailSince: "2026-09-18T10:00:00.000Z" };
    expect(missing(cut, Date.parse("2026-10-18T08:10:00.000Z"))).toEqual({ gaps: 0, capped: false });
    expect(missing(cut, Date.parse("2026-09-01T08:00:00.000Z")).detailSince).toBe("2026-09-18");
    expect(missing(cut, undefined).detailSince).toBeUndefined();
    const gaps: Coverage = {
      complete: false,
      gaps: [
        { why: "node_older", fromMs: 0, toMs: 1 },
        { why: "hub_dropped", fromMs: 0, toMs: 1, count: 3 },
      ],
    };
    expect(missing(gaps, undefined).gaps).toBe(2);
    expect(missing({ complete: true, gaps: [], capped: true }, undefined).capped).toBe(true);
  });
});

describe("insight text", () => {
  it("sets commands and numbers as machine text, keeping the hub's spacing", () => {
    const p = pieces("agents ran `npm test` 22× (51m); 14 runs");
    expect(p.find((x) => x.text === "npm test")?.mono).toBe(true);
    expect(p.find((x) => x.text === "22×")?.mono).toBe(true);
    expect(p.find((x) => x.text === "agents")?.mono).toBe(false);
    expect(p.map((x) => x.text).join("")).toBe("agents ran npm test 22× (51m); 14 runs");
  });

  it("shows each number for the earlier period, then this one", () => {
    const now = [
      { name: "runs", value: 9 },
      { name: "totalMs", value: 19 * 60_000 },
    ];
    const before = [
      { name: "runs", value: 22 },
      { name: "totalMs", value: 51 * 60_000 },
    ];
    expect(compareLine(now, before)).toBe("runs 22 → 9 · total 51m → 19m");
    expect(compareLine(now.slice(0, 1), [])).toBe("runs 0 → 9");
    expect(compareLine([{ name: "noEdit", value: 5 }, { name: "peakQueued", value: 3 }], [])).toBe("no edit 0 → 5 · peak queued 0 → 3");
  });
});
