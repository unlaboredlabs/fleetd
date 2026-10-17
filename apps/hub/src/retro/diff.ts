// Applying a model-written unified diff to one file's text. Hunks are placed by their context and removed lines,
// not their line numbers, which models get wrong; whitespace at line ends is ignored when nothing matches exactly.
// Pure.

interface Hunk {
  readonly oldStart: number;
  readonly ops: ReadonlyArray<{ readonly op: " " | "-" | "+"; readonly line: string }>;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/u;

const parse = (diff: string): ReadonlyArray<Hunk> | string => {
  const hunks: Array<{ oldStart: number; ops: Array<Hunk["ops"][number]> }> = [];
  const lines = diff.replace(/\r\n/gu, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header !== null) {
      hunks.push({ oldStart: Number(header[1]), ops: [] });
      continue;
    }
    const hunk = hunks[hunks.length - 1];
    if (hunk === undefined) continue; // ---, +++, diff --git and index lines before the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const op = line[0] ?? " "; // a blank context line whose leading space was lost
    if (op !== " " && op !== "-" && op !== "+") return `line "${line.slice(0, 60)}" is not part of a unified diff hunk`;
    hunk.ops.push({ op, line: line.slice(1) });
  }
  if (hunks.length === 0) return "it has no @@ hunk";
  return hunks;
};

const find = (lines: ReadonlyArray<string>, needle: ReadonlyArray<string>, from: number, same: (a: string, b: string) => boolean) => {
  for (let at = from; at + needle.length <= lines.length; at++) {
    if (needle.every((line, i) => same(lines[at + i]!, line))) return at;
  }
  return -1;
};

/** The patched text, or why the diff does not apply. */
export const applyUnifiedDiff = (text: string, diff: string): { readonly text: string } | { readonly error: string } => {
  const hunks = parse(diff);
  if (typeof hunks === "string") return { error: `the diff is not a unified diff: ${hunks}` };
  const lines = text.split("\n");
  let cursor = 0;
  for (const [i, hunk] of hunks.entries()) {
    const old = hunk.ops.filter((o) => o.op !== "+").map((o) => o.line);
    let at: number;
    if (old.length === 0) {
      at = Math.min(Math.max(hunk.oldStart, cursor), lines.length);
    } else {
      at = find(lines, old, cursor, (a, b) => a === b);
      if (at < 0) at = find(lines, old, cursor, (a, b) => a.trimEnd() === b.trimEnd());
      if (at < 0) return { error: `hunk ${i + 1} of the diff does not match the current playbook` };
    }
    // Context lines keep the file's own text.
    let k = at;
    const next: Array<string> = [];
    for (const o of hunk.ops) {
      if (o.op === " ") next.push(lines[k++]!);
      else if (o.op === "-") k++;
      else next.push(o.line);
    }
    lines.splice(at, old.length, ...next);
    cursor = at + next.length;
  }
  return { text: lines.join("\n") };
};
