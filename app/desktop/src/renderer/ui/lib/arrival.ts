// Whether a list's row has just arrived, so it may enter (fade and rise once): not on the list's first showing, not
// again when a virtual list remounts it on scroll, only the first time its key is seen after the list was up.
import { useState } from "react";

const SETTLE_MS = 400;
const lists = new Map<string, { readonly since: number; readonly seen: Set<string> }>();

export function arrived(list: string, key: string, now = performance.now()): boolean {
  let at = lists.get(list);
  if (at === undefined) {
    at = { since: now, seen: new Set() };
    lists.set(list, at);
  }
  if (at.seen.has(key)) return false;
  at.seen.add(key);
  return now - at.since > SETTLE_MS;
}

/** `arrived`, fixed for the row's life: a re-render doesn't play it again. */
export const useArrived = (list: string, key: string): boolean => useState(() => arrived(list, key))[0];
