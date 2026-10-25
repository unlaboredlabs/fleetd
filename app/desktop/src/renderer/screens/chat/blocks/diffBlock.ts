// A diff block's files as the PR view's lines: each hunk's "@@ -a,b +c,d @@ context" line, then its lines numbered
// on each side. Pure.
import type { DiffFile, DiffLine, PrFile } from "../../../../shared/contracts";

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export function hunkLines(hunks: readonly string[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const hunk of hunks) {
    let oldN = 0;
    let newN = 0;
    for (const raw of hunk.split("\n")) {
      const head = HUNK.exec(raw);
      if (head !== null) {
        oldN = Number(head[1]);
        newN = Number(head[2]);
        out.push({ kind: "hunk", old: oldN, new: newN, text: head[3] ?? "" });
      } else if (raw.startsWith("+")) out.push({ kind: "add", new: newN++, text: raw.slice(1) });
      else if (raw.startsWith("-")) out.push({ kind: "del", old: oldN++, text: raw.slice(1) });
      // "\ No newline at end of file", and the empty line after a hunk's last newline.
      else if (raw.startsWith("\\") || raw === "") continue;
      else out.push({ kind: "context", old: oldN++, new: newN++, text: raw.slice(1) });
    }
  }
  return out;
}

/** The file as the PR view's header reads it: counted from its lines. */
export function fileOf(f: DiffFile, lines: readonly DiffLine[]): PrFile {
  const additions = lines.filter((l) => l.kind === "add").length;
  const deletions = lines.filter((l) => l.kind === "del").length;
  const status = lines.every((l) => l.kind !== "context" && l.kind !== "del") && lines.some((l) => l.old === 0) ? "added" : "modified";
  return { path: f.path, additions, deletions, status };
}
