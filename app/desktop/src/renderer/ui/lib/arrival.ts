// Whether a list's row has just arrived, so it may enter once (ui/DESIGN.md). A list registers the keys it holds each
// time it renders (`useArrivals`). What it holds when first shown (a tab opened or reopened, another project) is
// known, never new; a key that turns up later is new for a moment, and its row enters if it mounts within that moment.
// A row a virtual list mounts later, on scroll, or a long while after its key came, is shown still. A list's record
// keeps only the keys it holds now, and goes when the list unmounts.
import { useEffect, useState } from "react";

/** How long after its key arrives a row may still enter. */
export const FRESH_MS = 1000;

interface Record {
  known: ReadonlySet<string>;
  readonly fresh: Map<string, number>;
}

const lists = new Map<string, Record>();

/** Registers what `list` holds now: keys it didn't hold before are new; keys gone are forgotten. */
export function noteKeys(list: string, keys: readonly string[], now = Date.now()): void {
  const at = lists.get(list);
  if (at === undefined) {
    lists.set(list, { known: new Set(keys), fresh: new Map() });
    return;
  }
  const next = new Set(keys);
  for (const k of next) if (!at.known.has(k)) at.fresh.set(k, now);
  for (const [k, since] of at.fresh) if (!next.has(k) || now - since > FRESH_MS) at.fresh.delete(k);
  at.known = next;
}

/** Whether `key` is new to `list` and its row may enter now; true once, for the row's first mount. */
export function arrived(list: string, key: string, now = Date.now()): boolean {
  const at = lists.get(list);
  const since = at?.fresh.get(key);
  if (at === undefined || since === undefined) return false;
  at.fresh.delete(key);
  return now - since <= FRESH_MS;
}

/** Drops `list`'s record: shown again, it starts from what it holds. */
export const forgetList = (list: string): void => {
  lists.delete(list);
};

/**
 * `noteKeys` as the list renders (cheap and repeatable: it compares sets); nothing while the list has nothing loaded
 * yet (undefined), so its first rows aren't new. The record goes when the list unmounts or becomes another list.
 */
export const useArrivals = (list: string, keys: readonly string[] | undefined): void => {
  useEffect(() => () => forgetList(list), [list]);
  if (keys !== undefined) noteKeys(list, keys);
};

/** `arrived`, fixed for the row's life: a re-render doesn't play it again. */
export const useArrived = (list: string, key: string): boolean => useState(() => arrived(list, key))[0];
