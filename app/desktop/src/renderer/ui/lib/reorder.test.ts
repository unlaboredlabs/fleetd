// The reorder's arithmetic: where a lifted row drops, how far the rows it passes slide aside, and the run of its group.
import { describe, expect, it } from "vitest";
import { boundsOf, dropIndex, moved, shiftOf } from "./reorder";

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
