// The reveal behind Settings search and links into Settings: a one-shot "focus this option" that the page showing it
// takes up when it renders. Small, so a link from elsewhere in the app (the New screen picker's fix) needn't load
// search's catalog.
import { useEffect, useRef, useSyncExternalStore } from "react";

// The option to reveal once its page shows it.
let wanted: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The next page to show the element marked `key` (useReveal) scrolls to it and focuses it. */
export function revealNext(key: string | null) {
  wanted = key;
  for (const l of listeners) l();
}

const FOCUSABLE = 'input, textarea, button:not([disabled]), [role="slider"]';

/** Marks an option's element: when a search opens this option, it scrolls into view and its first control takes focus. */
export function useReveal<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  const want = useSyncExternalStore(subscribe, () => wanted);
  useEffect(() => {
    const el = ref.current;
    if (want !== key || el === null) return;
    wanted = null;
    el.scrollIntoView({ block: "nearest" });
    (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus({ preventScroll: true });
  }, [want, key]);
  return ref;
}
