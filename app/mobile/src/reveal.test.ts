import { describe, expect, it } from "vitest";
import { revealOf, revealWidth, TIME_SCALE } from "./reveal";

describe("revealWidth", () => {
  it("fits the longest time with its padding at the default text size", () => {
    expect(revealWidth(1)).toBe(68);
  });

  it("grows with Dynamic Type as far as the time's text does, and no further", () => {
    expect(revealWidth(1.1)).toBe(74);
    expect(revealWidth(TIME_SCALE)).toBe(80);
    expect(revealWidth(2)).toBe(revealWidth(TIME_SCALE));
  });

  it("narrows for smaller text", () => {
    expect(revealWidth(0.85)).toBe(60);
  });
});

describe("revealOf", () => {
  it("starts from where the drag took hold, without a jump", () => {
    expect(revealOf(-10, -10, 68)).toBe(0);
    expect(revealOf(-40, -10, 68)).toBe(30);
  });

  it("follows up to the column's width, then stretches at a quarter of the pace", () => {
    expect(revealOf(-78, -10, 68)).toBe(68);
    expect(revealOf(-118, -10, 68)).toBe(78);
  });

  it("shows nothing for a drag back to the right", () => {
    expect(revealOf(20, -10, 68)).toBe(0);
  });
});
