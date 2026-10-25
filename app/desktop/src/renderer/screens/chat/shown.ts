// Show's mark on what the lead waits on: the bubble or card it went to takes a soft ring that fades (view.module.css
// .waited), and focus, so a keyboard or a screen reader is there too. The row mounts as the list scrolls to it, so
// the mark goes on as it mounts; one remounted while the ring fades picks it up where it was.
import { useEffect, useRef, type RefObject } from "react";
import type { WaitTarget } from "./attentionModel";

/** Where a waiting Show last went: the press (`n`) and when (`at`), for the ring as it fades. */
export interface ShownMark extends WaitTarget {
  readonly n: number;
  readonly at: number;
}

/** How long the ring takes to fade (tokens.css --dur-shown). */
export const SHOWN_MS = 2000;

/** `mark` when it names this bubble, or this item's card (no part). */
export const markOf = (mark: ShownMark | undefined, id: string, part?: string): ShownMark | undefined =>
  mark !== undefined && mark.id === id && mark.part === part ? mark : undefined;

/**
 * Marks the element while its ring fades and focuses it once per press: `inside`, the card in it that takes focus
 * itself (an approval's keys work while focus is in it).
 */
export function useShown<T extends HTMLElement>(mark: ShownMark | undefined, inside = false): RefObject<T | null> {
  const ref = useRef<T>(null);
  const n = mark?.n;
  const at = mark?.at;
  useEffect(() => {
    const el = ref.current;
    if (el === null || n === undefined || at === undefined) return;
    const since = Date.now() - at;
    if (since >= SHOWN_MS) return;
    // The list centres it; focus mustn't scroll it again.
    ((inside ? el.querySelector<HTMLElement>("[tabindex='-1']") : null) ?? el).focus({ preventScroll: true });
    el.style.setProperty("--shown-since", `${String(since)}ms`);
    // Two names, so a second press on the same bubble starts the ring again.
    el.dataset["shown"] = String(n % 2);
    const done = setTimeout(() => delete el.dataset["shown"], SHOWN_MS - since);
    return () => {
      clearTimeout(done);
      delete el.dataset["shown"];
    };
  }, [n, at, inside]);
  return ref;
}
