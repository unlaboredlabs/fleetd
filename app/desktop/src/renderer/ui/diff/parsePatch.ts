/**
 * A unified-diff parser for the diff view. Shapes follow T3 Code's diff panel (MIT, see THIRD_PARTY_NOTICES.md):
 * a patch becomes files of hunks, a patch it cannot read falls back to raw text with a reason instead of failing,
 * and the gap between hunks is kept so the view can say "N unmodified lines".
 */

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** The file ends here without a newline ("\ No newline at end of file"). */
  noNewline: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The function or section name git prints after the @@ range. */
  section: string;
  lines: DiffLine[];
  /** Unchanged lines skipped between the previous hunk (or the file start) and this one. */
  collapsedBefore: number;
}

export type FileChange = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** The name to show: the new path, or the old one for a deletion. */
  path: string;
  change: FileChange;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export type ParsedPatch = { kind: "files"; files: DiffFile[] } | { kind: "raw"; text: string; reason: string };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Strips git's quoting and the a/ b/ prefixes; /dev/null is no file. */
function cleanPath(raw: string): string | null {
  let p = raw.trim().split("\t")[0] ?? "";
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t");
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

function newFile(): DiffFile {
  return { oldPath: null, newPath: null, path: "", change: "modified", binary: false, hunks: [], additions: 0, deletions: 0 };
}

function finish(f: DiffFile): DiffFile {
  if (f.oldPath === null && f.newPath !== null) f.change = "added";
  else if (f.newPath === null && f.oldPath !== null) f.change = "deleted";
  else if (f.change !== "renamed" && f.oldPath !== null && f.newPath !== null && f.oldPath !== f.newPath) f.change = "renamed";
  f.path = f.newPath ?? f.oldPath ?? "";
  return f;
}

export function parsePatch(patch: string | null | undefined): ParsedPatch | null {
  const text = (patch ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let prevOldEnd = 0;
  // Within a git header, "--- " and "+++ " are path lines; inside a hunk they are content.
  let inHeader = false;

  const push = () => {
    if (file) files.push(finish(file));
    file = null;
    hunk = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      push();
      file = newFile();
      inHeader = true;
      prevOldEnd = 0;
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      if (m) {
        file.oldPath = cleanPath(`a/${m[1] ?? ""}`);
        file.newPath = cleanPath(`b/${m[2] ?? ""}`);
      }
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      if (!file) {
        file = newFile();
        prevOldEnd = 0;
      }
      inHeader = false;
      const cur: DiffHunk = {
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
        section: (h[5] ?? "").trim(),
        lines: [],
        collapsedBefore: 0,
      };
      cur.collapsedBefore = Math.max(0, cur.oldStart - prevOldEnd - 1);
      prevOldEnd = cur.oldStart + cur.oldCount - 1;
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      file.hunks.push(cur);
      hunk = cur;
      continue;
    }
    if (line.startsWith("--- ") && (inHeader || !hunk || !file)) {
      if (!file || (file.hunks.length > 0 && !inHeader)) {
        push();
        file = newFile();
        prevOldEnd = 0;
      }
      inHeader = true;
      file.oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ") && inHeader && file) {
      file.newPath = cleanPath(line.slice(4));
      continue;
    }
    if (file && inHeader) {
      if (line.startsWith("new file mode")) file.oldPath = null;
      else if (line.startsWith("deleted file mode")) file.newPath = null;
      else if (line.startsWith("rename from ")) {
        file.oldPath = cleanPath(line.slice(12));
        file.change = "renamed";
      } else if (line.startsWith("rename to ")) {
        file.newPath = cleanPath(line.slice(10));
        file.change = "renamed";
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
      continue;
    }
    const cur: DiffHunk | null = hunk;
    if (!cur || !file) continue;
    const f: DiffFile = file;
    const mark = line.charAt(0);
    const body = line.slice(1);
    if (mark === "+") {
      cur.lines.push({ kind: "add", text: body, oldNo: null, newNo: newNo++, noNewline: false });
      f.additions++;
    } else if (mark === "-") {
      cur.lines.push({ kind: "del", text: body, oldNo: oldNo++, newNo: null, noNewline: false });
      f.deletions++;
    } else if (mark === " " || line === "") {
      cur.lines.push({ kind: "context", text: body, oldNo: oldNo++, newNo: newNo++, noNewline: false });
    } else if (mark === "\\") {
      const last = cur.lines.at(-1);
      if (last) last.noNewline = true;
    }
  }
  push();

  if (files.length === 0 || files.every((f) => f.hunks.length === 0 && !f.binary && f.change === "modified")) {
    return { kind: "raw", text, reason: "This isn't a unified diff, so it is shown as sent." };
  }
  return { kind: "files", files };
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Side-by-side rows: context lines sit on both sides, and each run of deletions is paired line by line with the
 * run of additions that follows it, so a changed line reads across.
 */
export function toSplitRows(lines: ReadonlyArray<DiffLine>): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === "del") dels.push(lines[i++] as DiffLine);
    while (lines[i]?.kind === "add") adds.push(lines[i++] as DiffLine);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}
