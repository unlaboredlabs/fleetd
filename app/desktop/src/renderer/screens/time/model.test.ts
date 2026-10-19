import { describe, expect, it } from "vitest";
import { fixtureNames, fixtureOrder } from "./fixture";
import { NO_NAMES, categoryKinds, clockMs } from "./format";
import { CAT_CODE, bars, barsFor, buildModel, hit, ticks, type Model } from "./model";
import type { Category, Coverage, Span, SpanKind } from "./types";
import { KIND_CATEGORY } from "./types";

const span = (id: number, kind: SpanKind, a: number, b: number, extra: Partial<Span> = {}): Span => ({
  id,
  kind,
  cat: KIND_CATEGORY[kind],
  lane: "thread:m/s-1",
  startMs: a,
  endMs: b,
  status: "ok",
  threadId: "s-1",
  ...extra,
});

/** A one-row model straight from (start, end, category) triples. */
const row = (items: [number, number, Category][]): Model => {
  const kindOf: Record<Category, SpanKind> = {
    model: "model.output",
    tools: "tool.bash",
    machine: "claude.other",
    queue: "queue.slot",
    human: "wait.permission",
    pipeline: "change.review",
    idle: "idle",
  };
  return buildModel(
    items.map(([a, b, c], i) => span(i + 1, kindOf[c], a, b)),
    undefined,
    undefined,
    NO_NAMES,
    0,
  );
};

const none = () => false;

describe("bars", () => {
  it("merges spans narrower than a pixel into one bar per column, coloured by the category with the most time", () => {
    // 1000 ms across 100 px: 10 ms per px.
    const m = row([
      [0, 3, "model"],
      [3, 9, "tools"],
      [9, 10, "model"],
      [10, 500, "tools"],
      [500, 1000, "human"],
    ]);
    const b = bars(m, 0, 5, 0, 1000, 100, none);
    expect(b.map((x) => [x.n, x.cat, x.x0, x.x1])).toEqual([
      [3, CAT_CODE.tools, 0, 1],
      [1, CAT_CODE.tools, 1, 50],
      [1, CAT_CODE.human, 50, 100],
    ]);
  });

  it("draws only what is in view, and never more bars than pixels", () => {
    const items: [number, number, Category][] = [];
    for (let i = 0; i < 20_000; i += 1) items.push([i * 100, i * 100 + 100, i % 3 === 0 ? "model" : "tools"]);
    const m = row(items);
    const all = bars(m, 0, 20_000, 0, 2_000_000, 400, none);
    expect(all.length).toBeLessThanOrEqual(400);
    expect(all.every((b) => b.cat === CAT_CODE.tools)).toBe(true);
    const zoomed = bars(m, 0, 20_000, 50_000, 51_000, 1000, none);
    expect(zoomed).toHaveLength(10);
    expect(zoomed[0]?.first).toBe(500);
  });

  it("keeps path, failure and highlight on a merged bar", () => {
    const m = buildModel(
      [span(1, "model.output", 0, 2), span(2, "tool.bash", 2, 4, { status: "failed" })],
      { startMs: 0, endMs: 4, segments: [{ spanId: 2, lane: "thread:m/s-1", kind: "tool.bash", cat: "tools", startMs: 2, endMs: 4 }], segmentsTruncated: false, totals: [], nothingRunningMs: 0, offPathMs: 0 },
      undefined,
      NO_NAMES,
      0,
    );
    const b = bars(m, 0, 2, 0, 1000, 100, (i) => i === 1);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ failed: true, onPath: true, lit: true, n: 2 });
  });

  it("finds a span that started before the view and is still running across it", () => {
    // A tool call (0-60 s) with a permission wait inside it (10-21 s), then the next message.
    const m = row([
      [0, 60_000, "tools"],
      [10_000, 21_000, "human"],
      [60_000, 70_000, "model"],
    ]);
    const inner = bars(m, 0, 3, 12_000, 20_000, 800, none);
    expect(inner).toHaveLength(2);
    expect(hit(inner, 400)?.cat).toBe(CAT_CODE.human);
    const after = bars(m, 0, 3, 30_000, 40_000, 800, none);
    expect(after.map((b) => b.cat)).toEqual([CAT_CODE.tools]);
  });
});

describe("hit", () => {
  it("takes the nearest bar within a little slack, and nothing in a real gap", () => {
    const m = row([
      [0, 100, "model"],
      [500, 510, "tools"],
    ]);
    const b = bars(m, 0, 2, 0, 1000, 100, none);
    expect(hit(b, 5)?.first).toBe(0);
    expect(hit(b, 51.5)?.first).toBe(1);
    expect(hit(b, 30)).toBeUndefined();
  });
});

describe("buildModel", () => {
  it("gives gaps a mark under their row and never a bar, and a lane with no spans its own row", () => {
    const coverage: Coverage = { complete: false, gaps: [{ why: "no_node_spans", lane: "thread:m/s-9", fromMs: 0, toMs: 50_000 }] };
    const m = buildModel([span(1, "gap", 0, 100_000), span(2, "tool.bash", 10_000, 20_000)], undefined, coverage, NO_NAMES, 100_000);
    expect(m.itemSpan.length).toBe(1);
    expect(m.spans[m.itemSpan[0] ?? -1]?.id).toBe(2);
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]?.gaps).toHaveLength(1);
    expect(m.rows[1]?.gaps).toEqual([[0, 50_000, "no_node_spans"]]);
    expect(m.rows[1]?.to).toBe(m.rows[1]?.from);
  });

  it("lays out an order: lead, agents, the PR with its checks under it, then the asks", () => {
    const { spans, path } = fixtureOrder();
    const m = buildModel(spans, path, undefined, fixtureNames(), 0);
    const kinds = m.rows.map((r) => r.kind);
    expect(kinds[0]).toBe("lead");
    expect(kinds.indexOf("change")).toBeLessThan(kinds.indexOf("check"));
    expect(kinds.lastIndexOf("check")).toBeLessThan(kinds.indexOf("asks"));
    expect(m.rows.filter((r) => r.kind === "check").map((r) => r.name)).toEqual(["lint", "build", "e2e (webkit)"]);
    expect(m.rows.find((r) => r.kind === "agent")?.taskId).toBe("T21");
    // Parallel calls are drawn as their group; envelopes and message parents are not drawn.
    for (let i = 0; i < m.itemSpan.length; i += 1) {
      const s = m.spans[m.itemSpan[i] ?? -1];
      expect(s?.kind).not.toBe("model.message");
      expect(m.parallel.has(s?.id ?? -1)).toBe(false);
    }
    expect(m.path.reduce((n, s) => n + (s.end - s.start), 0)).toBe(m.endMs - m.startMs);
  });

  it("keeps a 15k-span order inside the frame budget", () => {
    const { spans, path } = fixtureOrder(true);
    expect(spans.length).toBeGreaterThan(15_000);
    const t0 = performance.now();
    const m = buildModel(spans, path, undefined, fixtureNames(), 0);
    const built = performance.now() - t0;
    // A frame: every row's bars across a 1200 px track at the whole-order zoom.
    const t1 = performance.now();
    let drawn = 0;
    for (const r of m.rows) drawn += bars(m, r.from, r.to, m.startMs, m.endMs, 1200, none).length;
    const frame = performance.now() - t1;
    expect(drawn).toBeLessThan(m.rows.length * 1200);
    expect(built).toBeLessThan(500);
    expect(frame).toBeLessThan(16);
  });
});

describe("ticks", () => {
  it("land on round times", () => {
    const v0 = 10 * 3_600_000 + 7 * 60_000;
    const t = ticks(v0, v0 + 102 * 60_000);
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.length).toBeLessThanOrEqual(8);
    expect(t.every((x) => x % 900_000 === 0)).toBe(true);
    expect(clockMs(t[0] ?? 0)).toBe("10:15:00");
  });
});

describe("what is lit is what is listed", () => {
  it("lights a parallel call's group bar, and every lit id has a bar", () => {
    const { spans, path } = fixtureOrder();
    const m = buildModel(spans, path, undefined, fixtureNames(), 0);
    const tools = new Set(categoryKinds("tools"));
    const lit = barsFor(m, spans.filter((s) => tools.has(s.kind)).map((s) => s.id));
    const drawn = new Set(Array.from(m.itemSpan, (i) => m.spans[i]?.id));
    expect([...lit].every((id) => drawn.has(id))).toBe(true);
    const groups = spans.filter((s) => s.kind === "tools.parallel").map((s) => s.id);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((id) => lit.has(id))).toBe(true);
    // No parallel call is listed on its own: it shows (and lists) as its group.
    expect([...lit].some((id) => m.parallel.has(id))).toBe(false);
  });

  it("links a category's every kind, CI checks included", () => {
    expect(categoryKinds("pipeline")).toContain("ci.check");
    expect(categoryKinds("tools")).not.toContain("tools.parallel");
    expect(categoryKinds("model")).not.toContain("model.message");
  });
});
