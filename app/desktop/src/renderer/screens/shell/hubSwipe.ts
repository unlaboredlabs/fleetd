// The sidebar's swipe between hubs (W772), after Dia's spaces: two fingers left or right over the sidebar move its list
// with them, the next or previous hub's sliding in beside it, and on release it settles on the nearer one on a calm
// spring that never overshoots. A trackpad's swipe is wheel events with a horizontal delta. A gesture is the events
// with no pause of GAP_MS between them, and it picks one axis once it has moved DECIDE_PX: a scroll up or down the list
// stays one for good, its horizontal jitter and its momentum included. One gesture switches at most one hub: once it
// lets go (a pause, or its deltas dying away as the trackpad's momentum takes over after the fingers lift) the rest of
// it is swallowed until a pause. Past the first or the last hub the list gives a little and springs back; with one hub
// nothing happens at all. With reduced motion the list stays still and the hub switches once the swipe has gone far
// enough. The marks at the sidebar's foot and ⇧⌘[ / ⇧⌘] switch on the same slide (switchHub); the hub switcher's
// pick shows the hub at once, as it always has.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { showHub } from "./sidebarLayout";

/** A pause this long between wheel events ends a gesture. */
export const GAP_MS = 100;
/** How far a gesture moves before it picks its axis. */
export const DECIDE_PX = 6;
/** Its horizontal travel must beat its vertical by this much to be a swipe: the list scrolls far more often. */
const BIAS = 1.2;
/** Deltas falling this many times in a row, under FADE of their peak, are the momentum after the fingers lifted. */
const FALLS = 3;
const FADE = 0.6;
/** How far ahead of where it is let go a swipe looks to pick the nearer hub: a flick goes on. */
const PROJECT_MS = 90;
/** Past the end, the list gives at most this share of its width. */
const GIVE = 0.16;
/** With reduced motion, the share of the width a swipe goes before it switches. */
const REDUCED_AT = 0.25;
/** The spring's stiffness, critically damped (per ms): settled in about 280 ms from a standing start. */
const OMEGA = 0.024;

export type Phase = "idle" | "deciding" | "vertical" | "drag" | "drain";

export interface Gesture {
  readonly phase: Phase;
  /** The wheel's travel this gesture, as it scrolls: the list moves the other way (-x). */
  readonly x: number;
  readonly y: number;
  /** When its last event came (ms). */
  readonly at: number;
  /** How fast the list moves, px a ms. */
  readonly v: number;
  /** The largest horizontal delta so far, and the last, and how many times in a row they fell. */
  readonly peak: number;
  readonly last: number;
  readonly falls: number;
}

export const IDLE: Gesture = { phase: "idle", x: 0, y: 0, at: Number.NEGATIVE_INFINITY, v: 0, peak: 0, last: 0, falls: 0 };

export interface Wheel {
  readonly dx: number;
  readonly dy: number;
  readonly at: number;
}

export interface Step {
  readonly g: Gesture;
  /** The event is the swipe's: the list mustn't scroll with it. */
  readonly claim: boolean;
  /** The swipe lets go now: settle. */
  readonly release: boolean;
}

/** One wheel event through the gesture. */
export const wheel = (was: Gesture, e: Wheel): Step => {
  // A pause ends a gesture: whatever comes next starts a new one.
  const g = e.at - was.at > GAP_MS || was.phase === "idle" ? { ...IDLE, phase: "deciding" as const, at: e.at } : was;
  if (g.phase === "vertical") return { g: { ...g, at: e.at }, claim: false, release: false };
  if (g.phase === "drain") return { g: { ...g, at: e.at }, claim: true, release: false };
  if (g.phase === "deciding") {
    const x = g.x + e.dx;
    const y = g.y + e.dy;
    if (Math.abs(x) + Math.abs(y) < DECIDE_PX) return { g: { ...g, x, y, at: e.at }, claim: false, release: false };
    if (Math.abs(x) <= Math.abs(y) * BIAS) return { g: { ...g, phase: "vertical", x, y, at: e.at }, claim: false, release: false };
    const mag = Math.abs(x);
    return { g: { ...g, phase: "drag", x, y, at: e.at, v: 0, peak: mag, last: mag, falls: 0 }, claim: true, release: false };
  }
  // A drag: the list follows, and its deltas say when the fingers have lifted.
  const x = g.x + e.dx;
  const dt = Math.max(e.at - g.at, 4);
  const v = g.v === 0 ? -e.dx / dt : 0.6 * (-e.dx / dt) + 0.4 * g.v;
  const mag = Math.abs(e.dx);
  const falls = mag < g.last ? g.falls + 1 : 0;
  const peak = Math.max(g.peak, mag);
  const release = falls >= FALLS && mag < peak * FADE;
  return { g: { ...g, phase: release ? "drain" : "drag", x, y: g.y + e.dy, at: e.at, v, peak, last: mag, falls }, claim: true, release };
};

/** The gesture let go (a pause, or it switched already): the rest of it is swallowed. */
export const drained = (g: Gesture): Gesture => ({ ...g, phase: "drain" });

/**
 * Where the list is drawn for a swipe's travel `raw` (px, + to the right): with the fingers up to a whole width toward
 * a hub that is there, a little give toward one that isn't.
 */
export const shown = (raw: number, width: number, prev: boolean, next: boolean): number => {
  const there = raw > 0 ? prev : next;
  if (there) return Math.max(-width, Math.min(width, raw));
  const d = Math.abs(raw);
  const r = width * GIVE;
  return (Math.sign(raw) * d * r) / (r + d);
};

/** Where a swipe let go at `x` (px), moving `v` (px a ms), settles: -width on the next hub, +width on the previous, else 0. */
export const settleOn = (x: number, v: number, width: number, prev: boolean, next: boolean): number => {
  const ahead = x + v * PROJECT_MS;
  if (ahead <= -width / 2 && next) return -width;
  if (ahead >= width / 2 && prev) return width;
  return 0;
};

/** With reduced motion: the swipe has gone far enough to switch. */
export const farEnough = (raw: number, width: number): boolean => Math.abs(raw) >= width * REDUCED_AT;

/**
 * A critically damped spring's step toward `to`, `dt` ms on from `x` moving `v` (px a ms). It never passes its
 * target: where it would, it stops there.
 */
export const spring = (x: number, v: number, to: number, dt: number): { x: number; v: number; done: boolean } => {
  const y0 = x - to;
  const e = Math.exp(-OMEGA * dt);
  const k = v + OMEGA * y0;
  const y = (y0 + k * dt) * e;
  const nv = (v - OMEGA * k * dt) * e;
  if (y0 !== 0 && Math.sign(y) !== Math.sign(y0)) return { x: to, v: 0, done: true };
  // Its last pixel creeps for a long while, unseen: the hub it lands on is on show as soon as it is that close.
  const done = Math.abs(y) < 1.5 && Math.abs(nv) < 0.06;
  return { x: done ? to : to + y, v: done ? 0 : nv, done };
};

/** The hub `by` from `at` among `ids`, round the ends as ⌘[ / ⌘] go round the bots; null with one hub. */
export const stepHub = (ids: readonly string[], at: string, by: 1 | -1): string | null => {
  if (ids.length < 2) return null;
  const i = ids.indexOf(at);
  return ids[(Math.max(i, 0) + by + ids.length) % ids.length] ?? null;
};

/** A wheel event's deltas in px, whatever its unit. */
const px = (e: WheelEvent, page: number): { dx: number; dy: number } => {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page : 1;
  return { dx: e.deltaX * k, dy: e.deltaY * k };
};

const reduced = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The mounted sidebar's slide: to a hub, or `by` from the one it is on or on its way to; none while it is hidden. */
let slide: { readonly to: (hub: string) => void; readonly by: (by: 1 | -1) => void } | null = null;

/** Show `hub`, on the sidebar's slide while it shows. */
export const switchHub = (hub: string): void => (slide === null ? showHub(hub) : slide.to(hub));

/** Show the hub `by` from `at` among `ids` (stepHub), on the sidebar's slide while it shows: from the one it is on its way to. */
export const switchHubBy = (ids: readonly string[], at: string, by: 1 | -1): void => {
  if (slide !== null) return slide.by(by);
  const to = stepHub(ids, at, by);
  if (to !== null) showHub(to);
};

/** The hub beside the one on show while a swipe or a slide brings it: its place among the hubs, and its side (+1 right). */
export interface Beside {
  readonly to: number;
  readonly side: 1 | -1;
}

export interface SwipeOptions {
  /** What listens: the whole sidebar. */
  readonly area: RefObject<HTMLElement | null>;
  /** The list, whose width a whole swipe is. */
  readonly pane: RefObject<HTMLElement | null>;
  readonly hubs: readonly string[];
  /** The hub on show, among them. */
  readonly at: number;
  /** Draws the list `offset` px from its place, the hub beside it there too; called on every frame of a swipe. */
  readonly paint: (offset: number, beside: Beside | null, width: number) => void;
}

/**
 * The swipe over `area`: what it draws beside the list (null while nothing slides) and whether a swipe or a slide is
 * under way. Settling on a hub shows it (sidebarLayout.ts showHub), as the switcher does.
 */
export function useHubSwipe({ area, pane, hubs, at, paint }: SwipeOptions): { beside: Beside | null; moving: boolean } {
  const [beside, setBeside] = useState<Beside | null>(null);
  const [moving, setMoving] = useState(false);
  const g = useRef<Gesture>(IDLE);
  const offset = useRef(0);
  const width = useRef(0);
  // The hub the swipe stands on: the one switched to as soon as it is, before the sidebar has drawn it.
  const here = useRef(at);
  const near = useRef<Beside | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0);
  // A settle on the way: where to, and the hub it lands on there (null: back where it was).
  const settling = useRef<{ to: number; hub: number | null; v: number; t: number } | null>(null);
  // `at` is the hub the sidebar has drawn, which the layout effect below keeps in step.
  const live = useRef({ hubs, paint, at });
  useLayoutEffect(() => {
    live.current = { hubs, paint, at };
  });

  const draw = useCallback(() => live.current.paint(offset.current, near.current, width.current), []);
  const place = useCallback((b: Beside | null) => {
    if (near.current?.to === b?.to && near.current?.side === b?.side) return;
    near.current = b;
    setBeside(b);
  }, []);

  /**
   * Lands on `hub`: shows it, and the sidebar draws it in place (the layout effect below). Back where it was, or on the
   * hub the sidebar has drawn (a slide landed and another took it straight back, before React drew the first), the
   * hub on show doesn't change, so it is drawn in place here.
   */
  const land = useCallback(
    (hub: number | null) => {
      settling.current = null;
      cancelAnimationFrame(frame.current);
      const id = hub === null ? undefined : live.current.hubs[hub];
      if (id !== undefined) {
        here.current = hub ?? here.current;
        showHub(id);
      }
      if (id !== undefined && hub !== live.current.at) return;
      offset.current = 0;
      place(null);
      draw();
      setMoving(false);
    },
    [draw, place],
  );

  const run = useCallback(
    (to: number, hub: number | null, v: number) => {
      settling.current = { to, hub, v, t: performance.now() };
      cancelAnimationFrame(frame.current);
      const tick = (now: number) => {
        const s = settling.current;
        if (s === null) return;
        const next = spring(offset.current, s.v, s.to, Math.min(Math.max(now - s.t, 0), 48));
        offset.current = next.x;
        s.v = next.v;
        s.t = now;
        draw();
        if (next.done) land(s.hub);
        else frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    },
    [draw, land],
  );

  /** The gesture lets go: the nearer hub, on the spring. */
  const release = useCallback(() => {
    clearTimeout(timer.current);
    const n = live.current.hubs.length;
    const to = settleOn(offset.current, g.current.v, width.current, here.current > 0, here.current < n - 1);
    run(to, to === 0 ? null : here.current + (to < 0 ? 1 : -1), g.current.v);
  }, [run]);

  /** Whatever was on its way ends where it was going, at once. */
  const finish = useCallback(() => {
    const s = settling.current;
    if (s !== null) land(s.hub);
  }, [land]);

  // Every wheel event over the sidebar, before the list scrolls with it.
  useEffect(() => {
    const el = area.current;
    if (el === null || hubs.length < 2) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      const w = pane.current?.clientWidth ?? 0;
      const { dx, dy } = px(e, w);
      const was = g.current.phase;
      const step = wheel(g.current, { dx, dy, at: performance.now() });
      g.current = step.g;
      if (!step.claim) return;
      e.preventDefault();
      if (step.g.phase !== "drag" && !step.release) return;
      if (was !== "drag") {
        // A new swipe: one still settling lands first.
        finish();
        width.current = w;
        setMoving(true);
      }
      const n = live.current.hubs.length;
      const prev = here.current > 0;
      const next = here.current < n - 1;
      const raw = -step.g.x;
      if (reduced()) {
        if (farEnough(raw, w) && (raw > 0 ? prev : next)) {
          g.current = drained(step.g);
          clearTimeout(timer.current);
          land(here.current + (raw > 0 ? -1 : 1));
        } else if (step.release) {
          g.current = drained(step.g);
          land(null);
        } else {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            g.current = drained(g.current);
            land(null);
          }, GAP_MS);
        }
        return;
      }
      offset.current = shown(raw, w, prev, next);
      const side = raw > 0 ? -1 : 1;
      place((side < 0 ? prev : next) && raw !== 0 ? { to: here.current + side, side } : null);
      draw();
      if (Math.abs(offset.current) >= w && w > 0) {
        // All the way across: on that hub now, and the rest of the gesture is spent.
        g.current = drained(step.g);
        clearTimeout(timer.current);
        land(here.current + side);
      } else if (step.release) release();
      else {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          // A pause: the fingers stood still, so the list is let go standing still too.
          g.current = { ...drained(g.current), v: 0 };
          release();
        }, GAP_MS);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [area, pane, hubs.length, draw, place, land, release, finish]);

  // The hub on show changed (a swipe landed, or any other switch): drawn in place, unless a new swipe is already moving.
  useLayoutEffect(() => {
    here.current = at;
    if (g.current.phase === "drag" || settling.current !== null) return;
    offset.current = 0;
    near.current = null;
    setBeside(null);
    setMoving(false);
    draw();
  }, [at, draw]);
  // The hub beside it has come or gone: drawn where the swipe has it.
  useLayoutEffect(draw, [beside, draw]);

  // The marks and the shortcut slide too, while the sidebar shows.
  useEffect(() => {
    const go = (to: number) => {
      if (to < 0 || (to === here.current && settling.current === null)) return;
      const w = pane.current?.clientWidth ?? 0;
      if (g.current.phase === "drag" || settling.current !== null || reduced() || w === 0) {
        // Mid-swipe, or still: straight there.
        finish();
        clearTimeout(timer.current);
        g.current = drained(g.current);
        land(to);
        return;
      }
      const side = to > here.current ? 1 : -1;
      width.current = w;
      offset.current = 0;
      place({ to, side });
      setMoving(true);
      run(-side * w, to, 0);
    };
    slide = {
      to: (hub) => go(live.current.hubs.indexOf(hub)),
      by: (by) => {
        const n = live.current.hubs.length;
        if (n < 2) return;
        go(((settling.current?.hub ?? here.current) + by + n) % n);
      },
    };
    return () => {
      slide = null;
    };
  }, [pane, finish, land, place, run]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  return { beside, moving };
}
