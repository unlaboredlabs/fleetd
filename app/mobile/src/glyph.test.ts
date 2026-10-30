import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BEAT_MS as DESKTOP_BEAT_MS, BEATS } from "../../desktop/src/renderer/ui/lib/beat";
import { BEAT_MS, glyphCells, glyphColor, LOOP_BEATS } from "./glyph";

// The desktop's glyph draws its levels in CSS: read them from there, so a change on either side fails here.
const css = readFileSync(new URL("../../desktop/src/renderer/ui/primitives/StateGlyph.module.css", import.meta.url), "utf8");
const level = (rule: string): number => Number(new RegExp(`${rule.replace(/[[\]().^*+]/gu, "\\$&")}\\s*\\{\\s*opacity: ([\\d.]+);`, "u").exec(css)?.[1]);
// And its grain from its source, as written there: `#` lit, `.` dim.
const source = readFileSync(new URL("../../desktop/src/shared/glyph.ts", import.meta.url), "utf8");
const grain = [...source.matchAll(/"([#.]{24})"/gu)].map((m) => m[1] ?? "");

describe("the phone's state glyph", () => {
  it("steps on the desktop's beat, through the desktop's loop", () => {
    expect(BEAT_MS).toBe(DESKTOP_BEAT_MS);
    expect(LOOP_BEATS).toBe(BEATS);
  });

  it("draws working's grain from the desktop's frames, at its CSS's levels", () => {
    const dim = level('.glyph[data-state="working"] .cell');
    const on = level(':root[data-beat] .glyph[data-state="working"] .cell[data-lit]');
    expect([dim, on]).toEqual([0.3, 1]);
    expect(grain).toHaveLength(4 * 9);
    for (const phase of [0, 1, 2, 3]) {
      const cells = glyphCells("working", phase, true);
      cells.forEach((frames, cell) => {
        const marks = grain[phase * 9 + cell] ?? "";
        expect(frames).toEqual(Array.from({ length: LOOP_BEATS }, (_, b) => (marks[b] === "#" ? on : dim)));
      });
    }
  });

  it("walks thinking's lit cell round the ring a beat a step, its trail a shade behind, the centre dark", () => {
    const on = level(':root[data-beat] .glyph[data-state="thinking"] .cell[data-lit="on"]');
    const trail = level(':root[data-beat] .glyph[data-state="thinking"] .cell[data-lit="trail"]');
    const dim = level('.glyph[data-state="thinking"] .cell');
    const cells = glyphCells("thinking", 0, true) as number[][];
    const litAt = (beat: number) => cells.findIndex((f) => f[beat] === on);
    // Clockwise from the top-left, 960 ms round.
    expect(Array.from({ length: 8 }, (_, b) => litAt(b))).toEqual([0, 1, 2, 5, 8, 7, 6, 3]);
    expect(Array.from({ length: 8 }, (_, b) => litAt(b + 8))).toEqual([0, 1, 2, 5, 8, 7, 6, 3]);
    expect(cells[0]?.slice(0, 3)).toEqual([on, trail, dim]);
    expect(new Set(cells[4])).toEqual(new Set([0]));
    // A phase starts it two cells further on, so rows in a list step out of turn.
    expect((glyphCells("thinking", 1, true) as number[][]).findIndex((f) => f[0] === on)).toBe(2);
  });

  it("holds the desktop's still shapes off screen or with Reduce Motion", () => {
    expect(glyphCells("working", 2, false)).toEqual([0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3]);
    expect(glyphCells("thinking", 2, false)).toEqual([1, 1, 1, 0.18, 0, 0.18, 0.18, 0.18, 0.18]);
    expect(glyphCells("done", 0, true)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1]);
  });

  it("takes the desktop's colors", () => {
    const t = { success: "green", warning: "amber", danger: "red", secondary: "grey", tertiary: "faint" };
    expect(["thinking", "working", "done", "waiting", "failed"].map((s) => glyphColor(t, s as "done"))).toEqual(["green", "green", "green", "amber", "red"]);
  });
});
