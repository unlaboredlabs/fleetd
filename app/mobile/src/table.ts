// A table's columns in a bubble, as a browser's auto table layout lays them out (the desktop's table block): each as
// wide as its widest cell when the table fits; else long cells wrap, columns shrinking toward their longest word; and a
// table that still doesn't fit scrolls sideways at comfortable widths. Numbers never wrap. Pure, so it is unit-tested;
// ui/Markdown's Grid measures the cells and draws them.
import { plainText, type Inline } from "./markdown";

/** A column's cells as measured: the widest one on one line, its longest word, and whether it holds numbers. */
export interface Measured {
  readonly natural: number;
  readonly word: number;
  readonly numeric: boolean;
}

/** The narrowest a column of words gets, and the widest before its cells wrap. */
export const MIN_COLUMN = 56;
export const MAX_COLUMN = 200;
/** A column's widest when the table scrolls anyway: wider only wraps less, and costs more scrolling. */
export const SCROLL_COLUMN = 140;

// The desktop's (app/desktop/.../blocks/Table.tsx): "0.9 s", "1,954", "12%", "-3.5 MB".
const NUMBER = /^[−-]?[\d.,]+\s?(%|[a-zA-Z]{0,3})$/u;

/** A column of numbers: each cell a number or empty, at least one cell. */
export const isNumeric = (cells: ReadonlyArray<readonly Inline[]>): boolean => {
  const texts = cells.map((c) => plainText(c).trim());
  return texts.length > 0 && texts.every((s) => s === "" || NUMBER.test(s)) && texts.some((s) => s !== "");
};

/** A word of a cell, and how it draws: code in monospace, a header in bold. */
export interface Word {
  readonly text: string;
  readonly code: boolean;
}

// Code is one word: a cell keeps `fleetd version` on one line, as a command reads.
const words = (nodes: readonly Inline[]): Word[] =>
  nodes.flatMap((n) => (n.t === "code" ? [{ text: n.text, code: true }] : n.t === "text" ? n.text.split(/\s+/u).filter((w) => w !== "").map((text) => ({ text, code: false })) : words(n.children)));

/** The widest-looking word in a column's cells, to measure: monospace counts wider. */
export const longestWord = (cells: ReadonlyArray<readonly Inline[]>): Word => {
  let best: Word = { text: "", code: false };
  let size = 0;
  for (const w of cells.flatMap((c) => words(c))) {
    const s = w.text.length * (w.code ? 1.3 : 1);
    if (s > size) {
      best = w;
      size = s;
    }
  }
  return best;
};

/**
 * Each column's width, its cells' text without the `gap` between columns, in `room` points; `scrolls` when the table
 * is wider than the room.
 */
export const columnWidths = (columns: readonly Measured[], room: number, gap: number): { widths: number[]; scrolls: boolean } => {
  const total = (ws: readonly number[]) => ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, ws.length - 1);
  const natural = columns.map((c) => Math.ceil(c.natural));
  if (total(natural) <= room) return { widths: natural, scrolls: false };
  const floor = columns.map((c, i) => (c.numeric ? (natural[i] ?? 0) : Math.min(natural[i] ?? 0, Math.min(Math.max(Math.ceil(c.word), MIN_COLUMN), MAX_COLUMN))));
  const want = columns.map((c, i) => (c.numeric ? (natural[i] ?? 0) : Math.max(floor[i] ?? 0, Math.min(natural[i] ?? 0, MAX_COLUMN))));
  const spread = (from: readonly number[], to: readonly number[], spare: number) => {
    const span = from.reduce((a, f, i) => a + (to[i] ?? 0) - f, 0);
    return from.map((f, i) => f + (span <= 0 ? 0 : Math.floor((((to[i] ?? 0) - f) * spare) / span)));
  };
  // Room past the capped widths goes to the columns that wrap, toward their whole line.
  if (total(want) <= room) return { widths: spread(want, natural, room - total(want)), scrolls: false };
  // Else the columns shrink from the capped widths toward their longest word, each by its share of what it can give.
  if (total(floor) <= room) return { widths: spread(floor, want, room - total(floor)), scrolls: false };
  return { widths: floor.map((f, i) => Math.max(f, Math.min(want[i] ?? 0, SCROLL_COLUMN))), scrolls: true };
};
