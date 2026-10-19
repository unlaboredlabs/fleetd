import { useEffect, useRef, useState } from "react";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { asGetOutput, type StatusScope } from "./contracts";
import { hubNow, Looked, type StatusRead } from "./session";
import { nextAgeChange } from "./view";

/** The scope's doc through the data layer: one status_get query, refetched when an event makes it stale. Leaving the
 * view records the look (status_seen) if it lasted. Pass a scope that keeps its identity while it means the same. */
export const useStatus = (scope: StatusScope): StatusRead & { readonly retry: () => void } => {
  const layer = useDataLayer();
  const fresh = useData((s) => s.fresh);
  const query = useToolQuery("status_get", { scope });
  const out = query.data === undefined ? undefined : asGetOutput(query.data);
  const error =
    query.error !== null ? query.error.message : query.data !== undefined && out === undefined ? "the hub's answer didn't match this app's contracts" : null;

  // The mark goes out with the seq the reader actually saw, so keep the latest one for the cleanup.
  const seq = useRef<number | undefined>(undefined);
  const seen = out?.doc.seq;
  useEffect(() => {
    seq.current = seen;
  }, [seen]);
  useEffect(() => {
    const looked = new Looked();
    const track = (): void => looked.set(document.visibilityState === "visible" && document.hasFocus(), Date.now());
    track();
    window.addEventListener("focus", track);
    window.addEventListener("blur", track);
    document.addEventListener("visibilitychange", track);
    return () => {
      window.removeEventListener("focus", track);
      window.removeEventListener("blur", track);
      document.removeEventListener("visibilitychange", track);
      const at = seq.current;
      // A missed mark only means a longer "since" next time, so this is fire-and-forget.
      if (looked.take(Date.now()) && at !== undefined && layer.store.getState().fresh) void layer.call("status_seen", { scope, seq: at });
    };
  }, [layer, scope]);

  return { doc: out?.doc, receivedMs: query.dataUpdatedAt, fresh, error, retry: () => void query.refetch() };
};

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): () => void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/** Arms the one age timer from the REAL clock now, to the next moment an on-screen age reads differently. It must
 * not use the clock of the last paint: every new answer re-arms it, and a delay measured from a stale clock would be
 * pushed out each time and never fire, freezing "stale 12m" on a live view. */
export const armAgeRedraw = (read: StatusRead, ages: (now: number) => number[], timers: Timers, redraw: () => void): (() => void) => {
  const wait = nextAgeChange(ages(hubNow(read, timers.now())));
  // +50 ms so the redraw lands after the boundary, not just before it.
  return wait === null ? () => undefined : timers.set(redraw, wait + 50);
};

/** The hub's clock, redrawn only when an age on screen would read differently (at most once a minute). Between
 * redraws it is the clock of the last paint; a new doc carries the hub's own `now`. */
export const useHubNow = (read: StatusRead, ages: (now: number) => number[]): number => {
  const [local, setLocal] = useState(() => Date.now());
  useEffect(() => armAgeRedraw(read, ages, realTimers, () => setLocal(Date.now())), [read, ages, local]);
  return hubNow(read, local);
};

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The number and bar move together over 400 ms, only on a real change while live. The first paint (the hero mounts
 * fresh after a skeleton or a scope switch), a not-live doc and reduce-motion all draw the end state. Idle, nothing
 * runs. */
export const useTween = (target: number, live: boolean): number => {
  const [shown, setShown] = useState(target);
  const last = useRef(target);
  useEffect(() => {
    const from = last.current;
    last.current = target;
    if (!live || from === target || reducedMotion()) {
      setShown(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(t) {
      const k = Math.min(1, (t - start) / 400);
      const eased = 1 - (1 - k) ** 3;
      setShown(from + (target - from) * eased);
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, live]);
  return !live || reducedMotion() ? target : shown;
};
