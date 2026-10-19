// When a row comes and goes. A finished lane holds its check for a while, then folds away; a row that left the
// data stays at its old place while it collapses, so the rows under it slide up instead of jumping (or overlapping:
// the collapse is in the flow, never positioned over its neighbour).
import { useEffect, useState } from "react";
import type { AgentLane } from "./contracts";
import { parseMs } from "./format";
import { DONE_HOLD_MS, EXIT_MS } from "./live";
import { isFinal } from "./words";

/**
 * The lanes still drawn at `now` (hub ms): every lane at work, a failed one for good (with its reason), and done or
 * cancelled ones until their hold ran out. A done lane with no end time has nothing to hold: it is already gone.
 */
export const heldLanes = (lanes: readonly AgentLane[], now: number): AgentLane[] =>
  lanes.filter((l) => {
    if (!isFinal(l.status) || l.status === "failed") return true;
    const ended = parseMs(l.endedAt);
    return ended !== undefined && now < ended + DONE_HOLD_MS;
  });

/**
 * The staged order's rows: its lanes as held, plus any failed agent it has had that its card no longer lists. A
 * failure the header counts always has its row.
 */
export const stageDrawn = (lanes: readonly AgentLane[], seen: readonly AgentLane[], now: number): AgentLane[] => {
  const drawn = heldLanes(lanes, now);
  const ids = new Set(drawn.map((l) => l.laneId));
  return [...drawn, ...seen.filter((l) => l.status === "failed" && !ids.has(l.laneId))];
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface Present<T> {
  readonly item: T;
  readonly key: string;
  /** Collapsing out; drawn in place until it is gone. */
  readonly leaving: boolean;
  /** Arrived in the latest change: it expands in. */
  readonly entering: boolean;
}

interface Gone<T> {
  readonly item: T;
  readonly key: string;
  readonly index: number;
}

/**
 * The items plus the ones that just left, each at its old index while it collapses for EXIT_MS. Rows there at
 * mount don't animate in; under reduce-motion nothing lingers.
 */
export const usePresence = <T,>(items: readonly T[], keyOf: (item: T) => string): Present<T>[] => {
  const keys = items.map(keyOf);
  const sig = keys.join("\u0000");
  const [prev, setPrev] = useState({ items, keys, sig });
  const [gone, setGone] = useState<readonly Gone<T>[]>([]);
  const [entered, setEntered] = useState<ReadonlySet<string>>(new Set());

  // What changed since the keys last changed, kept as state (React's "information from previous renders" pattern).
  // Only a change of keys counts: the items themselves are rebuilt on every render.
  if (prev.sig !== sig) {
    const now = new Set(keys);
    const before = new Set(prev.keys);
    const left = prev.keys.flatMap((key, index) => {
      const item = prev.items[index];
      return now.has(key) || item === undefined ? [] : [{ item, key, index }];
    });
    setPrev({ items, keys, sig });
    if (left.length > 0 && !reducedMotion()) setGone((g) => [...g.filter((x) => !now.has(x.key)), ...left]);
    const arrived = keys.filter((k) => !before.has(k));
    if (arrived.length > 0 || entered.size > 0) setEntered(new Set(arrived));
  }

  useEffect(() => {
    if (gone.length === 0) return;
    const done = new Set(gone);
    const t = window.setTimeout(() => setGone((g) => g.filter((x) => !done.has(x))), EXIT_MS + 20);
    return () => window.clearTimeout(t);
  }, [gone]);

  const out: Present<T>[] = items.map((item, i) => {
    const key = keys[i] ?? "";
    return { item, key, leaving: false, entering: entered.has(key) };
  });
  const shown = new Set(keys);
  for (const g of [...gone].sort((a, b) => a.index - b.index)) {
    if (!shown.has(g.key)) out.splice(Math.min(g.index, out.length), 0, { item: g.item, key: g.key, leaving: true, entering: false });
  }
  return out;
};
