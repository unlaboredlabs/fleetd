// The train's names for its commit status and its label, and the text helpers its records and the PR views share.

/** The commit status the train posts on a PR's head. */
export const TRAIN_CONTEXT = "fleetd/train";
/** The label the train puts on its batch PR and on the next PRs it will merge. */
export const NEXT_LABEL = "fleetd:next";

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
