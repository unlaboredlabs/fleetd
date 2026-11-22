// Claude's own copy of a session's conversation (`<config dir>/projects/<cwd>/<id>.jsonl`, what `--resume` reads)
// keeps what its commands printed as they printed it: the node masks only what it stores and sends. Once the
// session's claude has exited, each line holding a secret's value, or a private key's PEM block, is written again
// masked (../mask.ts), so the file keeps none either. Every other line stays byte for byte, and a session resumes from it
// as before. The model itself saw what a command printed: that can't be taken back.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Masker } from "../mask.ts";

/** Masks `file`'s lines that hold one of `secrets` (in any form claude's JSON may write it) or a private key. Whether
 * it changed. */
export function scrubTranscript(file: string, secrets: [name: string, value: string][]): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  // The thorough masker's forms include each value JSON-escaped: they find a line, the plain masker masks its strings.
  const finder = Masker.thorough(secrets);
  const hit = (s: string) => s.includes("PRIVATE KEY-----") || finder.patterns.some(([p]) => s.includes(p));
  if (!hit(text)) return false;
  const masker = new Masker(secrets);
  const lines = text.split("\n");
  let changed = false;
  for (const [i, line] of lines.entries()) {
    if (!hit(line)) continue;
    let next: string;
    try {
      const entry = JSON.parse(line);
      next = JSON.stringify(masker.value(entry));
      if (next === JSON.stringify(entry)) continue;
    } catch {
      next = masker.text(line);
    }
    if (next === line) continue;
    lines[i] = next;
    changed = true;
  }
  if (!changed) return false;
  const tmp = `${file}.scrub`;
  writeFileSync(tmp, lines.join("\n"), { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
  return true;
}
