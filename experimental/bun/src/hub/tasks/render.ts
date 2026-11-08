// How a task's texts are cut and what a cut must keep (crates/fleetd/src/hub/tasks/render.rs). The prompt
// rendering comes with the tasks area's port.
import { jsPrefix, jsSuffix } from "../../shared/text.ts";

export const TAIL_MAX = 2000;
const REFS = "Refs: ";

/** The text on one line, whitespace runs one space; cut to `max` units with "…" last. */
export function oneLine(text: string, max: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length > max ? `${jsPrefix(flat, max - 1)}…` : flat;
}

const PR_URL = /https?:\/\/[^\s"'<>()]+?\/(?:pull|pulls|pull-requests|pullrequest|merge_requests)\/[0-9]+/g;

/** Every PR URL in `texts`, in order. */
export const prUrls = (texts: string[]) => texts.flatMap((t) => [...t.matchAll(PR_URL)].map((m) => m[0]));

const isAttachmentId = (token: string) => /^F[1-9][0-9]*$/.test(token);

/** 7 to 40 lowercase hex digits with a letter and a digit, so neither a number nor a hex-looking word. */
const isSha = (token: string) => /^[0-9a-f]{7,40}$/.test(token) && /[0-9]/.test(token) && /[a-f]/.test(token);

/** What a result names that a cut must never lose, each once: its PR URLs, attachment ids, then commit SHAs. */
export function refsOf(text: string): string[] {
  const tokens = text.match(/[0-9A-Za-z_-]+/g) ?? [];
  const refs: string[] = [];
  for (const r of [...prUrls([text]), ...tokens.filter(isAttachmentId), ...tokens.filter(isSha)]) {
    if (!refs.includes(r)) refs.push(r);
  }
  return refs;
}

/**
 * `text` trimmed, and when longer than `max` UTF-16 units its head and its tail around "…", with a last line
 * "Refs: …" lifting every PR URL, attachment id and commit SHA of the whole text, so no cut loses them.
 */
export function resultText(text: string, max: number): string {
  let t = text.trim();
  if (t.length <= max) return t;
  const refs = refsOf(t);
  // A text cut once already ends in its own Refs line: the new one replaces it, and holds all of its refs.
  const at = t.lastIndexOf(`\n\n${REFS}`);
  if (at >= 0 && !t.slice(at + 2 + REFS.length).includes("\n")) t = t.slice(0, at).trimEnd();
  const line = refs.length === 0 ? "" : `\n\n${oneLine(`${REFS}${refs.join(" ")}`, Math.floor(max / 2))}`;
  const room = max - line.length - "\n…\n".length;
  const head = jsPrefix(t, Math.floor(room / 2)).trimEnd();
  const tail = jsSuffix(t, room - head.length).trimStart();
  return `${head}\n…\n${tail}${line}`;
}
