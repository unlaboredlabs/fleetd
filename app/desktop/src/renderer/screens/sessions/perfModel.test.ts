import { describe, expect, it } from "vitest";
import type { ScreenPerf } from "../../../shared/contracts";
import { FrameCounts, graphOf, groupsOf, verdictOf, type PerfNow } from "./perfModel";

const PERF: ScreenPerf = {
  sent: 300,
  seq: 300,
  madeFps: 30,
  madeKbps: 1200,
  encoder: "x264",
  encodeMs: 2.6,
  cores: 8,
  cpuPct: 20,
  memPct: 40,
  link: { rttMs: 12, queueMs: 0, skipped: 0 },
};

const now = (over: Partial<PerfNow> = {}): PerfNow => ({
  viewer: { measured: true, made: 30, arrived: 30, drawn: 30, kbps: 1200 },
  history: [{ made: 30, shown: 30 }],
  picture: { width: 1280, height: 800 },
  quietMs: 30,
  perf: PERF,
  perfAgeMs: 400,
  ...over,
});

describe("verdictOf", () => {
  it("is smooth with its rate and round trip", () => {
    expect(verdictOf(now())).toEqual({
      word: "Smooth",
      line: "30 a second, 12 ms round trip",
      tone: "success",
    });
  });
  it("is still, not slow, when no frame came", () => {
    expect(verdictOf(now({ quietMs: 8_000 })).word).toBe("Still");
  });
  it("names the machine before the way when the load holds the rate", () => {
    const busy = now({
      perf: {
        ...PERF,
        capFps: 15,
        capBy: "busy",
        cpuPct: 95,
        link: { rttMs: 12, queueMs: 0, skipped: 3 },
      },
    });
    expect(verdictOf(busy)).toMatchObject({
      word: "Slowed by the machine",
      tone: "warning",
    });
  });
  it("isn't slow for a budget alone, with nothing lost", () => {
    const held = now({
      perf: {
        ...PERF,
        link: { rttMs: 1, queueMs: 0, skipped: 0, budgetKbps: 2500 },
      },
    });
    expect(verdictOf(held).word).toBe("Smooth");
  });
  it("says frames were lost on the way when they didn't come", () => {
    const lost = now({
      viewer: { measured: true, made: 30, arrived: 12, drawn: 12, kbps: 900 },
      perf: {
        ...PERF,
        link: { rttMs: 1, queueMs: 300, skipped: 18, budgetKbps: 900 },
      },
    });
    expect(verdictOf(lost).line).toBe("18 of 30 frames a second skipped on the way: it gets 900 kbit/s through");
  });
  it("blames this window for frames the sender didn't skip", () => {
    const slow = now({
      viewer: { measured: true, made: 31, arrived: 12, drawn: 0, kbps: 300 },
      perf: { ...PERF, link: { rttMs: 1, queueMs: 0, skipped: 3 } },
    });
    expect(verdictOf(slow)).toMatchObject({
      word: "Slowed here",
      line: "This window showed 0 of the 28 frames that reached it",
    });
  });
  it("says the way holds it when the screen sends only what gets through", () => {
    const held = now({
      viewer: { measured: true, made: 4, arrived: 4, drawn: 4, kbps: 8400 },
      perf: {
        ...PERF,
        capBy: "link",
        link: { rttMs: 73, queueMs: 0, skipped: 0, budgetKbps: 6000 },
      },
    });
    expect(verdictOf(held, 12)).toMatchObject({
      word: "Slowed on the way",
      line: "Only 4 a second get through, at 6.0 Mbit/s",
    });
  });
  it("isn't slowed here for a single frame lost at a few frames a second", () => {
    expect(verdictOf(now({ viewer: { measured: true, made: 8, arrived: 8, drawn: 7, kbps: 300 } })).word).toBe(
      "Smooth",
    );
    expect(verdictOf(now({ viewer: { measured: true, made: 8, arrived: 8, drawn: 6, kbps: 300 } })).word).toBe(
      "Slowed here",
    );
  });
  it("doesn't blame a phone for frames its sender paced away", () => {
    expect(
      verdictOf(
        now({
          viewer: {
            measured: true,
            made: 26,
            arrived: 10,
            drawn: 10,
            kbps: 900,
          },
        }),
        12,
      ).word,
    ).toBe("Smooth");
  });
  it("doesn't count what a phone never draws as lost", () => {
    expect(
      verdictOf(
        now({
          viewer: {
            measured: true,
            made: 30,
            arrived: 12,
            drawn: 12,
            kbps: 900,
          },
        }),
        12,
      ).word,
    ).toBe("Smooth");
  });
  it("blames this computer when it draws far fewer than came", () => {
    expect(
      verdictOf(
        now({
          viewer: {
            measured: true,
            made: 30,
            arrived: 30,
            drawn: 12,
            kbps: 1200,
          },
        }),
      ).word,
    ).toBe("Slowed here");
  });
  it("doesn't judge on the machine's measures once they're stale", () => {
    const stale = now({
      perfAgeMs: 10_000,
      perf: { ...PERF, capBy: "busy", capFps: 10 },
    });
    expect(verdictOf(stale).word).toBe("Smooth");
  });
});

describe("groupsOf", () => {
  it("leaves out what wasn't measured", () => {
    const g = groupsOf(now({ perf: undefined }), {
      kind: undefined,
      screen: { width: 1280, height: 800 },
      shownWidth: 1024,
      direct: true,
      machine: "devbox",
    });
    expect(g.map((x) => x.label)).toEqual(["Stream"]);
    expect(g[0]?.rows.find((r) => r.label === "Scaled")?.value).toBe("80%");
  });
});

describe("FrameCounts", () => {
  /** A screen that makes 30 a second; `gets` says which frames reach the viewer, each drawn on arrival; a measure on
   * every 30th frame made, carried by the next frame that comes. */
  const run = (gets: (seq: number) => boolean, seconds = 5) => {
    const c = new FrameCounts();
    let pending: { sent: number; seq: number } | undefined;
    for (let seq = 1; seq <= seconds * 30; seq++) {
      if (seq % 30 === 0) pending = { sent: seq, seq };
      if (!gets(seq)) continue;
      const at = seq * (1000 / 30) + 4;
      c.arrived(seq, 1, 1000, at, pending);
      pending = undefined;
      c.drawn(seq);
    }
    return c.second(seconds * 1000 + 20);
  };
  it("counts a steady stream as made, came and drawn alike", () => {
    expect(run(() => true)).toMatchObject({ made: 30, arrived: 30, drawn: 30 });
  });
  it("never shows more than were made, whatever edge a second falls on", () => {
    for (const offset of [1, 7, 13, 29]) {
      const r = run((q) => q % 31 !== offset);
      expect(r.drawn).toBeLessThanOrEqual(r.made);
      expect(r.arrived).toBeLessThanOrEqual(r.made);
    }
  });
  it("counts frames made that never reached this viewer", () => {
    const r = run((q) => q % 3 === 0);
    expect(r.made).toBe(30);
    expect(r.drawn).toBe(10);
  });
  it("reads nothing once the measures stop coming (a still screen)", () => {
    const c = new FrameCounts();
    c.arrived(30, 1, 1, 1_000, { sent: 30, seq: 30 });
    c.arrived(60, 1, 1, 2_000, { sent: 60, seq: 60 });
    expect(c.second(9_000).made).toBe(0);
  });
});

describe("graphOf", () => {
  it("fills only the seconds that showed fewer than they could", () => {
    const g = graphOf([
      { made: 30, shown: 30 },
      { made: 30, shown: 12 },
    ]);
    expect(g.gap.match(/Z/g)?.length).toBe(1);
  });
  it("holds a phone's target to what it draws", () => {
    const g = graphOf([{ made: 30, shown: 12 }], 12);
    expect(g.gap).toBe("");
    expect(g.targetNow).toBe(12);
  });
});

describe("a screen whose machine sends no measures", () => {
  it("counts what came and was drawn, and says it isn't measured rather than smooth at zero", () => {
    const c = new FrameCounts();
    for (let seq = 1; seq <= 90; seq++) {
      c.arrived(seq, 1, 1000, seq * (1000 / 30));
      c.drawn(seq);
    }
    const viewer = c.second(3_000 + 5);
    expect(viewer).toMatchObject({
      measured: false,
      arrived: 30,
      drawn: 30,
    });
    expect(viewer.kbps).toBeGreaterThan(0);
    const n = now({ viewer, perf: undefined, history: c.history });
    expect(verdictOf(n)).toEqual({
      word: "Not measured",
      line: "30 a second shown here",
      detail: "This machine doesn’t send measures yet",
      tone: "quiet",
    });
    const rows = groupsOf(n, {
      kind: undefined,
      screen: undefined,
      shownWidth: undefined,
      direct: false,
      machine: undefined,
    }).flatMap((g) => g.rows);
    expect(rows.map((r) => r.label)).not.toContain("Sent");
    expect(rows.find((r) => r.label === "Shown")?.value).toBe("30 a second");
    expect(graphOf(c.history).gap).toBe("");
  });
});
