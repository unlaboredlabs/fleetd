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
// What a person does that takes the page over from a reveal still holding its place.
const TAKEN = ["wheel", "pointerdown", "keydown", "touchstart"] as const;

/**
 * Marks an option's element: when a search opens this option, it scrolls into view and its first control takes focus.
 * `whole` marks a part of a page (Frames.tsx's Part) instead: it comes to the top and takes the focus itself, so
 * arriving there never leaves Enter on one of its buttons. What is over it may still be loading and push it down as it
 * arrives (Every project's profiles, over its MCP servers and skills): it is brought back each time the page around it
 * changes size, until the person scrolls, clicks or types.
 */
export function useReveal<T extends HTMLElement>(key: string, whole = false) {
  const ref = useRef<T>(null);
  const want = useSyncExternalStore(subscribe, () => wanted);
  useEffect(() => {
    const el = ref.current;
    if (want !== key || el === null) return undefined;
    wanted = null;
    const show = () => el.scrollIntoView({ block: whole ? "start" : "nearest" });
    show();
    ((whole ? null : el.querySelector<HTMLElement>(FOCUSABLE)) ?? el).focus({ preventScroll: true });
    if (typeof ResizeObserver === "undefined") return undefined;
    const held = new ResizeObserver(show);
    for (let up = el.parentElement; up !== null && up !== document.body; up = up.parentElement) held.observe(up);
    const release = () => {
      held.disconnect();
      for (const type of TAKEN) window.removeEventListener(type, release, true);
    };
    for (const type of TAKEN) window.addEventListener(type, release, { capture: true, passive: true });
    return release;
  }, [want, key, whole]);
  return ref;
}
