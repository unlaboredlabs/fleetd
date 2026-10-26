// Rows leaving a list (ui/DESIGN.md): a removed row stays where it was for one quick fade, then goes and the gap closes.
// `useLeavers` gives the list's items with the ones just removed put back at their old places, marked leaving; the
// list draws those inside `[data-leaving]` (base.css), inert. Nothing waits on the fade: its row goes after LEAVE_MS.
import { useEffect, useState } from "react";

/** How long a leaving row fades before it goes: --dur-quick. */
export const LEAVE_MS = 140;

export interface Shown<T> {
  readonly item: T;
  readonly leaving: boolean;
}

interface Gone<T> {
  readonly item: T;
  readonly index: number;
}

/** `next` with the items of `prev` it no longer has, and those still leaving, put back at their old places. */
export function withLeavers<T>(next: readonly T[], gone: readonly Gone<T>[]): Shown<T>[] {
  const out: Shown<T>[] = next.map((item) => ({ item, leaving: false }));
  for (const g of [...gone].sort((a, b) => a.index - b.index)) out.splice(Math.min(g.index, out.length), 0, { item: g.item, leaving: true });
  return out;
}

/** What left between `prev` and `next`, with where each was, plus what was leaving already and hasn't come back. */
export function leavers<T>(prev: readonly T[], next: readonly T[], keyOf: (item: T) => string, already: readonly Gone<T>[] = []): Gone<T>[] {
  const keys = new Set(next.map(keyOf));
  const left = prev.flatMap((item, index) => (keys.has(keyOf(item)) ? [] : [{ item, index }]));
  const leftKeys = new Set(left.map((g) => keyOf(g.item)));
  return [...already.filter((g) => !keys.has(keyOf(g.item)) && !leftKeys.has(keyOf(g.item))), ...left];
}

/**
 * `items` with what just left them fading in place. `view` names what the list shows (its project, scope, filter): when
 * it changes, the rows that go weren't removed, the view moved, so nothing fades.
 */
export function useLeavers<T>(items: readonly T[] | undefined, keyOf: (item: T) => string, view = ""): Shown<T>[] | undefined {
  const [seen, setSeen] = useState<{ readonly items: readonly T[] | undefined; readonly view: string; readonly gone: readonly Gone<T>[] }>({ items, view, gone: [] });
  // A new list: what it dropped starts leaving (React's pattern for state from the previous render).
  if (seen.items !== items || seen.view !== view) {
    const prev = seen.items;
    const moved = seen.view !== view || prev === undefined || items === undefined;
    setSeen({ items, view, gone: moved ? [] : leavers(prev, items, keyOf, seen.gone) });
  }
  const { gone } = seen;
  useEffect(() => {
    if (gone.length === 0) return undefined;
    const timer = window.setTimeout(() => setSeen((s) => (s.gone === gone ? { ...s, gone: [] } : s)), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [gone]);
  return items === undefined ? undefined : withLeavers(items, seen.items === items && seen.view === view ? gone : []);
}
