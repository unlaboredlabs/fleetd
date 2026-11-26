// A table's grid as a spreadsheet lays it out and selects in it: column letters, each column's width from its
// longest cells, whether the first row reads as a header, a selection's range, its cells as text, and the count, sum
// and average a spreadsheet shows for it. Pure.
import { toTsv } from "./csv";

export type Cell = readonly [row: number, col: number];
export interface Selection {
  readonly anchor: Cell;
  readonly focus: Cell;
}

/** A column's letters: 0 is A, 26 AA. */
export const letters = (col: number): string => {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export const columnsOf = (rows: readonly (readonly string[])[]): number => rows.reduce((n, r) => Math.max(n, r.length), 0);

/** Each column's width in px, from the longest of its first rows' cells (at most 48 characters' worth). */
export const widthsOf = (rows: readonly (readonly string[])[], columns: number, sample = 300): number[] => {
  const chars = new Array<number>(columns).fill(0);
  for (const r of rows.slice(0, sample)) r.forEach((v, c) => (chars[c] = Math.max(chars[c] ?? 0, Math.min(48, v.length))));
  return chars.map((n) => Math.round(Math.min(360, Math.max(64, n * 7.2 + 20))));
};

const numeric = (v: string) => v.trim() !== "" && Number.isFinite(Number(v.replaceAll(",", "")));

/** Whether the first row names the columns: all words, none a number, over rows that hold some numbers or more text. */
export const hasHeader = (rows: readonly (readonly string[])[]): boolean => {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length === 0 || first.length === 0) return false;
  if (!first.every((v) => v.trim() !== "" && !numeric(v))) return false;
  return rest.slice(0, 50).some((r) => r.some(numeric)) || new Set(first).size === first.length;
};

export const bounds = (s: Selection) => ({
  top: Math.min(s.anchor[0], s.focus[0]),
  bottom: Math.max(s.anchor[0], s.focus[0]),
  left: Math.min(s.anchor[1], s.focus[1]),
  right: Math.max(s.anchor[1], s.focus[1]),
});

export const isIn = (s: Selection | null, r: number, c: number): boolean => {
  if (s === null) return false;
  const b = bounds(s);
  return r >= b.top && r <= b.bottom && c >= b.left && c <= b.right;
};

/** The range as a spreadsheet names it: `B2`, or `B2:D9`. Rows count from 1. */
export const rangeName = (s: Selection): string => {
  const b = bounds(s);
  const from = `${letters(b.left)}${String(b.top + 1)}`;
  const to = `${letters(b.right)}${String(b.bottom + 1)}`;
  return from === to ? from : `${from}:${to}`;
};

/** The selected cells as text to paste into a spreadsheet. */
export const selectedText = (rows: readonly (readonly string[])[], s: Selection): string => {
  const b = bounds(s);
  const out: string[][] = [];
  for (let r = b.top; r <= Math.min(b.bottom, rows.length - 1); r++) {
    const row = rows[r] ?? [];
    out.push(Array.from({ length: b.right - b.left + 1 }, (_, i) => row[b.left + i] ?? ""));
  }
  return toTsv(out);
};

/** What the selection holds, as a spreadsheet's status bar says it: its cells, and their sum and average when some are numbers. */
export const summary = (rows: readonly (readonly string[])[], s: Selection): { readonly cells: number; readonly sum?: number; readonly average?: number } => {
  const b = bounds(s);
  const cells = (Math.min(b.bottom, rows.length - 1) - b.top + 1) * (b.right - b.left + 1);
  let sum = 0;
  let n = 0;
  for (let r = b.top; r <= Math.min(b.bottom, rows.length - 1); r++) {
    const row = rows[r] ?? [];
    for (let c = b.left; c <= b.right; c++) {
      const v = row[c] ?? "";
      if (numeric(v)) {
        sum += Number(v.replaceAll(",", ""));
        n++;
      }
    }
  }
  return n === 0 || cells < 2 ? { cells } : { cells, sum, average: sum / n };
};

/** The cell a key moves to from `at`, kept in the grid. */
export const step = (at: Cell, key: string, rows: number, columns: number): Cell | undefined => {
  const [r, c] = at;
  const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, v));
  switch (key) {
    case "ArrowUp":
      return [clamp(r - 1, rows), c];
    case "ArrowDown":
      return [clamp(r + 1, rows), c];
    case "ArrowLeft":
      return [r, clamp(c - 1, columns)];
    case "ArrowRight":
      return [r, clamp(c + 1, columns)];
    default:
      return undefined;
  }
};
