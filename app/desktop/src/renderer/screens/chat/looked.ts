// A message the lead nudged you about (or an agent's Try it line) stops waiting once you have seen it: once half of
// it, or half the window's height of it, has stayed in view for a moment while the window has focus. A row the list
// passes on its way to where it opens doesn't count; one that scrolled into view while you were elsewhere counts once
// you come back to it and it is still there.
import { useEffect, type RefObject } from "react";
import { useBubbleActions } from "./actions";

/** How long it stays in view, the window focused, to count as seen. */
export const LOOK_MS = 1000;

/** Steps fine enough that a message many times the window's height still reports half a window of it. */
const STEPS = Array.from({ length: 21 }, (_, n) => n / 20);

/** Tells the chat once `id`'s element, while its nudge waits, has been seen. */
export function useLooked(ref: RefObject<HTMLElement | null>, id: string): void {
  const actions = useBubbleActions();
  const waiting = actions?.lookAt?.has(id) === true;
  const seen = actions?.seen;
  useEffect(() => {
    const el = ref.current;
    if (!waiting || el === null || seen === undefined || typeof IntersectionObserver === "undefined") return;
    let inView = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const looking = inView && document.hasFocus();
      if (!looking) {
        clearTimeout(timer);
        timer = undefined;
      } else timer ??= setTimeout(() => seen(id), LOOK_MS);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const view = e.rootBounds?.height ?? window.innerHeight;
          inView = e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= view / 2);
        }
        check();
      },
      { threshold: STEPS },
    );
    io.observe(el);
    window.addEventListener("focus", check);
    window.addEventListener("blur", check);
    return () => {
      clearTimeout(timer);
      io.disconnect();
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", check);
    };
  }, [ref, id, waiting, seen]);
}
