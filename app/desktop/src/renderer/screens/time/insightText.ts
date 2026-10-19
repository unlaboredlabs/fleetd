// The hub writes each finding's message; the app adds only layout: commands and numbers set in mono, and the
// compare period's numbers beside this one's.
import { fmtDur } from "./format";
import type { InsightNumber } from "./types";

export interface Piece {
  readonly text: string;
  /** Machine text: a backticked command, or a word with a number in it. */
  readonly mono: boolean;
}

/** A message split into pieces; a backticked run is one mono piece, the rest keeps its own spacing. */
export const pieces = (message: string): Piece[] => {
  const out: Piece[] = [];
  message.split("`").forEach((part, ix) => {
    if (part === "") return;
    if (ix % 2 === 1) {
      out.push({ text: part, mono: true });
      return;
    }
    for (const word of part.split(/(\s+)/u)) {
      if (word === "") continue;
      out.push({ text: word, mono: /\d/u.test(word) && !/^\s+$/u.test(word) });
    }
  });
  return out;
};

/** The hub writes messages in lower case so they read inside a sentence; the list starts each with a capital. */
export const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "noEdit" → "no edit", "totalMs" → "total": the hub's number names as words. */
export const words = (name: string): string =>
  name
    .replace(/(Ms|_ms)$/u, "")
    .replace(/_/gu, " ")
    .replace(/[A-Z]/gu, (c) => ` ${c.toLowerCase()}`)
    .trim();

const DURATION_NAMES = new Set(["total", "p50", "p90", "max", "excess", "dur", "wait", "longest"]);

const isDuration = (name: string): boolean => {
  const n = name.toLowerCase();
  return n.endsWith("ms") || DURATION_NAMES.has(n);
};

export const numberText = (n: InsightNumber): string =>
  n.value !== 0 && isDuration(n.name) ? fmtDur(n.value) : String(n.value);

/** "runs 22 → 9 · total 51m → 19m": each number for the earlier period, then this one. */
export const compareLine = (now: readonly InsightNumber[], before: readonly InsightNumber[]): string =>
  now
    .slice(0, 3)
    .map((n) => {
      const b = before.find((x) => x.name === n.name);
      return `${words(n.name)} ${b === undefined ? "0" : numberText(b)} → ${numberText(n)}`;
    })
    .join(" · ");
