// Show's mark on what the lead waits on: the bubble or card it went to takes a soft ring that fades (view.module.css
// .waited), and focus once, so a keyboard or a screen reader is there too. The row mounts as the list scrolls to it,
// so the mark goes on as it mounts; one remounted while the ring fades picks it up where it was, without taking the
// focus back. Once faded it is a plain bubble again: no ring, and no longer focusable once focus has left it.
import { useEffect, useState, type RefObject } from "react";
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

// By press (a mark is one object per press, ChatScreen's): focus went to it, and its mark is over. Across mounts,
// as the list drops and remounts rows.
const focused = new WeakSet<ShownMark>();
const over = new WeakSet<ShownMark>();

/**
 * The mark on `ref`'s element, on while it rings or holds the focus it was given. Focuses it once per press; `inside`,
 * the card in it that takes focus itself (an approval's keys work while focus is in it).
 */
export function useShown(ref: RefObject<HTMLElement | null>, mark: ShownMark | undefined, inside = false): boolean {
  const [, ended] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null || mark === undefined || over.has(mark)) return;
    if (!focused.has(mark)) {
      focused.add(mark);
      // The list centres it; focus mustn't scroll it again.
      ((inside ? el.querySelector<HTMLElement>("[tabindex='-1']") : null) ?? el).focus({ preventScroll: true });
    }
    const since = Date.now() - mark.at;
    if (since < SHOWN_MS) {
      el.style.setProperty("--shown-since", `${String(since)}ms`);
      // Two names, so a second press on the same bubble starts the ring again.
      el.dataset["shown"] = String(mark.n % 2);
    }
    const end = () => {
      over.add(mark);
      ended((n) => n + 1);
    };
    // Faded: the mark goes, but not from under the focus (that would drop it to the page); then once focus leaves.
    const fade = setTimeout(
      () => {
        delete el.dataset["shown"];
        if (el.contains(document.activeElement)) el.addEventListener("focusout", end, { once: true });
        else end();
      },
      Math.max(0, SHOWN_MS - since),
    );
    return () => {
      clearTimeout(fade);
      el.removeEventListener("focusout", end);
      delete el.dataset["shown"];
    };
  }, [ref, mark, inside]);
  return mark !== undefined && !over.has(mark);
}
