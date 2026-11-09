import { describe, expect, it } from "vitest";
import { springCurve } from "./spring";

const stops = (ease: string): number[] => ease.slice("linear(".length, -1).split(", ").map(Number);

describe("a spring as a CSS curve", () => {
  it("samples a critically damped spring from rest to its mark without passing it", () => {
    const { ms, ease } = springCurve({ stiffness: 500, damping: 44.7, mass: 1 });
    expect(ms).toBe(450);
    const xs = stops(ease);
    expect(xs).toHaveLength(64);
    expect(xs[0]).toBe(0);
    expect(xs.at(-1)).toBe(1);
    expect(xs.every((x, n) => n === 0 || x >= (xs[n - 1] ?? 0))).toBe(true);
    expect(Math.max(...xs)).toBe(1);
  });

  it("settles a stiffer spring sooner, and hands back the same curve for the same spring", () => {
    const send = springCurve({ stiffness: 650, damping: 51, mass: 1 });
    expect(send.ms).toBe(401);
    expect(springCurve({ stiffness: 700, damping: 53, mass: 1 }).ms).toBe(390);
    expect(springCurve({ stiffness: 650, damping: 51, mass: 1 })).toBe(send);
  });
});
