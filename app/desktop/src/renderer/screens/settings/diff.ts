// A prose diff for prompts: by line (a prompt is one line per paragraph), then by word inside a paragraph that was
// changed rather than added or removed, since a one-word edit should not paint the whole paragraph. It is LCS, which is
// plenty for prompts (a few hundred lines at most).

export type Op = "same" | "add" | "del";
export interface Piece {
  readonly op: Op;
  readonly text: string;
}
export interface DiffLine {
  readonly op: Op;
  readonly text: string;
  /** For a changed paragraph: its words, marked against the paragraph it replaced (or replaces). */
  readonly words?: ReadonlyArray<Piece>;
}

/** Past this many LCS cells, a pair of paragraphs is shown as removed + added without word marks. */
const WORD_BUDGET = 250_000;

function lcs<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): Array<{ op: Op; a?: T; b?: T }> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? (t[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
    }
  }
  const out: Array<{ op: Op; a?: T; b?: T }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] as T;
    const bj = b[j] as T;
    if (ai === bj) {
      out.push({ op: "same", a: ai, b: bj });
      i++;
      j++;
    } else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) {
      out.push({ op: "del", a: ai });
      i++;
    } else {
      out.push({ op: "add", b: bj });
      j++;
    }
  }
  for (; i < n; i++) out.push({ op: "del", a: a[i] as T });
  for (; j < m; j++) out.push({ op: "add", b: b[j] as T });
  return out;
}

/** Words and the whitespace between them, so joining the pieces gives the text back exactly. */
const tokens = (s: string): string[] => s.split(/(\s+)/u).filter((x) => x !== "");

export function diffWords(a: string, b: string): { before: Piece[]; after: Piece[] } | null {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length * tb.length > WORD_BUDGET) return null;
  const before: Piece[] = [];
  const after: Piece[] = [];
  const push = (into: Piece[], op: Op, text: string) => {
    const last = into.at(-1);
    if (last?.op === op) into[into.length - 1] = { op, text: last.text + text };
    else into.push({ op, text });
  };
  for (const step of lcs(ta, tb)) {
    if (step.op === "same") {
      push(before, "same", step.a ?? "");
      push(after, "same", step.b ?? "");
    } else if (step.op === "del") push(before, "del", step.a ?? "");
    else push(after, "add", step.b ?? "");
  }
  return { before, after };
}

const lines = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/u, "").split("\n"));

/**
 * The lines of `a` → `b`. A run of removed lines followed by added ones pairs up line by line, and each pair gets
 * word marks when the two share enough words to read as an edit.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const steps = lcs(lines(a), lines(b));
  const out: DiffLine[] = [];
  let k = 0;
  while (k < steps.length) {
    const step = steps[k];
    if (!step) break;
    if (step.op === "same") {
      out.push({ op: "same", text: step.a ?? "" });
      k++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (steps[k]?.op === "del") dels.push(steps[k++]?.a ?? "");
    while (steps[k]?.op === "add") adds.push(steps[k++]?.b ?? "");
    const pairs = Math.min(dels.length, adds.length);
    const delLines: DiffLine[] = [];
    const addLines: DiffLine[] = [];
    dels.forEach((text, ix) => {
      const other = ix < pairs ? adds[ix] : undefined;
      const words = other !== undefined && text.trim() !== "" && other.trim() !== "" ? diffWords(text, other) : null;
      const related = words !== null && shared(words.before) >= 0.4;
      delLines.push(related ? { op: "del", text, words: words.before } : { op: "del", text });
      if (other !== undefined) addLines.push(related ? { op: "add", text: other, words: words.after } : { op: "add", text: other });
    });
    for (const text of adds.slice(pairs)) addLines.push({ op: "add", text });
    out.push(...delLines, ...addLines);
  }
  return out;
}

/** The share of a paragraph's characters that survived the edit. */
function shared(pieces: ReadonlyArray<Piece>): number {
  const total = pieces.reduce((n, p) => n + p.text.length, 0);
  const same = pieces.reduce((n, p) => n + (p.op === "same" ? p.text.length : 0), 0);
  return total === 0 ? 0 : same / total;
}

export function counts(d: ReadonlyArray<DiffLine>): { added: number; removed: number } {
  return {
    added: d.filter((l) => l.op === "add").length,
    removed: d.filter((l) => l.op === "del").length,
  };
}

/** Whitespace-only differences (a reflow) do not make two texts different to a person. */
export const sameProse = (a: string, b: string): boolean => a.replace(/\s+/gu, " ").trim() === b.replace(/\s+/gu, " ").trim();
