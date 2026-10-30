import { describe, expect, it } from "vitest";
import { REVEAL, revealOf } from "./reveal";

describe("revealOf", () => {
  it("follows a leftward drag up to the times' width", () => {
    expect(revealOf(0)).toBe(0);
    expect(revealOf(-30)).toBe(30);
    expect(revealOf(-REVEAL)).toBe(REVEAL);
  });

  it("stretches past it at a quarter of the pace", () => {
    expect(revealOf(-(REVEAL + 40))).toBe(REVEAL + 10);
  });

  it("shows nothing for a rightward drag", () => {
    expect(revealOf(50)).toBe(0);
  });
});
