// Ranking for the palette: a forgiving subsequence match ("dn" finds "desktop-notify"), ported from the GPUI app's
// palette.rs so the two find the same things, plus frecency: what you run often and lately rises.

import { GROUPS, type Command, type Group } from "./registry";

export interface Match {
  readonly score: number;
  /** Indexes into Array.from(text) of the matched letters, for highlighting. */
  readonly at: readonly number[];
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** The greedy subsequence match of `letters` in `hay` starting at `start`; undefined when a letter is missing. */
const matchFrom = (letters: readonly string[], hay: readonly string[], start: number): Match | undefined => {
  let total = 0;
  let at = start;
  let prev: number | undefined;
  const hits: number[] = [];
  for (const q of letters) {
    const found = hay.indexOf(q, at);
    if (found < 0) return undefined;
    total += 1;
    if (!isWordChar(hay[found - 1])) total += 8;
    if (prev !== undefined && prev + 1 === found) total += 6;
    else if (prev !== undefined) total -= Math.min(found - prev - 1, 6);
    else if (found === 0) total += 10;
    hits.push(found);
    prev = found;
    at = found + 1;
  }
  return { score: total, at: hits };
};

/**
 * Case-insensitive subsequence match; higher scores are better. Consecutive letters, letters at word starts and a
 * match at the very start score, gaps cost. Every place the first letter occurs is tried, so "fleetd" lights up
 * the word in "Prompts for fleetd", not the "f" of "for". Undefined when some query letter is missing.
 */
export const match = (query: string, text: string): Match | undefined => {
  const letters = Array.from(query.toLowerCase()).filter((c) => !/\s/u.test(c));
  if (letters.length === 0) return { score: 0, at: [] };
  const hay = Array.from(text.toLowerCase());
  let best: Match | undefined;
  for (let start = hay.indexOf(letters[0] ?? ""); start >= 0; start = hay.indexOf(letters[0] ?? "", start + 1)) {
    const m = matchFrom(letters, hay, start);
    if (m === undefined) break;
    if (best === undefined || m.score > best.score) best = m;
  }
  return best;
};

export const score = (query: string, text: string): number | undefined => match(query, text)?.score;

const groupOrder = (group: Group): number => GROUPS.indexOf(group);

/**
 * A detail is a sentence, where a subsequence finds nearly anything ("dark" in "Decides whether a research
 * claim's check passed"). It counts, at half weight, only when every typed word starts one of its words.
 */
const detailScore = (query: string, detail: string): number => {
  const words = detail.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.every((t) => words.some((w) => w.startsWith(t)))) return -Infinity;
  return (score(query, detail) ?? -Infinity) / 2;
};

/** How much each id has been used: a count weighted by how lately (see `frecency`). */
export type Frecency = ReadonlyMap<string, number>;

/** A typed match gains at most this much from use, about one consecutive letter: use decides close calls only. */
const MAX_BOOST = 8;
export const boost = (frecency: number): number => Math.min(MAX_BOOST, Math.round(4 * Math.log2(1 + frecency)));

export interface Ranked {
  /** The most used items, shown first when nothing is typed. */
  readonly suggested: readonly Command[];
  /** The rest, grouped: each group appears once. */
  readonly matches: readonly Command[];
}

const SUGGESTED = 5;

/**
 * The rows for `query`. With nothing typed: the most used items, then everything not `searchOnly`, by group.
 * Typed: by score plus a small boost for use, then each group gathered under its best match, so a group heads the
 * list once. Letters scattered mid-word ("dn" in "Add a project in fleetd") don't count.
 */
export const rank = (query: string, items: readonly Command[], frecency: Frecency = new Map(), limit = 60): Ranked => {
  const q = query.trim();
  if (q === "") {
    const suggested = items
      .filter((item) => (frecency.get(item.id) ?? 0) > 0)
      .sort((a, b) => (frecency.get(b.id) ?? 0) - (frecency.get(a.id) ?? 0))
      .slice(0, SUGGESTED);
    const shown = new Set(suggested.map((item) => item.id));
    const rest = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.searchOnly && !shown.has(item.id))
      .sort((a, b) => groupOrder(a.item.group) - groupOrder(b.item.group) || a.index - b.index)
      .map(({ item }) => item);
    return { suggested, matches: rest.slice(0, Math.max(0, limit - suggested.length)) };
  }
  const floor = 2 * Array.from(q).filter((c) => !/\s/u.test(c)).length;
  const scored: { item: Command; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const best = Math.max(
      score(q, item.title) ?? -Infinity,
      ...(item.keywords ?? []).map((k) => score(q, k) ?? -Infinity),
      detailScore(q, item.detail ?? ""),
    );
    if (best >= floor) scored.push({ item, score: best + boost(frecency.get(item.id) ?? 0), index });
  });
  scored.sort((a, b) => b.score - a.score || groupOrder(a.item.group) - groupOrder(b.item.group) || a.index - b.index);
  const top = scored.slice(0, limit).map((s) => s.item);
  // Gather by group in order of each group's best match; Array.sort is stable, so each group keeps its own order.
  const first = new Map<Group, number>();
  top.forEach((item, i) => {
    if (!first.has(item.group)) first.set(item.group, i);
  });
  return { suggested: [], matches: top.sort((a, b) => (first.get(a.group) ?? 0) - (first.get(b.group) ?? 0)) };
};

/** One id's use: how many runs and when the last was (ms). */
export interface Use {
  readonly count: number;
  readonly last: number;
}

const DAY = 86_400_000;

/** Runs count less as they age: fully within a day, then less each week and month. */
export const frecency = (use: Use, now: number): number => {
  const age = now - use.last;
  const weight = age < DAY ? 1 : age < 7 * DAY ? 0.6 : age < 30 * DAY ? 0.3 : 0.1;
  return use.count * weight;
};

/** At most this many ids are remembered; the least used go first. */
const KEEP = 50;

/**
 * Records a run of `id` at `now`, keeping `id` and the `KEEP - 1` other ids with the highest frecency: a new item
 * must not be dropped the moment it is first run, or it could never rise.
 */
export const noteUse = (uses: Readonly<Record<string, Use>>, id: string, now: number): Record<string, Use> => {
  const ran: Use = { count: (uses[id]?.count ?? 0) + 1, last: now };
  const others = Object.entries(uses).filter(([k]) => k !== id);
  const kept = others.length < KEEP ? others : others.sort(([, a], [, b]) => frecency(b, now) - frecency(a, now)).slice(0, KEEP - 1);
  return Object.fromEntries([[id, ran], ...kept]);
};
