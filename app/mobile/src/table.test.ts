import { describe, expect, it } from "vitest";
import { parseInline } from "./markdown";
import { columnWidths, isNumeric, longestWord, MAX_COLUMN, MIN_COLUMN, SCROLL_COLUMN } from "./table";

const sum = (ws: readonly number[], gap: number) => ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);

describe("columnWidths", () => {
  it("keeps each column as wide as its widest cell when the table fits", () => {
    expect(columnWidths([{ natural: 60.4, word: 30, numeric: false }, { natural: 40, word: 40, numeric: true }], 200, 12)).toEqual({ widths: [61, 40], scrolls: false });
  });

  it("wraps long cells at the cap, giving the room left to the columns that wrap", () => {
    const { widths, scrolls } = columnWidths([{ natural: 400, word: 60, numeric: false }, { natural: 50, word: 50, numeric: true }], 300, 12);
    expect(scrolls).toBe(false);
    expect(widths[1]).toBe(50);
    expect(widths[0]).toBeGreaterThan(MAX_COLUMN);
    expect(sum(widths, 12)).toBeLessThanOrEqual(300);
  });

  it("shrinks wordy columns toward their longest word to fit, never numbers", () => {
    const columns = [
      { natural: 175, word: 50, numeric: false },
      { natural: 90, word: 52, numeric: false },
      { natural: 40, word: 30, numeric: true },
    ];
    const { widths, scrolls } = columnWidths(columns, 260, 12);
    expect(scrolls).toBe(false);
    expect(widths[2]).toBe(40);
    expect(widths[0]).toBeGreaterThanOrEqual(MIN_COLUMN);
    expect(widths[1]).toBeGreaterThanOrEqual(MIN_COLUMN);
    expect(sum(widths, 12)).toBeLessThanOrEqual(260);
    // The longer column gives more.
    expect(175 - (widths[0] ?? 0)).toBeGreaterThan(90 - (widths[1] ?? 0));
  });

  it("scrolls a table too wide even at its longest words, at comfortable widths", () => {
    const columns = Array.from({ length: 6 }, () => ({ natural: 180, word: 70, numeric: false }));
    const { widths, scrolls } = columnWidths(columns, 280, 12);
    expect(scrolls).toBe(true);
    expect(widths).toEqual(Array.from({ length: 6 }, () => SCROLL_COLUMN));
  });

  it("caps a column's floor at a very long word, which then breaks", () => {
    const { widths } = columnWidths([{ natural: 600, word: 600, numeric: false }, { natural: 600, word: 600, numeric: false }], 300, 12);
    expect(widths).toEqual([MAX_COLUMN, MAX_COLUMN]);
  });
});

describe("isNumeric", () => {
  it("reads numbers with units, and empty cells", () => {
    expect(isNumeric(["0.9 s", "1,954", "", "12%"].map(parseInline))).toBe(true);
    expect(isNumeric(["0.9 s", "1,954 events/s"].map(parseInline))).toBe(false);
    expect(isNumeric(["", ""].map(parseInline))).toBe(false);
  });
});

describe("longestWord", () => {
  it("counts code wider, and whole", () => {
    expect(longestWord(["Agent startup", "`fleetd version`"].map(parseInline))).toEqual({ text: "fleetd version", code: true });
    expect(longestWord([parseInline("**throughput** x")])).toEqual({ text: "throughput", code: false });
  });
});
