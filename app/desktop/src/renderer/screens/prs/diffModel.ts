// A PR's changes as one flat list of rows (file headers, hunk lines, diff lines), so the view draws only the rows on
// screen whatever the PR's size. The hub sends files a page at a time and each file's diff a page of lines at a time;
// a page not loaded yet stands as one empty row per line it will hold, so the list's length and scroll height are
// right from the start and nothing below moves when a page lands. Pure, so the shape is tested without a DOM.
import type { DiffLine, PrFile } from "../../../shared/contracts";

/** Lines per pr_diff page; the hub's default and well under its cap. */
export const DIFF_PAGE = 200;

export type DiffMode = "unified" | "split";

export type DiffRow =
  | { readonly kind: "file"; readonly key: string; readonly file: number; readonly f: PrFile; readonly open: boolean }
  | { readonly kind: "hunk"; readonly key: string; readonly file: number; readonly line: DiffLine }
  | { readonly kind: "line"; readonly key: string; readonly file: number; readonly page: Page; readonly line: DiffLine }
  | { readonly kind: "pair"; readonly key: string; readonly file: number; readonly page: Page; readonly left: DiffLine | null; readonly right: DiffLine | null }
  /** A line whose page hasn't loaded: drawing it asks for the page. */
  | { readonly kind: "pending"; readonly key: string; readonly file: number; readonly path: string; readonly offset: number; readonly first: boolean }
  | { readonly kind: "note"; readonly key: string; readonly file: number; readonly text: string }
  | { readonly kind: "more"; readonly key: string; readonly left: number };

/** One loaded page of a file's diff. Its identity keys the page's highlighting. */
export interface Page {
  readonly path: string;
  readonly offset: number;
  readonly lines: readonly DiffLine[];
}

/** The loaded pages, by path, then by offset. */
export type Pages = ReadonlyMap<string, ReadonlyMap<number, Page>>;

/**
 * Side-by-side rows: context on both sides, and each run of deletions paired line by line with the run of additions
 * after it, so a changed line reads across. Within one page: a run cut by a page boundary pairs on each side of it.
 */
export const toPairs = (lines: readonly DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null } | { hunk: DiffLine }> => {
  const out: Array<{ left: DiffLine | null; right: DiffLine | null } | { hunk: DiffLine }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.kind === "hunk") {
      out.push({ hunk: line });
      i++;
      continue;
    }
    if (line.kind !== "del" && line.kind !== "add") {
      out.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === "del") dels.push(lines[i++] as DiffLine);
    while (lines[i]?.kind === "add") adds.push(lines[i++] as DiffLine);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
};

const pairs = new WeakMap<Page, ReturnType<typeof toPairs>>();
const pairsOf = (page: Page) => {
  let hit = pairs.get(page);
  if (hit === undefined) {
    hit = toPairs(page.lines);
    pairs.set(page, hit);
  }
  return hit;
};

export interface RowsInput {
  readonly files: readonly PrFile[];
  /** Changed files in the PR; more than `files` while pages of files are still to load. */
  readonly total: number;
  readonly pages: Pages;
  readonly mode: DiffMode;
  readonly folded: ReadonlySet<string>;
}

export const diffRows = ({ files, total, pages, mode, folded }: RowsInput): DiffRow[] => {
  const rows: DiffRow[] = [];
  files.forEach((f, i) => {
    const open = !folded.has(f.path);
    const k = `${i}\u0000${f.path}`;
    rows.push({ kind: "file", key: `${k}\u0000file`, file: i, f, open });
    if (!open) return;
    if (f.diffLines === undefined) {
      rows.push({ kind: "note", key: `${k}\u0000note`, file: i, text: "No diff to show here: a binary file, or one too large. Open it on GitHub to see it." });
      return;
    }
    if (f.diffLines === 0) {
      rows.push({ kind: "note", key: `${k}\u0000note`, file: i, text: f.status === "renamed" ? "Renamed, with no other changes." : "No changed lines." });
      return;
    }
    const filePages = pages.get(f.path);
    for (let offset = 0; offset < f.diffLines; offset += DIFF_PAGE) {
      const page = filePages?.get(offset);
      if (page === undefined) {
        const n = Math.min(DIFF_PAGE, f.diffLines - offset);
        for (let j = 0; j < n; j++) rows.push({ kind: "pending", key: `${k}\u0000${offset + j}`, file: i, path: f.path, offset, first: j === 0 });
        continue;
      }
      if (mode === "unified") {
        page.lines.forEach((line, j) =>
          rows.push(line.kind === "hunk" ? { kind: "hunk", key: `${k}\u0000${offset + j}`, file: i, line } : { kind: "line", key: `${k}\u0000${offset + j}`, file: i, page, line }),
        );
      } else {
        pairsOf(page).forEach((p, j) =>
          rows.push("hunk" in p ? { kind: "hunk", key: `${k}\u0000${offset}s${j}`, file: i, line: p.hunk } : { kind: "pair", key: `${k}\u0000${offset}s${j}`, file: i, page, left: p.left, right: p.right }),
        );
      }
    }
  });
  if (files.length < total) rows.push({ kind: "more", key: "more", left: total - files.length });
  return rows;
};

/** The row index of each loaded file's header, for jumping to a file from the list beside the diff. */
export const fileRowIndex = (rows: readonly DiffRow[]): Map<number, number> => {
  const out = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.kind === "file") out.set(r.file, i);
  });
  return out;
};

/** The file whose rows the view is in, for marking it in the list of files. */
export const fileAt = (rows: readonly DiffRow[], index: number): number | undefined => {
  const r = rows[Math.max(0, Math.min(index, rows.length - 1))];
  return r === undefined || r.kind === "more" ? undefined : r.file;
};

/** Each side of a page as one text, so the highlighter reads whole runs of code; and each line's place in it. */
export interface Sides {
  readonly oldText: string;
  readonly newText: string;
  readonly oldIndex: ReadonlyMap<DiffLine, number>;
  readonly newIndex: ReadonlyMap<DiffLine, number>;
}

const sides = new WeakMap<Page, Sides>();

export const sidesOf = (page: Page): Sides => {
  const hit = sides.get(page);
  if (hit !== undefined) return hit;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const oldIndex = new Map<DiffLine, number>();
  const newIndex = new Map<DiffLine, number>();
  for (const l of page.lines) {
    if (l.kind === "hunk") continue;
    if (l.kind !== "add") {
      oldIndex.set(l, oldLines.length);
      oldLines.push(l.text);
    }
    if (l.kind !== "del") {
      newIndex.set(l, newLines.length);
      newLines.push(l.text);
    }
  }
  const out = { oldText: oldLines.join("\n"), newText: newLines.join("\n"), oldIndex, newIndex };
  sides.set(page, out);
  return out;
};

/** "Line 120", with the hunk's own context ("fn main") when git gave one. */
export const hunkText = (line: DiffLine): string =>
  [line.new !== undefined ? `Line ${line.new}` : line.old !== undefined ? `Line ${line.old}` : "", line.text.trim()].filter(Boolean).join(" · ");

/** "renamed from src/old.ts", "added", "deleted"; empty for a plain change. */
export const statusWords = (f: PrFile): string => {
  switch (f.status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return f.previousPath === undefined ? "renamed" : `renamed from ${f.previousPath}`;
    case "copied":
      return f.previousPath === undefined ? "copied" : `copied from ${f.previousPath}`;
    default:
      return "";
  }
};
