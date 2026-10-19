import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { StatusScope } from "./contracts";
import { statusController } from "./controller";
import { hubNow, Looked, type StatusSession } from "./session";
import { nextAgeChange } from "./view";

/** Opens the window's one Status session on `scope` while mounted; leaving records the look if it counted. Pass a
 * scope that keeps its identity while it means the same thing (one per route). */
export const useStatusSession = (scope: StatusScope): StatusSession => {
  const controller = statusController();

  useEffect(() => {
    const looked = new Looked();
    const track = (): void => looked.set(document.visibilityState === "visible" && document.hasFocus(), Date.now());
    controller.open(scope);
    track();
    window.addEventListener("focus", track);
    window.addEventListener("blur", track);
    document.addEventListener("visibilitychange", track);
    return () => {
      window.removeEventListener("focus", track);
      window.removeEventListener("blur", track);
      document.removeEventListener("visibilitychange", track);
      controller.close(looked.take(Date.now()));
    };
  }, [controller, scope]);

  return useSyncExternalStore(controller.subscribe, () => controller.state);
};

/** The hub's clock, redrawn only when an age on screen would read differently (at most once a minute). Between
 * redraws it is the clock of the last paint; a new doc carries the hub's own `now`. */
export const useHubNow = (session: StatusSession, ages: (now: number) => number[]): number => {
  const [local, setLocal] = useState(() => Date.now());
  const now = hubNow(session, local);
  const wait = nextAgeChange(ages(now));
  useEffect(() => {
    if (wait === null) return;
    // +50 ms so the redraw lands after the boundary, not just before it.
    const id = setTimeout(() => setLocal(Date.now()), wait + 50);
    return () => clearTimeout(id);
  }, [wait, session]);
  return now;
};

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The number and bar move together over 400 ms, only on a real change within one live session. The first paint,
 * a paint after a skeleton, a scope switch and reduce-motion all draw the end state. Idle, nothing runs. */
export const useTween = (target: number, session: string): number => {
  const [shown, setShown] = useState(target);
  const last = useRef({ target, session });
  useEffect(() => {
    const prev = last.current;
    last.current = { target, session };
    if (prev.session !== session || prev.target === target || reducedMotion()) {
      setShown(target);
      return;
    }
    const from = prev.target;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(t) {
      const k = Math.min(1, (t - start) / 400);
      const eased = 1 - (1 - k) ** 3;
      setShown(from + (target - from) * eased);
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, session]);
  // A new session draws its end state in the very first paint, not one frame later.
  return last.current.session !== session || reducedMotion() ? target : shown;
};
