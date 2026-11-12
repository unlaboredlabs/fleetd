// The train's names for its commit status and its label, and the text helpers its records and the PR views share.

/** The commit status the train posts on a PR's head. */
export const TRAIN_CONTEXT = "fleetd/train";
/** The label the train puts on its batch PR and on the next PRs it will merge. */
export const NEXT_LABEL = "fleetd:next";
/** A hidden line on every comment the train posts. */
export const TRAIN_MARK = "<!-- fleetd:train -->";

/** The first `max` UTF-16 units of `text`, never splitting a surrogate pair (api/grants.rs `clip`). */
export function clip(text: string, max: number): string {
  let units = 0;
  let out = "";
  for (const c of text) {
    units += c.length;
    if (units > max) return out;
    out += c;
  }
  return text;
}

/** `cap`: at most `max` items, and `truncated` when some were cut. */
export function cap<T>(items: T[], max: number): { items: T[]; truncated?: true } {
  return items.length > max ? { items: items.slice(0, max), truncated: true } : { items };
}

/** The machine-readable line in a batch PR's body naming each member and the head it was built from. */
export const BATCH_MARKER = "fleetd-batch:";

/** Each member a batch PR's body names on its `fleetd-batch:` line, with the head sha it was built from. */
export function batchHeads(body: string): [number, string | undefined][] {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(BATCH_MARKER));
  if (line === undefined) return [];
  const out: [number, string | undefined][] = [];
  for (const w of line.slice(BATCH_MARKER.length).split(/\s+/).filter(Boolean)) {
    const bare = w.replace(/^#+/, "");
    const at = bare.indexOf("@");
    const [n, sha] = at < 0 ? [bare, undefined] : [bare.slice(0, at), bare.slice(at + 1).toLowerCase()];
    if (/^[+-]?\d+$/.test(n)) out.push([Number(n), sha]);
  }
  return out;
}
