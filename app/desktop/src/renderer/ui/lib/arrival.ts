// Whether a list's row has just arrived, so it may enter once (DESIGN.md). A list registers every key it holds as it
// renders (`useArrivals`): the keys of its first render are known, never new, and so is any key a virtual list only
// mounts later on scroll. A key that turns up in a later render is new, once: the first time its row mounts.
import { useState } from "react";

const lists = new Map<string, { readonly known: Set<string>; readonly fresh: Set<string> }>();

/** Registers what `list` holds now; keys it didn't hold before are new. */
export function noteKeys(list: string, keys: readonly string[]): void {
  const at = lists.get(list);
  if (at === undefined) {
    lists.set(list, { known: new Set(keys), fresh: new Set() });
    return;
  }
  for (const k of keys) {
    if (at.known.has(k)) continue;
    at.known.add(k);
    at.fresh.add(k);
  }
}

/** Whether `key` is new to `list`; true once, for the row's first mount. */
export function arrived(list: string, key: string): boolean {
  const at = lists.get(list);
  if (at === undefined || !at.fresh.has(key)) return false;
  at.fresh.delete(key);
  return true;
}

/**
 * `noteKeys` as the list renders (every render: it only adds what it hasn't seen, so it is cheap and repeatable);
 * nothing while the list has nothing loaded yet (undefined), so its first rows aren't new.
 */
export const useArrivals = (list: string, keys: readonly string[] | undefined): void => {
  if (keys !== undefined) noteKeys(list, keys);
};

/** `arrived`, fixed for the row's life: a re-render doesn't play it again. */
export const useArrived = (list: string, key: string): boolean => useState(() => arrived(list, key))[0];
