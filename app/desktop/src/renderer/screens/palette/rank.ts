// Ranking for the palette: a forgiving subsequence match ("dn" finds "desktop-notify"), ported from the GPUI app's
// palette.rs so the two find the same things.

import { GROUPS, type Command, type Group } from "./registry";

/**
 * Case-insensitive subsequence score; higher is better. Consecutive letters, letters at word starts and a match
 * at the very start score, gaps cost. Undefined when some query letter is missing.
 */
export const score = (query: string, text: string): number | undefined => {
  const hay = Array.from(text.toLowerCase());
  let total = 0;
  let at = 0;
  let prev: number | undefined;
  for (const q of query.toLowerCase()) {
    if (/\s/u.test(q)) continue;
    let found = -1;
    for (let i = at; i < hay.length; i += 1) {
      if (hay[i] === q) {
        found = i;
        break;
      }
    }
    if (found < 0) return undefined;
    const before = found === 0 ? undefined : hay[found - 1];
    total += 1;
    if (before === undefined || !/[\p{L}\p{N}]/u.test(before)) total += 8;
    if (prev !== undefined && prev + 1 === found) total += 6;
    else if (prev !== undefined) total -= Math.min(found - prev - 1, 6);
    else if (found === 0) total += 10;
    prev = found;
    at = found + 1;
  }
  return total;
};

const groupOrder = (group: Group): number => GROUPS.indexOf(group);

export interface Ranked {
  /** Recently run items, shown first when nothing is typed. */
  readonly recent: readonly Command[];
  readonly matches: readonly Command[];
}

/**
 * The rows for `query`, best first. With nothing typed: the recent items, then everything not `searchOnly`,
 * grouped. Typed: by score, then group; letters scattered mid-word ("dn" in "Add a project in fleetd") don't count.
 */
export const rank = (query: string, items: readonly Command[], recentIds: readonly string[], limit = 60): Ranked => {
  const q = query.trim();
  if (q === "") {
    const byId = new Map(items.map((item) => [item.id, item]));
    const recent = recentIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    const shown = new Set(recent.map((item) => item.id));
    const rest = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.searchOnly && !shown.has(item.id))
      .sort((a, b) => groupOrder(a.item.group) - groupOrder(b.item.group) || a.index - b.index)
      .map(({ item }) => item);
    return { recent, matches: rest.slice(0, Math.max(0, limit - recent.length)) };
  }
  const floor = 2 * Array.from(q).filter((c) => !/\s/u.test(c)).length;
  const recentAt = new Map(recentIds.map((id, i) => [id, i]));
  const scored: { item: Command; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const best = Math.max(
      score(q, item.title) ?? -Infinity,
      ...(item.keywords ?? []).map((k) => score(q, k) ?? -Infinity),
      (score(q, item.detail ?? "") ?? -Infinity) / 2,
    );
    if (best >= floor) scored.push({ item, score: best, index });
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      // Among equals, what you ran lately comes first.
      (recentAt.get(a.item.id) ?? Infinity) - (recentAt.get(b.item.id) ?? Infinity) ||
      groupOrder(a.item.group) - groupOrder(b.item.group) ||
      a.index - b.index,
  );
  return { recent: [], matches: scored.slice(0, limit).map((s) => s.item) };
};

/** Recent ids, newest first, at most `max`; running an item moves it to the front. */
export const pushRecent = (recent: readonly string[], id: string, max = 5): string[] =>
  [id, ...recent.filter((r) => r !== id)].slice(0, max);
