// The sidebar's swipe between hubs (W772, W777), after Dia's spaces: two fingers left or right over the sidebar move
// its list with them, the next or previous hub's sliding in beside it, and when they lift it settles on the nearer one
// on a calm spring that never overshoots. A trackpad's swipe is wheel events with a horizontal delta, and they keep
// coming after the fingers lift, a second or more of momentum dying away. A gesture is one touch of the fingers, from
// down to up, and the glide after it; it picks one axis once it has moved DECIDE_PX: a scroll up or down the list stays
// one for good, its sideways drift included, and is never swallowed. One gesture switches at most one hub: its glide
// never moves the list, and once it has gone all the way across the rest of it is spent. The next touch is a new
// gesture at once, its glide still arriving or not, the pointer never moved.
//
// Where a touch begins, Chromium on a Mac says, from the trackpad's own phases: the first wheel event of each touch is
// the only one it makes cancelable (its glide's never are), so long as the page never cancels that first one, which
// the swipe never does. Where the fingers lift it says too (W813): the glide's events are WheelEvent.momentum, so the
// list follows the fingers 1:1 until the first of them, and settles from there at once. Fingers that stop before they
// lift send no glide and no event at all: after REST_MS still the list settles, and if they move again it is theirs
// again, from wherever the spring has it, as a touch on a settling list takes it up. Without momentum (an older
// Chromium) the deltas tell: once a swipe's events have shrunk FALLS times in a row under FADE of its largest, or after
// a pause (LIFT_MS there, as a pause doesn't end a touch). Elsewhere (Linux, Safari, Firefox), where a cancelable event says nothing,
// the deltas tell where a touch begins too: after a pause of GAP_MS, and in a glide, which only ever slows on in one
// direction, an event that turns back or turns to the other axis, or events growing twice running, are fingers that
// touched again; a run sideways that begins on a pause in a glide and only shrinks is that glide, and springs back.
// Both go through wheel below.
//
// Past the first or the last hub the list stretches as macOS's own lists do and springs back from there, at the speed it
// was going; with one hub nothing happens at all. With
// reduced motion the list stays still and the hub switches once the swipe has gone far enough. The marks at the
// sidebar's foot and ⇧⌘[ / ⇧⌘] switch on the same slide (switchHub); the hub switcher's pick shows the hub at once, as
// it always has, a slide on its way included. Whichever way, landing on a hub opens it (sidebarLayout.ts openHub): the
// screen changes with the list, to that hub's last chat.
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type MouseEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { openHub } from "./sidebarLayout";

declare global {
  interface WheelEvent {
    /** Chromium's: the event is a trackpad's glide after the fingers lifted (WheelEventMomentum). Not in TypeScript's DOM yet. */
    readonly momentum?: boolean;
  }
}

/** A pause this long between wheel events lets a swipe go, and without the platform's word ends a gesture. */
export const GAP_MS = 100;
/**
 * With it, a pause doesn't end a touch (the next one says so), so only this long a one lets a swipe go: fingers that
 * stopped and lifted with no glide. A busy Mac can hand the page a touch's events 300 ms apart.
 */
export const LIFT_MS = 400;
/** With the platform's word on the lift too, fingers still this long have most likely lifted: the list settles. */
export const REST_MS = 80;
/** How far a gesture moves before it picks its axis. */
export const DECIDE_PX = 6;
/** Its horizontal travel must beat its vertical by this much to be a swipe: the list scrolls far more often. */
const BIAS = 1.2;
/**
 * Events shrinking this many times in a row, under FADE of the largest, are the glide after the fingers lifted. Their
 * sizes, which the trackpad measured, not their speeds: a busy machine hands them over late and unevenly.
 */
const FALLS = 3;
const FADE = 0.6;
/**
 * In a glide, events growing twice running to RISE times its smallest (and RISE_PX on) are fingers again: a glide's
 * events only shrink, and one handed over late is a lump of several, which the next one doesn't outgrow.
 */
const RISE = 2;
const RISE_PX = 1;
/** Without the platform's word, a swipe whose first this many events only shrink is momentum: it lets go. */
const FIRST = 3;
/** The time a gesture's first event is taken to span (ms), as a trackpad sends them. */
const FRAME_MS = 16;
/** How far ahead of where it is let go a swipe looks to pick the nearer hub: a flick goes on. */
const PROJECT_MS = 90;
/** Past the end, the list stretches as macOS's rubber band does: (1 - 1 / (d * BAND / w + 1)) * w for d px of travel. */
const BAND = 0.55;
/** With reduced motion, the share of the width a swipe goes before it switches. */
const REDUCED_AT = 0.25;
/** The spring's stiffness, critically damped (per ms): settled in about 280 ms from a standing start. */
const OMEGA = 0.024;

/**
 * Where a gesture is: fingers down and its axis not picked yet, a scroll, a swipe moving the list, a swipe that went all
 * the way across already; or the glide after the fingers lifted.
 */
export type Phase = "idle" | "deciding" | "vertical" | "drag" | "spent" | "glide";

export interface Gesture {
  readonly phase: Phase;
  /** Its fingers swiped: its glide is the swipe's, and the list mustn't scroll with it. */
  readonly swiped: boolean;
  /** Its travel, as the wheel scrolls: the list moves the other way (-x). */
  readonly x: number;
  readonly y: number;
  /** When its last event came (ms). */
  readonly at: number;
  /** How fast the list moves, px a ms. */
  readonly v: number;
  /** Its largest event (px), and how many in a row didn't grow. */
  readonly peak: number;
  readonly falls: number;
  /** A glide's smallest event (px), and how many in a row grew. */
  readonly low: number;
  readonly up: number;
  /** It began on a pause in a glide: what comes may be that glide running on, handed over late. */
  readonly late: boolean;
  /** Its first events (FIRST of them): how many so far, the last one's size (px), and whether one was larger than the one before. */
  readonly n: number;
  readonly size: number;
  readonly rose: boolean;
  /** A glide's events growing since its smallest: where fingers that touched again began. */
  readonly rx: number;
  readonly ry: number;
  /** A swipe let go of while its fingers stood still, not lifted for all anyone knows (rest). */
  readonly rested?: boolean;
}

export const IDLE: Gesture = { phase: "idle", swiped: false, x: 0, y: 0, at: Number.NEGATIVE_INFINITY, v: 0, peak: 0, falls: 0, low: 0, up: 0, late: false, n: 0, size: 0, rose: false, rx: 0, ry: 0 };

export interface Wheel {
  readonly dx: number;
  readonly dy: number;
  readonly at: number;
  /** The platform's word: the event is the first of a touch, or not; absent where it says nothing. */
  readonly began?: boolean;
  /** Its word on the lift: the event is the glide's, after the fingers lifted, or the fingers'; absent where it says nothing. */
  readonly momentum?: boolean;
}

export interface Step {
  readonly g: Gesture;
  /** The event is the swipe's: the list mustn't scroll with it. */
  readonly claim: boolean;
  /** The swipe lets go now: settle. */
  readonly release: boolean;
  /** ...back where it was, whatever its travel: it was no swipe. */
  readonly back?: boolean;
}

/** Fingers down: a new gesture, from `x`, `y` travelled already. */
const begin = (at: number, x = 0, y = 0): Gesture => ({ ...IDLE, phase: "deciding", at, x, y });

/** After the fingers lift: what follows is the glide of what they did. */
export const glide = (g: Gesture): Gesture => ({ ...g, phase: "glide", swiped: g.swiped || g.phase === "drag" || g.phase === "spent", low: g.size, up: 0, rx: 0, ry: 0, rested: false });

/** The fingers stood still: the list settles, and is theirs again if they move before they lift (wheel). */
export const rest = (g: Gesture): Gesture => ({ ...glide(g), v: 0, rested: true });

/** It switched already (all the way across, or far enough with reduced motion): the rest of the gesture is spent. */
export const spend = (g: Gesture): Gesture => ({ ...g, phase: "spent", swiped: true });

/** Two events the same way: their dot product is above zero. */
const along = (dx: number, dy: number, x: number, y: number): number => dx * x + dy * y;
/** The axis the travel (x, y) mostly goes: a swipe's sideways, else up or down. */
const sideways = (x: number, y: number): boolean => Math.abs(x) > Math.abs(y) * BIAS;

/** One wheel event through the gesture: a new one where the platform says a touch began, else where the deltas do. */
export const wheel = (was: Gesture, e: Wheel): Step => {
  const touches = e.began !== undefined;
  // The platform says where the fingers lift: its glide's first event.
  const lifts = touches && e.momentum !== undefined;
  const span = (from: number) => Math.min(Math.max(e.at - from, 4), 50);
  const size = Math.hypot(e.dx, e.dy);
  let g = was;
  if (e.began === true) g = begin(e.at - FRAME_MS);
  else if (touches) {
    // A touch this gesture never saw begin (it began before the sidebar listened): a glide, never a swipe.
    if (g.phase === "idle") g = { ...glide(g), low: size };
    // The fingers that stood still move again: the swipe is theirs again, from where the list is (the sidebar's catch).
    else if (lifts && !e.momentum && g.phase === "glide" && g.rested === true) {
      return { g: { ...g, phase: "drag", rested: false, x: g.x + e.dx, y: g.y + e.dy, at: e.at, v: 0, peak: size, falls: 0, size }, claim: true, release: false };
    }
  } else if (g.phase === "idle" || e.at - g.at > GAP_MS) {
    // Soon after a glide and on its way, it may be that glide running on, handed over late; a glide never turns back.
    const late = g.phase === "glide" && e.at - g.at <= LIFT_MS && along(e.dx, e.dy, g.x, g.y) > 0;
    g = { ...begin(e.at - FRAME_MS), late };
  }
  else if (g.phase === "glide") {
    // A glide only shrinks, on the way it went. One that turns back, turns to the other axis or grows again is fingers.
    const back = along(e.dx, e.dy, g.x, g.y) < 0;
    const across = Math.hypot(e.dx, e.dy) >= 2 && sideways(e.dx, e.dy) !== sideways(g.x, g.y);
    const rising = g.up >= 1 && size > g.size && size > g.low * RISE + RISE_PX;
    if (back || across) g = begin(e.at - FRAME_MS);
    else if (rising) g = { ...begin(e.at - FRAME_MS, g.rx, g.ry), n: FIRST };
  }
  const dt = span(g.at);
  if (g.phase === "glide") {
    const grew = size > g.size;
    const next = { ...g, x: g.x + e.dx, y: g.y + e.dy, at: e.at, size, low: Math.min(g.low, size), up: grew ? g.up + 1 : 0, rx: grew ? g.rx + e.dx : e.dx, ry: grew ? g.ry + e.dy : e.dy };
    return { g: next, claim: g.swiped, release: false };
  }
  if (g.phase === "vertical") return { g: { ...g, at: e.at }, claim: false, release: false };
  const n = g.n + 1;
  const rose = g.rose || (g.n > 0 && size > g.size);
  // Begun on a pause in a glide, and only shrinking from its first event on: that glide running on, no fingers. Anywhere
  // else a first event that big is fingers: a flick, or a start the browser handed over as one lump.
  const shrank = !touches && g.late && g.n > 0 && g.n < FIRST && !rose && size < g.size;
  const falls = size <= g.size * 1.05 ? g.falls + 1 : 0;
  const peak = Math.max(g.peak, size);
  if (g.phase === "spent") {
    const next = { ...g, at: e.at, peak, falls, size };
    const lifted = lifts ? e.momentum : falls >= FALLS && size < peak * FADE;
    return { g: lifted ? glide(next) : next, claim: true, release: false };
  }
  // Lifted before it went anywhere: a tap or a nudge, and this its glide.
  if (g.phase === "deciding" && lifts && e.momentum) return { g: glide(g), claim: false, release: false };
  if (g.phase === "deciding") {
    const x = g.x + e.dx;
    const y = g.y + e.dy;
    const next = { ...g, x, y, at: e.at, peak, n, size, rose };
    if (Math.abs(x) + Math.abs(y) < DECIDE_PX) return { g: next, claim: false, release: false };
    if (!sideways(x, y)) return { g: { ...next, phase: "vertical" }, claim: false, release: false };
    if (shrank) return { g: { ...glide(next), rx: x, ry: y }, claim: false, release: false };
    // Never the touch's first event the platform marked: cancelled, it would keep the whole touch cancelable after it.
    return { g: { ...next, phase: "drag", swiped: true, v: 0, peak: size, falls: 0 }, claim: e.began !== true, release: false };
  }
  // The fingers lifted: the list settles from where they left it, at their speed; the glide never moves it.
  if (lifts && e.momentum) return { g: glide({ ...g, at: e.at }), claim: true, release: true };
  // A drag: the list follows, and without the platform's word its events' sizes say when the fingers have lifted.
  const x = g.x + e.dx;
  const v = g.v === 0 ? -e.dx / dt : 0.6 * (-e.dx / dt) + 0.4 * g.v;
  const next = { ...g, x, y: g.y + e.dy, at: e.at, v, peak, falls, n, size, rose };
  // Momentum that no fingers started springs back where it was, carried nowhere: its speed is no fling's.
  if (shrank) return { g: { ...glide(next), v: 0 }, claim: true, release: true, back: true };
  const release = !lifts && falls >= FALLS && size < peak * FADE;
  return { g: release ? glide(next) : next, claim: true, release };
};

/**
 * Where the list is drawn for a swipe's travel `raw` (px, + to the right): with the fingers up to a whole width toward
 * a hub that is there, stretched as macOS's rubber band is toward one that isn't.
 */
export const shown = (raw: number, width: number, prev: boolean, next: boolean): number => {
  const there = raw > 0 ? prev : next;
  if (there) return Math.max(-width, Math.min(width, raw));
  if (width <= 0) return 0;
  return Math.sign(raw) * (1 - 1 / ((Math.abs(raw) * BAND) / width + 1)) * width;
};

/** The travel that draws the list at `offset` (shown's inverse): where fingers that take up a moving list start from. */
export const unshown = (offset: number, width: number, prev: boolean, next: boolean): number => {
  const there = offset > 0 ? prev : next;
  if (there || width <= 0) return offset;
  const k = Math.min(Math.abs(offset) / width, 0.99);
  return (Math.sign(offset) * (1 / (1 - k) - 1) * width) / BAND;
};

/** Where a swipe let go at `x` (px), moving `v` (px a ms), settles: -width on the next hub, +width on the previous, else 0. */
export const settleOn = (x: number, v: number, width: number, prev: boolean, next: boolean): number => {
  const ahead = x + v * PROJECT_MS;
  if (ahead <= -width / 2 && next) return -width;
  if (ahead >= width / 2 && prev) return width;
  return 0;
};

/**
 * The speed a list let go of at `x` (px), moving `v` (px a ms), settles from. Stretched past an end it comes straight
 * back, as macOS's rubber band does (WebKit's: (x + v t) e^(-t/τ)), at once and at its fastest: the spring's own start
 * from rest is slow, and the stretch seemed to hang there. Elsewhere, its own speed.
 */
export const settleSpeed = (x: number, v: number, prev: boolean, next: boolean): number => {
  const stretched = x > 0 ? !prev : x < 0 ? !next : false;
  return stretched ? v - OMEGA * x : v;
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

/**
 * Chromium on a Mac: its wheel events' cancelable says where a touch begins (the header). The app's own platform, or
 * on the web the browser's word that it is Chromium on macOS.
 */
const phased = (): boolean => {
  if (window.fleetd.shell === "desktop") return window.fleetd.platform === "darwin";
  const ua = (navigator as Navigator & { userAgentData?: { platform: string; brands: ReadonlyArray<{ brand: string }> } }).userAgentData;
  return ua?.platform === "macOS" && ua.brands.some((b) => b.brand === "Chromium");
};

const reduced = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The mounted sidebar's slide: to a hub, or `by` from the one it is on or on its way to; none while it is hidden. */
let slide: { readonly to: (hub: string) => void; readonly by: (by: 1 | -1) => void } | null = null;

/** Show `hub`, on the sidebar's slide while it shows. */
export const switchHub = (hub: string): void => (slide === null ? openHub(hub) : slide.to(hub));

/** Show the hub `by` from `at` among `ids` (stepHub), on the sidebar's slide while it shows: from the one it is on its way to. */
export const switchHubBy = (ids: readonly string[], at: string, by: 1 | -1): void => {
  if (slide !== null) return slide.by(by);
  const to = stepHub(ids, at, by);
  if (to !== null) openHub(to);
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
  /** The list's frame, marked data-moving while the list moves (nothing in it then takes the pointer). */
  readonly frame: RefObject<HTMLElement | null>;
  /** Draws the list `offset` px from its place, the hub beside it there too; called on every frame of a swipe. */
  readonly paint: (offset: number, beside: Beside | null, width: number) => void;
  /**
   * The sidebar has that hub drawn already, ready beside the list (its neighbours, once it is idle): a swipe toward it
   * starts with no render at all. Any other comes in Swipe.beside, for the sidebar to draw.
   */
  readonly drawn: (beside: Beside) => boolean;
}

/**
 * The swipe over `area`: the hub it needs drawn beside the list, one the sidebar hasn't drawn already (null while
 * none). Settling on a hub opens it (sidebarLayout.ts openHub), as the switcher does. Whether it moves it marks on the
 * frame itself, and where it draws the list it paints: a swipe re-renders nothing on its way.
 */
export interface Swipe {
  readonly beside: Beside | null;
  /** For the list's frame: a press while a slide settles lands it at once, and goes to what is under it then. */
  readonly press: { readonly onPointerDownCapture: () => void; readonly onClickCapture: (e: MouseEvent<HTMLElement>) => void };
}

/**
 * The window's swipe, kept outside the sidebar: landing on another hub opens that hub's screen, which Shell.tsx mounts
 * afresh, the sidebar with it, so a gesture, its glide still arriving and a slide on its way go on in the new sidebar
 * as they were. `view` is the mounted sidebar's own state: what it draws beside the list and whether it moves.
 */
const g: { current: Gesture } = { current: IDLE };
const offset = { current: 0 };
const width = { current: 0 };
// The hub the swipe stands on: the one switched to as soon as it is, before the sidebar has drawn it.
const here = { current: 0 };
const near = { current: null as Beside | null };
const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined };
const frame = { current: 0 };
// A settle on the way: where to, and the hub it lands on there (null: back where it was).
const settling = { current: null as { to: number; hub: number | null; v: number; t: number } | null };
// `at` is the hub the sidebar has drawn, which the layout effect below keeps in step.
const live = {
  current: { hubs: [] as readonly string[], paint: ((): void => undefined) as SwipeOptions["paint"], at: 0, frame: null as HTMLElement | null, drawn: ((): boolean => false) as SwipeOptions["drawn"] },
};
const view = { current: { beside: null as Beside | null, moving: false, show: (_: Beside | null): void => undefined } };
const pressed = { current: false };
// A spring held still under a new touch going sideways, until it is taken up or turns out to be no swipe.
const held = { current: false };

const setBeside = (b: Beside | null): void => {
  view.current.beside = b;
  view.current.show(b);
};
const setMoving = (m: boolean): void => {
  view.current.moving = m;
  live.current.frame?.toggleAttribute("data-moving", m);
};

/** For tests: a window with no swipe yet. */
export const resetHubSwipe = (): void => {
  clearTimeout(timer.current);
  cancelAnimationFrame(frame.current);
  g.current = IDLE;
  offset.current = 0;
  near.current = null;
  settling.current = null;
  pressed.current = false;
  held.current = false;
  view.current = { ...view.current, beside: null, moving: false };
};

export function useHubSwipe({ area, pane, frame: list, hubs, at, paint, drawn }: SwipeOptions): Swipe {
  const [beside, show] = useState<Beside | null>(view.current.beside);
  useLayoutEffect(() => {
    live.current = { hubs, paint, at, frame: list.current, drawn };
  });
  useLayoutEffect(() => {
    view.current = { ...view.current, show };
    // Mounted afresh mid-swipe (it landed on a hub): still moving.
    list.current?.toggleAttribute("data-moving", view.current.moving);
  }, [list]);

  const draw = useCallback(() => live.current.paint(offset.current, near.current, width.current), []);
  const place = useCallback((b: Beside | null) => {
    if (near.current?.to === b?.to && near.current?.side === b?.side) return;
    near.current = b;
    // One the sidebar has drawn ahead needs no render: it is only shown, by paint.
    const need = b !== null && !live.current.drawn(b) ? b : null;
    if (view.current.beside?.to !== need?.to || view.current.beside?.side !== need?.side) setBeside(need);
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
        openHub(id);
      }
      if (id !== undefined && hub !== live.current.at) return;
      offset.current = 0;
      place(null);
      draw();
      setMoving(false);
    },
    [draw, place],
  );

  /** Settles on `to` (the hub there, or null back where it was), from `v`, as from `since` (when it was let go). */
  const run = useCallback(
    (to: number, hub: number | null, v: number, since = performance.now()) => {
      settling.current = { to, hub, v, t: Math.min(since, performance.now()) };
      held.current = false;
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

  /** The gesture lets go: the nearer hub, on the spring, from the speed the list was going (slowed by any stretch). */
  const release = useCallback(() => {
    clearTimeout(timer.current);
    const n = live.current.hubs.length;
    const prev = here.current > 0;
    const next = here.current < n - 1;
    const raw = -g.current.x;
    const v = shown(raw + g.current.v, width.current, prev, next) - shown(raw, width.current, prev, next);
    const to = settleOn(offset.current, v, width.current, prev, next);
    // From the lift (the glide's first event, or the last before a rest): the frame it is drawn on is that much on.
    run(to, to === 0 ? null : here.current + (to < 0 ? 1 : -1), settleSpeed(offset.current, v, prev, next), g.current.at);
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
    const said = phased();
    // The platform's word on the lift as well (WheelEvent.momentum): a pause is fingers standing still.
    const lifts = said && "momentum" in WheelEvent.prototype;
    /** The swipe lets go: on the spring, or with reduced motion back where it was. */
    const letGo = (back = false) => {
      clearTimeout(timer.current);
      if (reduced()) land(null);
      else if (back) run(0, null, 0);
      else release();
    };
    /** A spring held under a touch that came to nothing goes on from where it is. */
    const resume = () => {
      const s = settling.current;
      if (held.current && s !== null) run(s.to, s.hub, 0);
    };
    /** A pause: the fingers stood still, or lifted with no glide, so the list is let go standing still too. */
    const wait = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => {
          g.current = { ...rest(g.current), at: performance.now() };
          letGo();
        },
        lifts ? REST_MS : said ? LIFT_MS : GAP_MS,
      );
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      const w = pane.current?.clientWidth ?? 0;
      const { dx, dy } = px(e, w);
      const was = g.current.phase;
      // Nothing to move by: a touch's or a glide's end, which Chromium can hand the page.
      if (dx === 0 && dy === 0) return;
      // When the event happened, not when the page got to it: a busy renderer hands them over late and bunched.
      const step = wheel(g.current, { dx, dy, at: e.timeStamp, ...(said ? { began: e.cancelable } : {}), ...(lifts ? { momentum: e.momentum } : {}) });
      g.current = step.g;
      // A new touch takes over at once. A slide still settling on a hub lands first, whatever the touch turns out to be
      // (a scroll's must find the list in place, taking the pointer, to scroll it: it picks its scroller on its first
      // event), and so does one springing back under a touch going up or down. One springing back under a touch going
      // sideways stays where it is, for the swipe to take up (below), unless it turns out to be a scroll after all.
      const fresh = step.g.phase === "deciding" && was !== "deciding";
      const back = settling.current?.hub === null && Math.abs(dx) > Math.abs(dy);
      if (settling.current !== null && fresh && back) {
        // Held where it is, as a hand stops a moving list; on again if the touch comes to nothing.
        cancelAnimationFrame(frame.current);
        held.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(resume, lifts ? REST_MS : GAP_MS);
      } else if (settling.current !== null && ((fresh && !back) || (step.g.phase === "vertical" && was === "deciding"))) flushSync(finish);
      else if (was === "deciding" && step.g.phase === "glide") resume();
      if (step.claim) e.preventDefault();
      if (step.release) return letGo(step.back === true);
      if (step.g.phase !== "drag") return;
      const n = live.current.hubs.length;
      const prev = here.current > 0;
      const next = here.current < n - 1;
      if (was !== "drag") {
        const s = settling.current;
        if (s !== null && s.hub === null && width.current === w && !reduced()) {
          // A list springing back (from an end, or a swipe not far enough, or let go of under fingers that stood still):
          // they take it up where it is, as a hand stops a moving list, and it follows them from there.
          settling.current = null;
          held.current = false;
          cancelAnimationFrame(frame.current);
          g.current = { ...step.g, x: -unshown(offset.current, w, prev, next) + (was === "glide" ? dx : step.g.x), v: 0 };
        } else {
          // A new swipe: one still settling that it can't take up lands first.
          finish();
          width.current = w;
          setMoving(true);
          // Fingers that stood still, moving again once the list was back in place: from there.
          if (was === "glide") g.current = { ...step.g, x: dx, y: dy };
        }
      }
      const raw = -g.current.x;
      const side = raw > 0 ? -1 : 1;
      if (reduced()) {
        if (farEnough(raw, w) && (side < 0 ? prev : next)) {
          g.current = spend(g.current);
          clearTimeout(timer.current);
          land(here.current + side);
        } else wait();
        return;
      }
      offset.current = shown(raw, w, prev, next);
      place((side < 0 ? prev : next) && raw !== 0 ? { to: here.current + side, side } : null);
      draw();
      if (Math.abs(offset.current) >= w && w > 0) {
        // All the way across: on that hub now, and the rest of the gesture is spent.
        g.current = spend(g.current);
        clearTimeout(timer.current);
        land(here.current + side);
      } else wait();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [area, pane, hubs.length, draw, place, land, run, release, finish]);

  // The hub on show changed (a swipe landed, or any other switch): drawn in place, unless a new swipe is already moving.
  // A pick elsewhere (the switcher, a bot opened on another hub) while a slide is on its way to another stops it there.
  useLayoutEffect(() => {
    here.current = at;
    if (g.current.phase === "drag") return;
    if (settling.current !== null) {
      if (settling.current.hub === at) return;
      settling.current = null;
      cancelAnimationFrame(frame.current);
    }
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
        g.current = g.current.phase === "drag" ? spend(g.current) : g.current;
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
  // A slide this sidebar was running ends with it: a switch that mounts the next one on the slide's own hub (picked in the
  // switcher mid-slide) would otherwise find it still on its way there, with nothing left to land it, and the list
  // frozen part-way. Before the next one's layout effects, which then draw it in place.
  useLayoutEffect(
    () => () => {
      if (settling.current === null) return;
      settling.current = null;
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  // The list doesn't take the pointer while it moves (nothing lights up under the fingers), so a press then lands on its
  // frame: the slide lands first, and the click goes on to the row, the switcher or whatever is there now.
  const press = useMemo(
    () => ({
      onPointerDownCapture: () => {
        if (settling.current === null) return;
        pressed.current = true;
        flushSync(finish);
      },
      onClickCapture: (e: MouseEvent<HTMLElement>) => {
        if (!pressed.current) return;
        pressed.current = false;
        if (e.target !== e.currentTarget) return;
        const under = document.elementFromPoint(e.clientX, e.clientY);
        if (under instanceof HTMLElement && under !== e.currentTarget && e.currentTarget.contains(under)) under.click();
      },
    }),
    [finish],
  );

  return { beside, press };
}
