// Claude Code keeps its session's first request in its own copy of the conversation (`<id>.jsonl`): an
// `api-request-shape` record and `attachment` records of type `prompt_snapshot`, its tools' definitions among them.
// `claude --resume` sends those again rather than what tools/list says now (seen with 2.1.314: a session resumed after
// a tool's description changed still sent the old one). So a resume for fleetd's updated tools takes them out of the
// file first, and every other line stays byte for byte; the resumed claude writes them again from what it now has. A
// file that isn't JSON objects line by line, or holds none of them, is Claude Code's format changed under us: it is
// never written, and its claude isn't resumed for this at all.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const saved = (entry: Record<string, unknown>) =>
  entry.type === "api-request-shape" ||
  (entry.type === "attachment" && typeof entry.attachment === "object" && entry.attachment !== null && (entry.attachment as { type?: unknown }).type === "prompt_snapshot");

/** `text` without the saved request's records and how many went, or why it isn't as expected: a line that isn't a
 * JSON object, or none of them there. */
function strip(text: string): { text: string; taken: number } | { why: string } {
  const kept: string[] = [];
  let taken = 0;
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") {
      kept.push(line);
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = undefined;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { why: `its line ${i + 1} isn't a JSON object` };
    if (saved(entry as Record<string, unknown>)) taken++;
    else kept.push(line);
  }
  return taken === 0 ? { why: "it holds no api-request-shape or prompt_snapshot record" } : { text: kept.join("\n"), taken };
}

/** `text` without the saved request's records and how many went; undefined when it isn't as expected. */
export function withoutSavedRequest(text: string): { text: string; taken: number } | undefined {
  const out = strip(text);
  return "why" in out ? undefined : out;
}

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** Why the conversation at `file` doesn't hold the saved request as expected, so a resume can't take it out;
 * undefined when it does. */
export function savedRequestMissing(file: string): string | undefined {
  const text = read(file);
  if (text === undefined) return "it can't be read";
  const out = strip(text);
  return "why" in out ? out.why : undefined;
}

export const holdsSavedRequest = (file: string) => savedRequestMissing(file) === undefined;

/** Takes the saved request out of the conversation at `file`: how many records went, or undefined when the file
 * isn't as expected (then it is left as it is). */
export function takeSavedRequest(file: string): number | undefined {
  const text = read(file);
  const out = text === undefined ? undefined : withoutSavedRequest(text);
  if (!out) return undefined;
  const tmp = `${file}.saved-request`;
  writeFileSync(tmp, out.text, { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
  return out.taken;
}
