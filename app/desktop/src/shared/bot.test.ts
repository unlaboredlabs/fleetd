import { describe, expect, it } from "vitest";
import { advanceRig, BOT_STATES, DIM, frameOf, GLOW, isAwake, LIFT, LOW, MOODS, moment, newRig, PAINT, setRigState, STEP, UP, type BotState, type Rig } from "./bot";

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
  it("paints one palette, light and dark, as hex", () => {
    for (const p of [PAINT.light, PAINT.dark]) for (const v of Object.values(p)) if (typeof v === "string") expect(v).toMatch(/^#[0-9a-f]{6}$/);
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

  it("arrives settled in its state's pose", () => {
    const r = newRig("error", 36, 3);
    expect(r.x[DIM]).toBe(1);
    expect(r.x[UP]).toBeCloseTo(MOODS.error.pose[UP] ?? 0, 1);
    expect(newRig("done", 36, 3).x[LOW]).toBeCloseTo(0.62, 1);
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
    for (let i = 0; i < x.length; i++) expect(r.x[i]).toBeCloseTo(x[i] ?? 0, 3);
  });

  it("sizes itself for lists: larger eyes, half the body's motion, no glow, a closed eye never a hole", () => {
    const small = newRig("needs", 20, 1);
    const large = newRig("needs", 64, 1);
    expect(small.eyeK).toBeCloseTo(1.2);
    expect(large.eyeK).toBe(1);
    expect(small.B).toBeLessThan(0.6);
    expect(frameOf(small).glow).toBe(0);
    expect(frameOf(large).glow).toBeGreaterThan(0.9);
    // Shut: at 20 px its line is still 1 px thick (5 units of the box).
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
