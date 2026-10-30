// The reorder's arithmetic: where a lifted row drops, how far the rows it passes slide aside, and the run of its group.
import { describe, expect, it } from "vitest";
import { boundsOf, dropIndex, EDGE_PX, edgeSpeed, MAX_SCROLL_PX, moved, shiftOf } from "./reorder";

describe("a lifted row", () => {
  // Four 28 px rows: centres at 14, 42, 70, 98.
  const centres = [14, 42, 70, 98];

  it("drops past every row whose centre it reached", () => {
    expect(dropIndex(centres, 0, 14)).toBe(0);
    expect(dropIndex(centres, 0, 43)).toBe(1);
    expect(dropIndex(centres, 0, 99)).toBe(3);
    expect(dropIndex(centres, 3, 41)).toBe(1);
    expect(dropIndex(centres, 3, 0)).toBe(0);
    // Held at either end, its centre on the end row's: that end.
    expect(dropIndex(centres, 0, 98)).toBe(3);
    expect(dropIndex(centres, 3, 14)).toBe(0);
    expect(dropIndex(centres, 2, 70)).toBe(2);
  });

  it("opens its gap: the rows it passed slide one row towards where it came from", () => {
    // Row 0 over 2: rows 1 and 2 go up.
    expect([0, 1, 2, 3].map((i) => shiftOf(i, 0, 2, 28))).toEqual([0, -28, -28, 0]);
    // Row 3 over 1: rows 1 and 2 go down.
    expect([0, 1, 2, 3].map((i) => shiftOf(i, 3, 1, 28))).toEqual([0, 28, 28, 0]);
    // Over its own place: nothing moves.
    expect([0, 1, 2, 3].map((i) => shiftOf(i, 2, 2, 28))).toEqual([0, 0, 0, 0]);
  });

  it("takes its new place in the list", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("stays in its group's run", () => {
    const hub = (k: string) => k.split(":")[0] ?? "";
    const keys = ["one:a", "one:b", "two:c", "two:d", "two:e"];
    expect(boundsOf(keys, 0, hub)).toEqual([0, 1]);
    expect(boundsOf(keys, 3, hub)).toEqual([2, 4]);
    expect(boundsOf(keys, 3, undefined)).toEqual([0, 4]);
  });
});

describe("near a scrolling list's edge", () => {
  // A list from 100 to 600 on screen.
  const at = (y: number) => edgeSpeed(y, 100, 600);

  it("doesn't scroll away from its edges", () => {
    expect(at(350)).toBe(0);
    expect(at(100 + EDGE_PX)).toBe(0);
    expect(at(600 - EDGE_PX)).toBe(0);
  });

  it("scrolls faster the nearer the pointer is to an edge, easing in", () => {
    const down = [552, 564, 576, 588, 600].map(at);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeGreaterThan(down[i - 1] ?? 0);
    // Eased: a quarter of the way into the band is well under a quarter of the speed.
    expect(at(600 - EDGE_PX * 0.75)).toBeLessThan(MAX_SCROLL_PX / 4);
    expect(at(600)).toBe(MAX_SCROLL_PX);
    // Past the edge, as fast as at it.
    expect(at(700)).toBe(MAX_SCROLL_PX);
  });

  it("scrolls up near the top, as fast as down near the bottom", () => {
    expect(at(110)).toBeLessThan(0);
    expect(at(110)).toBe(-at(590));
    expect(at(0)).toBe(-MAX_SCROLL_PX);
  });

  it("keeps its bands to a third of a short list", () => {
    expect(edgeSpeed(50, 0, 90)).toBe(0);
    expect(edgeSpeed(85, 0, 90)).toBeGreaterThan(0);
  });
});
