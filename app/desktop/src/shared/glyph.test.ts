import { describe, expect, it } from "vitest";
import { cellFrames, CELLS, GRAIN, GRAIN_BEATS, LEVELS, litOn, phaseOf, RING, SHAPES, stillOf } from "./glyph";

describe("the state glyph's frames", () => {
  it("lights working's grain where its pattern has a mark, each cell dim between", () => {
    for (const phase of [0, 1, 2, 3])
      for (const cell of CELLS) {
        const marks = GRAIN[phase]?.[cell] ?? "";
        expect(marks).toHaveLength(GRAIN_BEATS);
        expect(cellFrames("working", phase, cell)).toEqual(Array.from({ length: GRAIN_BEATS }, (_, b) => (marks[b] === "#" ? LEVELS.working.on : LEVELS.working.dim)));
      }
  });

  it("walks thinking round the ring a beat a step, a trail behind it and the centre dark", () => {
    const lit = (beat: number) => CELLS.filter((c) => litOn("thinking", 0, c, beat) === "on");
    expect(Array.from({ length: RING.length }, (_, b) => lit(b)[0])).toEqual([...RING]);
    expect(cellFrames("thinking", 0, 1).slice(0, 3)).toEqual([LEVELS.thinking.dim, LEVELS.thinking.on, LEVELS.thinking.trail]);
    expect(new Set(cellFrames("thinking", 2, 4))).toEqual(new Set([LEVELS.thinking.centre]));
    // A phase starts it two cells further on.
    expect(litOn("thinking", 1, RING[2], 0)).toBe("on");
  });

  it("holds still shapes off the beat", () => {
    expect(stillOf("working")).toEqual([0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3]);
    expect(stillOf("thinking")).toEqual([1, 1, 1, 0.18, 0, 0.18, 0.18, 0.18, 0.18]);
    expect(SHAPES.done).toEqual([6, 7, 8]);
  });

  it("seeds a phase from 0 to 3, the same for the same seed", () => {
    expect(phaseOf("T1")).toBe(phaseOf("T1"));
    expect(new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => phaseOf(s))).size).toBeGreaterThan(1);
    expect(phaseOf()).toBe(3);
  });
});
