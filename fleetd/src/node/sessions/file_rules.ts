// The rules for a bot's files that need no disk (files.ts and the actions read the disk by them): the @-mention's
// ranking, where an attachment may go, and whether a resolved path stays inside its folder. A hosted box's files are
// judged by the same rules (fleetd/box/file_rules).
import { sep } from "node:path";

export const ATTACHMENTS_DIR = ".fleetd/attachments/";
/** The most files the @-mention looks at. */
export const MAX_FILES = 200_000;

/** Whether `path` is `root` or inside it; both resolved already (realpath). */
export const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function walk(lower: string[], from: number, nameStart: number, query: string[]): number | undefined {
  let score = 0;
  let at = from;
  let last: number | undefined;
  for (const q of query) {
    let found = -1;
    for (let i = at; i < lower.length; i++)
      if (lower[i] === q) {
        found = i;
        break;
      }
    if (found < 0) return undefined;
    score += 1;
    if (last !== undefined && last + 1 === found) score += 5;
    if (found >= nameStart) score += 3;
    if (found === 0 || "/_-.".includes(lower[found - 1]!)) score += 4;
    last = found;
    at = found + 1;
  }
  return score;
}

/** How well `query` matches `path` as a subsequence; undefined when it doesn't. Higher is better. */
export function score(path: string, query: string): number | undefined {
  const lower = [...path.toLowerCase()];
  const q = [...query.toLowerCase()].filter((c) => !/\s/.test(c));
  const slash = lower.lastIndexOf("/");
  const nameStart = slash < 0 ? 0 : slash + 1;
  const scores = [nameStart, 0].map((from) => walk(lower, from, nameStart, q)).filter((s): s is number => s !== undefined);
  return scores.length ? Math.max(...scores) * 1000 - lower.length : undefined;
}

/** The best `limit` paths for `query`, and whether more matched. */
export function rank(paths: string[], query: string, limit: number): [string[], boolean] {
  const scored = paths.flatMap((p) => {
    const s = score(p, query);
    return s === undefined ? [] : [[s, p] as const];
  });
  scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return [scored.slice(0, limit).map(([, p]) => p), scored.length > limit];
}

/** `relPath` stays inside `.fleetd/attachments/`. */
export function attachmentPathOk(relPath: string): boolean {
  const parts = relPath.split("/");
  return relPath.startsWith(ATTACHMENTS_DIR) && parts.every((p) => p !== "" && p !== "." && p !== "..") && parts.length >= 4;
}
