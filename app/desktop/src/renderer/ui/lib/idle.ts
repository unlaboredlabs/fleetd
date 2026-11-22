// What may wait until the app has shown itself: a chunk the first chat doesn't draw (Shiki's highlighter, Settings)
// loads once the first frame is out and the thread is idle, so it never competes with the start for the network or
// the main thread, and is in place before anyone opens it.
import { lazy, useEffect, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from "react";

/**
 * How long a preload waits for markShown before going ahead anyway (a screen that never calls it). Long: on a slow
 * link the chat takes many seconds to show, and a preload let go before it shares the link with it (Settings' 90 KB
 * held a 256 kbit/s first chat back ~4 s).
 */
export const SHOWN_WAIT_MS = 30_000;

let shown: () => void = () => undefined;
const shownOnce = new Promise<void>((resolve) => (shown = resolve));
let isShown = false;
const shownListeners = new Set<() => void>();

/** The app has drawn what it opened on: the chat's first messages (ChatScreen says so). */
export const markShown = (): void => {
  if (isShown) return;
  isShown = true;
  shown();
  for (const l of shownListeners) l();
};

/**
 * Whether the app has drawn what it opened on (markShown), or `capMs` has passed since the caller mounted: a part
 * beside the first screen (the web's side panel) waits on it to ask for its code, so it never competes with the chat.
 */
export const useShownYet = (capMs: number): boolean => {
  const marked = useSyncExternalStore(
    (l) => {
      shownListeners.add(l);
      return () => shownListeners.delete(l);
    },
    () => isShown,
  );
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    if (marked) return;
    const t = setTimeout(() => setCapped(true), capMs);
    return () => clearTimeout(t);
  }, [marked, capMs]);
  return marked || capped;
};

/** After the next frame and an idle moment (a second at most); without frames (a hidden tab), once they come back. */
const nextIdle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") return resolve();
    requestAnimationFrame(() => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 1000 });
      else setTimeout(resolve, 0);
    });
  });

let painted: Promise<void> | undefined;

/** Settles once, at the next frame and idle moment from its first call: the first paint of what called it. */
export const afterFirstPaint = (): Promise<void> => (painted ??= nextIdle());

export type Preloadable<P> = LazyExoticComponent<ComponentType<P>> & {
  /** Loads the component's chunk now; renders after it never suspend. */
  readonly preload: () => Promise<ComponentType<P>>;
};

/**
 * React's lazy() with a preload. A plain lazy suspends on its first render even when its chunk is already loaded, and
 * React then holds the screen's reveal back ~300 ms; this one hands React the loaded component at once, so a screen
 * preloaded before it opens shows on the next frame.
 */
export function preloadable<P>(load: () => Promise<ComponentType<P>>): Preloadable<P> {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = () =>
    (loading ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        // A failed load (offline, a new build's names) is tried again by the next render or preload.
        loading = undefined;
        throw e;
      },
    ));
  const component = lazy(() => {
    const ready = loaded;
    // Settled in the same call: React reads a lazy that resolves synchronously as loaded, with no suspense.
    if (ready !== undefined)
      return {
        then: (done: (m: { default: ComponentType<P> }) => void) => done({ default: ready }),
      } as Promise<{ default: ComponentType<P> }>;
    return preload().then((c) => ({ default: c }));
  });
  return Object.assign(component, { preload });
}

/**
 * Preloads each once the app has shown what it opened on (markShown, or SHOWN_WAIT_MS) and is idle, ignoring a failure
 * (the render that needs it tries again).
 */
export const preloadWhenIdle = (...each: ReadonlyArray<{ readonly preload: () => Promise<unknown> }>): void =>
  afterShown(() => {
    for (const p of each) p.preload().catch(() => undefined);
  });

/** Runs `fn` once the app has shown what it opened on (markShown, or SHOWN_WAIT_MS) and is idle. */
export const afterShown = (fn: () => void): void =>
  void Promise.race([shownOnce, new Promise((resolve) => setTimeout(resolve, SHOWN_WAIT_MS))])
    .then(nextIdle)
    .then(fn);
