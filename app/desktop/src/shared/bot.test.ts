import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advanceRig, bodyOf, BOT_STATES, CROP, DIM, drawnAt, frameOf, GLOW, isAwake, LIFT, LOW, MOODS, moment, newRig, BOT_COLORS, BOT_PAINT, paintOf, setRigState, STEP, traceEyes, UP, type BotState, type Rig } from "./bot";

/** WCAG's contrast ratio of two "#rrggbb". */
const contrast = (a: string, b: string): number => {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const run = (r: Rig, seconds: number, calm = false, each?: (r: Rig) => void) => {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    advanceRig(r, STEP, calm);
    each?.(r);
  }
};

/** The largest change of any channel in one step, over `seconds`. */
const largestStep = (r: Rig, seconds: number): number => {
  let most = 0;
  let before = r.x.slice();
  run(r, seconds, false, (x) => {
    for (let i = 0; i < x.x.length; i++) most = Math.max(most, Math.abs((x.x[i] ?? 0) - (before[i] ?? 0)));
    before = x.x.slice();
  });
  return most;
};

describe("the bot", () => {
  it("paints each color, light and dark, as hex, its eyes legible and its body clear of the ground", () => {
    expect(Object.keys(BOT_PAINT)).toEqual([...BOT_COLORS]);
    for (const c of BOT_COLORS) {
      for (const [p, ground] of [[BOT_PAINT[c].light, "#ffffff"], [BOT_PAINT[c].dark, "#1c1c1b"]] as const) {
        for (const v of Object.values(p)) if (typeof v === "string") expect(v).toMatch(/^#[0-9a-f]{6}$/);
        expect(contrast(p.body, p.eye), `${c}'s eyes`).toBeGreaterThan(3.3);
        expect(contrast(p.body, ground), `${c} on its ground`).toBeGreaterThan(1.9);
      }
    }
  });

  it("paints slate for no color and for one it doesn't know", () => {
    expect(paintOf(undefined, false)).toBe(BOT_PAINT.slate.light);
    expect(paintOf("neon", true)).toBe(BOT_PAINT.slate.dark);
    expect(paintOf("sage", true)).toBe(BOT_PAINT.sage.dark);
  });

  it("offers the contracts' colors, in their order", () => {
    const schema = JSON.parse(readFileSync(join(__dirname, "contracts/schema/ProjectSummary.json"), "utf8")) as { $defs: { BotColor: { enum: string[] } } };
    expect([...BOT_COLORS]).toEqual(schema.$defs.BotColor.enum);
  });

  it("draws every state as a body and two closed eyes", () => {
    for (const s of BOT_STATES) {
      for (const size of [20, 36, 88]) {
        const f = frameOf(newRig(s, size, 1));
        expect(f.body.every(Number.isFinite)).toBe(true);
        for (const d of f.eyes) expect(d).toMatch(/^M[-\d.]+ [-\d.]+(C[-\d. ]+)+Z$/);
      }
    }
  });

  it("traces on a canvas the same eyes and body as its SVG frame", () => {
    const r = newRig("needs", 45, 5);
    run(r, 1.3);
    const f = frameOf(r);
    // A pen that writes what it's given as path data, to frameOf's 2 decimals.
    let d = "";
    const n = (v: number) => String(Math.round(v * 100) / 100);
    traceEyes(r, { moveTo: (x, y) => (d += `M${n(x)} ${n(y)}`), bezierCurveTo: (...v) => (d += `C${v.map(n).join(" ")}`), closePath: () => (d += "Z|") }, []);
    expect(d).toBe(`${f.eyes[0]}|${f.eyes[1]}|`);
    expect(bodyOf(r)).toEqual(f.body);
  });

  it("arrives settled in its state's pose", () => {
    const r = newRig("error", 36, 3);
    expect(r.x[DIM]).toBe(1);
    expect(r.x[UP]).toBeCloseTo(MOODS.error.pose[UP] ?? 0, 1);
    expect(newRig("done", 36, 3).x[LOW]).toBeCloseTo(MOODS.done.pose[LOW] ?? 0, 1);
    expect(newRig("needs", 36, 3).x[GLOW]).toBe(1);
  });

  it("blends a state change from where it is: no channel jumps, and its clock runs on", () => {
    const r = newRig("idle", 88, 5);
    run(r, 2.3);
    // A steady step's size, then switches mid-motion, one after another.
    const steady = largestStep(r, 2);
    const order: BotState[] = ["working", "needs", "error", "thinking", "done", "idle", "needs"];
    for (const s of order) {
      const t = r.t;
      const x = r.x.slice();
      setRigState(r, s, false);
      // Nothing moves in the switch itself.
      expect(r.x).toEqual(x);
      expect(r.t).toBe(t);
      expect(largestStep(r, 0.4 + (order.indexOf(s) % 3) * 0.3)).toBeLessThan(Math.max(steady, 0.02) * 6);
    }
    // And it gets there.
    run(r, 4);
    expect(r.x[GLOW]).toBeGreaterThan(0.85);
  });

  it("nudges the body's speed on arriving, not its place", () => {
    const r = newRig("idle", 88, 9);
    const lift = r.x[LIFT] ?? 0;
    setRigState(r, "needs", false);
    expect(r.x[LIFT]).toBe(lift);
    expect(r.v[LIFT]).toBeGreaterThan(20);
  });

  it("with reduced motion, settles each state into a still pose in well under a second, without overshoot", () => {
    const r = newRig("idle", 36, 2);
    setRigState(r, "error", true);
    let most = 0;
    run(r, 0.6, true, (x) => (most = Math.max(most, x.x[DIM] ?? 0)));
    expect(most).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.x[DIM]).toBeGreaterThan(0.99);
    const x = r.x.slice();
    expect(isAwake(r, true)).toBe(false);
    run(r, 3, true);
    for (let i = 0; i < x.length; i++) expect(r.x[i]).toBeCloseTo(x[i] ?? 0, 2);
  });

  it("sizes itself for lists by the size it's drawn at: larger eyes, 0.8 of the body's motion, no glow, a closed eye never a hole", () => {
    // Its box shows only the body, so a 16 px box draws it as a 20 px circle would, and a 36 px one above the line.
    expect(drawnAt(16)).toBe(20);
    expect(drawnAt(CROP.w)).toBe(100);
    const small = newRig("needs", drawnAt(16), 1);
    const large = newRig("needs", drawnAt(64), 1);
    expect(small.eyeK).toBeCloseTo(1.2);
    expect(large.eyeK).toBe(1);
    expect(small.B).toBeCloseTo(0.8);
    expect(frameOf(small).glow).toBe(0);
    expect(frameOf(large).glow).toBeGreaterThan(0.9);
    expect(newRig("needs", drawnAt(36), 1).glow).toBe(true);
    expect(newRig("needs", drawnAt(28), 1).glow).toBe(false);
    // Shut: in a 16 px box its line is still 1 px thick (5 units of the drawing).
    small.bk = 1;
    const ys = [...frameOf(small).eyes[0].matchAll(/ ([-\d.]+)(?=C|Z)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(4.5);
  });

  it("takes turns idle in a list: asleep between moments, awake in a live state or on its own", () => {
    const row = newRig("idle", 36, 4);
    expect(isAwake(row, false)).toBe(false);
    moment(row);
    expect(isAwake(row, false)).toBe(true);
    run(row, 4);
    expect(isAwake(row, false)).toBe(false);
    setRigState(row, "working", false);
    run(row, 5);
    expect(isAwake(row, false)).toBe(true);
    setRigState(row, "idle", false);
    run(row, 3);
    expect(isAwake(row, false)).toBe(false);
    expect(isAwake(newRig("idle", 88, 4), false)).toBe(true);
  });

  it("blinks on its own when alive, and a done bot's smiling eyes don't", () => {
    const shut = (s: BotState) => {
      const r = newRig(s, 88, 11);
      let n = 0;
      let was = false;
      run(r, 30, false, (x) => {
        const now = x.bk > 0.5;
        if (now && !was) n++;
        was = now;
      });
      return n;
    };
    expect(shut("idle")).toBeGreaterThanOrEqual(4);
    expect(shut("done")).toBe(0);
  });
});
