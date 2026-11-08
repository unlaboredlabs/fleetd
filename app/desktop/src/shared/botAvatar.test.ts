import { describe, expect, it } from "vitest";
import { BLINK, blinks, colorsOf, drawnFace, ICON_COLORS, ICON_FACES, Life, listMoment, motionAt, Plan, pose, poseParts, random, settles, SPRINGS, step, STILL } from "./botAvatar";

describe("the built-in avatar", () => {
  it("draws every face, with a shape for each of its parts", () => {
    for (const f of ICON_FACES) {
      const drawn = drawnFace(f.id);
      expect(drawn.length).toBe(f.parts.length);
      for (const d of drawn) expect(d.ellipse !== undefined || /^M[-\d.]+ [-\d.]+[QA].*Z$/.test(d.path ?? "")).toBe(true);
    }
    // A face from a newer hub draws as Mo.
    expect(drawnFace("blob")).toEqual(drawnFace("mo"));
  });

  it("blinks only the eyes that are open", () => {
    expect(ICON_FACES.filter((f) => !blinks(f.id)).map((f) => f.id)).toEqual(["nap", "joy"]);
    expect(drawnFace("wink").map((d) => d.blink !== undefined)).toEqual([true, false]);
    expect(drawnFace("huh").map((d) => d.blink !== undefined)).toEqual([true, true]);
  });

  it("paints each color as hex, light and dark, and an unknown one as Graphite", () => {
    for (const c of ICON_COLORS) for (const dark of [false, true]) expect(Object.values(colorsOf(c.id, dark)).filter((v) => typeof v === "string").every((v) => /^#[0-9a-f]{6}$/.test(v))).toBe(true);
    expect(colorsOf("teal", false).field).not.toBe(colorsOf("rose", false).field);
    expect(colorsOf("violet", true)).toEqual(colorsOf("graphite", true));
  });

  it("closes a lid in about 70 ms and opens it in about 170, as springs", () => {
    const { lidClose, lidOpen } = SPRINGS;
    expect(step(lidClose.stiffness, lidClose.damping, 0.07)).toBeGreaterThan(0.8);
    expect(step(lidOpen.stiffness, lidOpen.damping, 0.17)).toBeGreaterThan(0.9);
    expect(step(lidOpen.stiffness, lidOpen.damping, 0.08)).toBeLessThan(0.75);
    expect(settles(SPRINGS.breath)).toBeGreaterThan(3);
  });

  it("stands still at rest, and a blink shuts it and opens it again", () => {
    const parts = poseParts(drawnFace("mo"));
    const plan = new Plan();
    plan.blink(1);
    const at = (t: number) => motionAt(plan.flat, t);
    expect(at(0.5)).toEqual(STILL);
    expect(at(1.075)[BLINK]).toBeGreaterThan(0.85);
    expect(at(1.6)[BLINK]).toBeLessThan(0.01);
    // Settled, its moves fold away and the pose is the still one.
    plan.settle(3);
    expect(plan.flat).toEqual([0, 0, 0, 0, 0]);
    expect(pose(parts, at(3))).toEqual(pose(parts, STILL));
  });

  it("gives a face that can't blink a glance instead", () => {
    const plan = new Plan();
    listMoment(plan, random(1), 0, false);
    const moves = plan.flat.slice(5);
    const channels = new Set(moves.filter((_, i) => i % 5 === 0));
    expect(channels.has(BLINK)).toBe(false);
    expect(channels.size).toBe(3);
  });

  it("lives a large avatar's own life: blinks every few seconds and a slow breath", () => {
    const plan = new Plan();
    new Life(plan, 7, 0, true).ahead(30);
    const moves = plan.flat.slice(5);
    const starts = (ch: number, d: number) => moves.flatMap((v, i) => (i % 5 === 0 && v === ch && moves[i + 2] === d ? [moves[i + 1] ?? 0] : []));
    const closes = starts(BLINK, 1);
    expect(closes.length).toBeGreaterThanOrEqual(5);
    expect(closes.length).toBeLessThanOrEqual(14);
    expect(starts(4, 1).length + starts(4, -1).length).toBeGreaterThan(8);
  });
});
