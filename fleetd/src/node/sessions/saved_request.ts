// Claude Code keeps its session's first request in its own copy of the conversation (`<id>.jsonl`): an
// `api-request-shape` record and `attachment` records of type `prompt_snapshot`, its tools' definitions among them.
// `claude --resume` sends those again rather than what tools/list says now (seen with 2.1.314: a session resumed after
// a tool's description changed still sent the old one). So a resume for fleetd's updated tools takes them out of the
// file first, relinking claude's chain of messages past them (`strip`), and every other byte stays; the resumed claude writes them again from what it now has. A
// file that isn't JSON objects line by line, or holds none of them, is Claude Code's format changed under us: it is
// never written, and its claude isn't resumed for this at all.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const saved = (entry: Record<string, unknown>) =>
  entry.type === "api-request-shape" ||
  (entry.type === "attachment" && typeof entry.attachment === "object" && entry.attachment !== null && (entry.attachment as { type?: unknown }).type === "prompt_snapshot");

/** The fields by which a record names another, each relinked past a record that goes. */
const LINKS = ["parentUuid", "logicalParentUuid", "leafUuid"] as const;

/** `text` without the saved request's records and how many went, or why it isn't as expected: a line that isn't a
 * JSON object, none of them there, a parent named that the file doesn't hold, or a link not written as claude writes
 * it. A snapshot is a link in claude's chain of messages (`--resume` walks `parentUuid` back from the leaf): what named
 * it as its parent, or as the leaf, names its parent instead, so the conversation stays whole. Only those fields of
 * those lines change, as written; every other byte stays. */
function strip(text: string): { text: string; taken: number } | { why: string } {
  const lines = text.split("\n");
  const entries: (Record<string, unknown> | undefined)[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") {
      entries.push(undefined);
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = undefined;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { why: `its line ${i + 1} isn't a JSON object` };
    entries.push(entry as Record<string, unknown>);
  }
  // Each record that goes, by its uuid: the parent it had.
  const gone = new Map<string, string | null>();
  const held = new Set<string>();
  let taken = 0;
  for (const entry of entries) {
    if (!entry) continue;
    const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
    if (saved(entry)) {
      taken++;
      if (uuid) gone.set(uuid, typeof entry.parentUuid === "string" ? entry.parentUuid : null);
    } else if (uuid) held.add(uuid);
  }
  if (taken === 0) return { why: "it holds no api-request-shape or prompt_snapshot record" };
  const past = (uuid: string): string | null => {
    let at: string | null = uuid;
    for (let hops = 0; at !== null && gone.has(at) && hops <= gone.size; hops++) at = gone.get(at)!;
    return at;
  };
  const kept: string[] = [];
  for (const [i, entry] of entries.entries()) {
    let line = lines[i]!;
    if (entry && saved(entry)) continue;
    if (entry) {
      const parent = entry.parentUuid;
      if (typeof parent === "string" && !held.has(parent) && !gone.has(parent)) return { why: `its line ${i + 1} names a parent the file doesn't hold` };
      for (const field of LINKS) {
        const named = entry[field];
        if (typeof named !== "string" || !gone.has(named)) continue;
        const was = `${JSON.stringify(field)}:${JSON.stringify(named)}`;
        if (line.split(was).length !== 2) return { why: `its line ${i + 1} doesn't write ${field} as expected` };
        line = line.replace(was, `${JSON.stringify(field)}:${JSON.stringify(past(named))}`);
      }
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), taken };
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
