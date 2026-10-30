import { describe, expect, it } from "vitest";
import { direct, type Step } from "./camera.ts";

const view = { width: 1400, height: 900 };
const o = { view, cap: 1.5, fade: 600 };
const box = (x: number, y: number, width = 80, height = 28) => ({ x, y, width, height });
// A navi-like scene: a sidebar click that changes the whole window, then a small button, in one 5 s take.
const steps: Step[] = [
  { kind: "click", at: 1700, until: 1700, box: box(10, 40, 200), effect: box(0, 0, 1400, 900) },
  { kind: "click", at: 3900, until: 3900, box: box(240, 560), effect: box(230, 470, 600, 160) },
];
const take = [1000, 6000] as const;
const ticks = Array.from({ length: Math.round(((take[1] - take[0]) * 60) / 1000) + 1 }, (_, i) => take[0] + (i * 1000) / 60);
const run = direct(steps, [take], o, ticks);
const at = (t: number) => {
  const n = ticks.findIndex((x) => x >= t);
  const d = run[n];
  if (d === undefined) throw new Error(`no frame at ${String(t)}`);
  return d;
};
const moves = run.slice(1).map((d, i) => {
  const p = run[i]?.pointer ?? d.pointer;
  return Math.hypot(d.pointer.x - p.x, d.pointer.y - p.y);
});

describe("direct", () => {
  it("opens and ends on the whole window, with the cursor where it started", () => {
    expect(at(take[0]).shot).toEqual({ x: 700, y: 450, zoom: 1 });
    const end = at(take[1] - o.fade);
    expect(end.shot.zoom).toBeCloseTo(1, 2);
    expect(end.pointer.x).toBeCloseTo(at(take[0]).pointer.x, 0);
    expect(end.pointer.y).toBeCloseTo(at(take[0]).pointer.y, 0);
    // Before the take it holds as the take opens, for the loop's fade.
    expect(direct(steps, [take], o, [0, take[0]])[0]).toEqual(at(take[0]));
  });

  it("lands the cursor on each click, and glides there without a jump", () => {
    for (const s of steps) {
      const p = at(s.at).pointer;
      expect(Math.hypot(p.x - (s.box.x + s.box.width / 2), p.y - (s.box.y + s.box.height / 2))).toBeLessThan(2);
    }
    expect(Math.max(...moves)).toBeLessThan(60);
    // Its speed changes a little from frame to frame.
    expect(Math.max(...moves.slice(1).map((m, i) => Math.abs(m - (moves[i] ?? m))))).toBeLessThan(6);
  });

  it("dips as it clicks and springs back", () => {
    const scales = ticks.filter((t) => t >= 3900 && t < 4200).map((t) => at(t).pointer.scale);
    expect(Math.min(...scales)).toBeLessThan(0.9);
    expect(Math.min(...scales)).toBeGreaterThan(0.8);
    expect(at(4200).pointer.scale).toBeCloseTo(1, 1);
  });

  it("frames a click with what it changed, never past the cap, and leaves a whole-window change unzoomed", () => {
    const zooms = run.map((d) => d.shot.zoom);
    expect(Math.max(...zooms)).toBeLessThanOrEqual(o.cap);
    expect(at(1700).shot.zoom).toBe(1);
    const send = at(3900).shot;
    expect(send.zoom).toBeGreaterThan(1.3);
    expect(send.x - view.width / send.zoom / 2).toBeLessThanOrEqual(230);
    // The camera is on its way before the cursor lands, and moves a little at a time.
    expect(at(3500).shot.zoom).toBeGreaterThan(1.05);
    expect(Math.max(...zooms.slice(1).map((z, i) => Math.abs(z - (zooms[i] ?? z))))).toBeLessThan(0.02);
  });

  it("opens a take after a cut with the cursor where the clicks between the takes left it, at rest", () => {
    // Two takes; the second's click happens in the gap, off screen.
    const takes = [
      [1000, 3000],
      [5000, 7000],
    ] as const;
    const gap: Step[] = [{ kind: "click", at: 1500, until: 1500, box: box(1100, 60) }, { kind: "click", at: 4700, until: 4700, box: box(200, 700) }];
    const times = takes.flatMap(([from, to]) => Array.from({ length: Math.round(((to - from) * 60) / 1000) + 1 }, (_, i) => from + (i * 1000) / 60));
    const frames = direct(gap, takes, o, times);
    const opens = frames[times.indexOf(takes[1][0])]?.pointer;
    expect(opens?.x).toBeCloseTo(240, 0);
    expect(opens?.y).toBeCloseTo(714, 0);
    // Within each take, never a jump.
    for (const [from, to] of takes) {
      const span = frames.filter((_, i) => (times[i] ?? 0) >= from && (times[i] ?? 0) <= to);
      const most = Math.max(...span.slice(1).map((d, i) => Math.hypot(d.pointer.x - (span[i]?.pointer.x ?? 0), d.pointer.y - (span[i]?.pointer.y ?? 0))));
      expect(most).toBeLessThan(60);
    }
  });

  it("keeps a step's camera where it is with zoom: false", () => {
    const still = direct([{ ...(steps[1] as Step), zoom: false }], [take], o, ticks);
    expect(still.every((d) => d.shot.zoom === 1)).toBe(true);
  });
});
