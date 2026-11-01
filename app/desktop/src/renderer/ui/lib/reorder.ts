// A list you reorder by dragging a row, or with ⌥↑ / ⌥↓ on a focused one (ui/DESIGN.md). A press that moves a few
// pixels lifts the row (raised, a soft shadow, under the pointer); the rows it passes slide aside to open its gap; let
// go, the list takes the new order at once and the row glides from where it was let go into its slot (FLIP: in the
// frame the order changes, each row is put back where it was on screen and let glide to its new place, so no frame
// shows a row anywhere else). Any change of the order glides the same way: ⌥↑ / ⌥↓, or another desktop's move. Near the
// top or bottom of a list that scrolls, the list scrolls, faster the closer the pointer is to the edge, and the lifted
// row stays under the pointer; as on iOS and macOS, only once the pointer heads for that edge, or rests near it a
// moment, so a row picked up near an edge of a scrolled list doesn't set it moving. Esc puts it back. So does a list
// that changes under it (a move from another desktop, a row added or gone): rows go by key, never by an index from
// before. A click that didn't move is still a click. Only transform changes, on the rows' wrappers, so nothing lays out
// mid-drag; with reduced motion the rows still move with the pointer but nothing glides. Each move is announced
// (`status`, for a role="status" region).
//
// Pure helpers first, so the arithmetic is unit-tested; the hook is the pointer and keyboard glue.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

/** How far a press moves before it is a drag rather than a click. */
export const LIFT_PX = 4;
/** The glide into the new place: --dur-base. */
export const SETTLE_MS = 180;
/** How near the edge of a scrolling list the pointer starts it scrolling. */
export const EDGE_PX = 48;
/** The fastest it scrolls, at the edge or past it: px a frame. */
export const MAX_SCROLL_PX = 14;
/** How far the pointer heads for an edge, since the lift, before the list scrolls that way. */
export const ARM_PX = 6;
/** Or how long it rests near an edge. */
export const DWELL_MS = 500;

/**
 * Whether a pointer at `y`, in an edge's band (`speed` from edgeSpeed: negative near the top), has headed for that edge:
 * ARM_PX nearer it than the farthest from it the pointer has been since the lift (`low` to `high`).
 */
export const headedFor = (speed: number, y: number, low: number, high: number): boolean =>
  speed < 0 ? y <= high - ARM_PX : speed > 0 ? y >= low + ARM_PX : false;

/**
 * How far a list from `top` to `bottom` scrolls this frame with the pointer at `y`: none outside the edges' bands, then
 * easing in (squared) as the pointer nears an edge, up to MAX_SCROLL_PX at it and past it. Negative scrolls up.
 */
export const edgeSpeed = (y: number, top: number, bottom: number): number => {
  const band = Math.min(EDGE_PX, (bottom - top) / 3);
  if (band <= 0) return 0;
  const near = (inside: number) => MAX_SCROLL_PX * Math.min(1, Math.max(0, (band - inside) / band)) ** 2;
  if (y < top + band) return -near(y - top);
  if (y > bottom - band) return near(bottom - y);
  return 0;
};

/** The nearest ancestor of `el` that scrolls vertically: the list's own scroll, which a drag near its edges moves. */
const scrollerOf = (el: HTMLElement): HTMLElement | null => {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    const y = window.getComputedStyle(at).overflowY;
    if (y === "auto" || y === "scroll") return at;
  }
  return null;
};

/** `items` with the one at `from` moved to `to`. */
export const moved = <T>(items: readonly T[], from: number, to: number): T[] => {
  const out = [...items];
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
};

/**
 * Where a row lifted from `from` drops with its centre at `centre`: past every other row whose centre it reached. Held
 * at either end of the list, it reaches the end row's centre exactly, and takes that end.
 */
export const dropIndex = (centres: readonly number[], from: number, centre: number): number =>
  centres.reduce((n, c, i) => ((i < from && c < centre) || (i > from && c <= centre) ? n + 1 : n), 0);

/** How far row `i` slides aside while the row from `from` (`size` tall) is over `over`. */
export const shiftOf = (i: number, from: number, over: number, size: number): number => {
  if (from < over && i > from && i <= over) return -size;
  if (over < from && i >= over && i < from) return size;
  return 0;
};

/** The indexes a row may go to: the run of rows in its group around it (a Navi stays among its hub's). */
export const boundsOf = <K>(keys: readonly K[], at: number, group: ((key: K) => string) | undefined): readonly [number, number] => {
  if (group === undefined) return [0, keys.length - 1];
  const g = group(keys[at] as K);
  let lo = at;
  let hi = at;
  while (lo > 0 && group(keys[lo - 1] as K) === g) lo--;
  while (hi < keys.length - 1 && group(keys[hi + 1] as K) === g) hi++;
  return [lo, hi];
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const reduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Each row's top on screen, from its list's top: transforms and glides under way included. */
const onScreen = <K>(els: ReadonlyMap<K, HTMLElement>): ReadonlyMap<K, number> =>
  new Map([...els].map(([key, el]) => [key, el.getBoundingClientRect().top - (el.parentElement?.getBoundingClientRect().top ?? 0)]));

/**
 * The rows put back where they were on screen (`from`, as onScreen read them before the DOM changed) and let glide to
 * their places over `ms`, all in this frame: a row with nowhere to go, or new, just sits in its place. Returns the
 * rows gliding.
 */
const glide = <K>(els: ReadonlyMap<K, HTMLElement>, from: ReadonlyMap<K, number>, ms: number): HTMLElement[] => {
  // No row was on screen (the list's first rows, as the app opens): none has a place to glide from, and reading theirs
  // would lay out the whole window in the middle of its first paint.
  if (from.size === 0) return [];
  // Their places now, with nothing moving them: a glide under way, or a drag's offset, cleared first.
  for (const el of els.values()) {
    el.style.transition = "none";
    el.style.transform = "";
  }
  const now = onScreen(els);
  const gliding: HTMLElement[] = [];
  for (const [key, el] of els) {
    const was = from.get(key);
    const by = was === undefined ? 0 : was - (now.get(key) ?? was);
    if (ms > 0 && Math.abs(by) >= 0.5) {
      el.style.transform = `translateY(${String(by)}px)`;
      gliding.push(el);
    } else el.style.transition = "";
  }
  if (gliding.length === 0) return gliding;
  // Drawn where they were, then let go: the transition runs from there.
  void gliding[0]?.getBoundingClientRect();
  for (const el of gliding) {
    el.style.transition = `transform ${String(ms)}ms var(--ease-out)`;
    el.style.transform = "";
  }
  return gliding;
};

export interface ReorderOptions<K extends string> {
  /** The rows, in the order they are on show. */
  readonly keys: readonly K[];
  /** A row went from `from` to `to`; `order` is the list after it. */
  readonly onMove: (order: K[], key: K, from: number, to: number) => void;
  /** The row's name, for the announcement. */
  readonly name: (key: K) => string;
  /** Rows move only within their group's run. */
  readonly group?: ((key: K) => string) | undefined;
}

interface Press<K> {
  readonly key: K;
  /** Its index in the list at the lift (at the press until then). */
  from: number;
  /** The list's keys at the lift: a list changed since (a move from another desktop, a row added or gone) cancels it. */
  sig: string;
  /** Ends the press, dropping a lifted row (back, with `cancel`). */
  finish: (cancel: boolean) => void;
  /** Ends it at once: no drop, nothing called back (the list unmounting). */
  stop: () => void;
  readonly startY: number;
  readonly pointerId: number;
  lifted: boolean;
  centres: number[];
  tops: number[];
  heights: number[];
  bounds: readonly [number, number];
  over: number;
  /** The pointer's last height. */
  y: number;
  scroller: HTMLElement | null;
  /** The scroller's scrollTop at the lift: the rows' measures are from then. */
  scroll0: number;
  /** The autoscroll's next frame; 0 while it isn't scrolling. */
  frame: number;
  /** The pointer has headed for an edge, or rested near one: the list may scroll. */
  armed: boolean;
  /** The highest and lowest the pointer has been since the lift. */
  low: number;
  high: number;
  /** The rest near an edge being timed; 0 when none. */
  dwell: number;
}

interface Moving<K> {
  readonly key: K;
  readonly from: number;
  readonly over: number;
  readonly size: number;
}

export interface Reorder<K extends string> {
  /** The rows in the order to draw them: the new order from the moment of the drop, before `keys` catches up. */
  readonly shown: readonly K[];
  /** Spread on each row's wrapper element. */
  readonly row: (key: K) => {
    ref: (el: HTMLElement | null) => void;
    onPointerDown: (e: PointerEvent) => void;
    onKeyDown: (e: KeyboardEvent) => void;
    onClickCapture: (e: MouseEvent) => void;
    onDragStart: (e: MouseEvent) => void;
    style: CSSProperties | undefined;
    "data-reorder-row": "";
    "data-lifted"?: "";
  };
  /** Spread on the list: `data-reorder` while a row is lifted, so the others glide aside. */
  readonly list: { "data-reorder"?: "" };
  /** The last move, in words: for a role="status" region. */
  readonly status: string;
}

export function useReorder<K extends string>(options: ReorderOptions<K>): Reorder<K> {
  const { keys, name, group } = options;
  const els = useRef(new Map<K, HTMLElement>());
  const press = useRef<Press<K> | null>(null);
  const swallow = useRef(false);
  const refocus = useRef<K | null>(null);
  // The glides' ends and click guards on their way, and whether the list is still there for them.
  const timers = useRef(new Set<number>());
  const later = (f: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      f();
    }, ms);
    timers.current.add(id);
  };
  const [moving, setMoving] = useState<Moving<K> | null>(null);
  // The row just let go, raised until it has glided into its slot.
  const [landing, setLanding] = useState<K | null>(null);
  // The order just made, shown until `keys` (the caller's) moves on: no frame of the old order after a drop.
  // Matched on the keys' text, not the array: a parent drawing the same rows again isn't the order catching up.
  const [pending, setPending] = useState<{ readonly for: string; readonly order: readonly K[] } | null>(null);
  const [status, setStatus] = useState("");
  const sig = keys.join("\n");
  const shown = pending !== null && pending.for === sig ? pending.order : keys;
  if (pending !== null && pending.for !== sig) setPending(null);
  // The rows on show, as text: what a lifted row's measures and index are of. Keys catching up to a move just made
  // leave it as it was.
  const showing = shown.join("\n");
  // What the window's listeners and the glide's timer read, as of the last render.
  const latest = useRef({ ...options, shown, sig, showing });
  useLayoutEffect(() => {
    latest.current = { ...options, shown, sig, showing };
  });

  // FLIP. When the rows' places are about to change (another order, or a lifted row let go), where each row is on
  // screen now, read before React touches the DOM; once it has, each row is put back there and glides to its new place,
  // in the same frame. A lifted row's list waits for the drop, keeping the places it had on screen before.
  // The read is in the render on purpose: it is the last moment the DOM still shows the old places (a class's
  // getSnapshotBeforeUpdate), and nothing drawn depends on it.
  const lifted = moving !== null;
  const placed = useRef({ showing, lifted });
  const first = useRef<ReadonlyMap<K, number> | null>(null);
  /* eslint-disable react-hooks/refs */
  if (first.current === null && (showing !== placed.current.showing || (placed.current.lifted && !lifted))) first.current = onScreen(els.current);
  /* eslint-enable react-hooks/refs */
  const glides = useRef(0);
  useLayoutEffect(() => {
    placed.current = { showing, lifted };
    const from = first.current;
    if (lifted || from === null) return;
    first.current = null;
    const wait = reduced() ? 0 : SETTLE_MS;
    const gliding = glide(els.current, from, wait);
    const n = ++glides.current;
    const landed = () => {
      if (glides.current !== n) return;
      for (const el of gliding) el.style.transition = "";
      setLanding(null);
    };
    if (wait === 0) landed();
    else later(landed, wait);
  });

  // The list changed under a lifted row: it goes back, and nothing moves (its index would name another row now).
  useLayoutEffect(() => {
    const p = press.current;
    if (p?.lifted === true && p.sig !== showing) p.finish(true);
  }, [showing]);

  // Gone mid-press or mid-glide (a hub's group collapsed or removed): no listener, timer or call back outlives it.
  useEffect(
    () => () => {
      press.current?.stop();
      press.current = null;
      for (const id of timers.current) window.clearTimeout(id);
      timers.current.clear();
    },
    [],
  );

  // A row moved by keyboard comes back focused: React may have taken its element out and put it back.
  useLayoutEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    const el = els.current.get(key);
    const target = el?.querySelector<HTMLElement>("button, [tabindex]") ?? el;
    if (target !== undefined && !target.contains(document.activeElement)) target.focus();
  });

  /** `key` to `to`, from wherever it is in the list now: by key, never by an index from before. */
  const commit = (key: K, to: number) => {
    const now = latest.current;
    const from = now.shown.indexOf(key);
    if (from < 0 || from === to || to < 0 || to >= now.shown.length) return;
    const order = moved(now.shown, from, to);
    setPending({ for: now.sig, order });
    setStatus(`${now.name(key)} moved to ${String(to + 1)} of ${String(order.length)}`);
    now.onMove(order, key, from, to);
  };

  /**
   * Let go (or Esc, `cancel`): the list takes the new order now, in one render with the lift's end, and the row glides
   * from where it was let go into its slot (or back), raised until it lands.
   */
  const drop = (p: Press<K>, cancel: boolean) => {
    // The click this release makes is the drop's, not the row's.
    swallow.current = true;
    later(() => (swallow.current = false), 0);
    setMoving(null);
    setLanding(p.key);
    // A list changed under it was put back (cancel): the lift's index would name another row now.
    if (!cancel && latest.current.showing === p.sig) commit(p.key, p.over);
  };

  const begin = (e: PointerEvent, key: K, at: number) => {
    // `at` is where it was at the press: the lift finds it again by its key, in the list as it is then.
    const p: Press<K> = {
      key,
      from: at,
      sig: latest.current.showing,
      finish: () => undefined,
      stop: () => undefined,
      startY: e.clientY,
      pointerId: e.pointerId,
      lifted: false,
      centres: [],
      tops: [],
      heights: [],
      bounds: [at, at],
      over: at,
      y: e.clientY,
      scroller: null,
      scroll0: 0,
      frame: 0,
      armed: false,
      low: e.clientY,
      high: e.clientY,
      dwell: 0,
    };
    /** The lifted row under the pointer, the list scrolled or not, and the gap where it would drop. */
    const place = () => {
      const el = els.current.get(key);
      if (el === undefined || !p.lifted) return;
      // The measures are from the lift: a list scrolled since moved every row by as much, the lifted one with them.
      const scrolled = p.scroller === null ? 0 : p.scroller.scrollTop - p.scroll0;
      const [lo, hi] = p.bounds;
      const top = p.tops[p.from] ?? 0;
      const bottom = top + (p.heights[p.from] ?? 0);
      const travel = clamp(p.y - p.startY + scrolled, (p.tops[lo] ?? top) - top, (p.tops[hi] ?? 0) + (p.heights[hi] ?? 0) - bottom);
      el.style.transform = `translateY(${String(travel)}px)`;
      const over = clamp(dropIndex(p.centres, p.from, (p.centres[p.from] ?? 0) + travel), lo, hi);
      if (over !== p.over) {
        p.over = over;
        setMoving((m) => (m === null ? m : { ...m, over }));
      }
    };
    const restless = () => {
      if (p.dwell !== 0) window.clearTimeout(p.dwell);
      p.dwell = 0;
    };
    /**
     * A frame of the autoscroll: on while the pointer is near an edge and the list can still go that way, once armed.
     * Not yet armed, a pointer near an edge arms it by heading for it, or by resting there DWELL_MS.
     */
    const tick = () => {
      p.frame = 0;
      const scroller = p.scroller;
      if (!p.lifted || scroller === null) return;
      const box = scroller.getBoundingClientRect();
      const speed = edgeSpeed(p.y, box.top, box.bottom);
      if (speed === 0) return restless();
      if (!p.armed && headedFor(speed, p.y, p.low, p.high)) p.armed = true;
      if (!p.armed) {
        if (p.dwell === 0) {
          p.dwell = window.setTimeout(() => {
            p.dwell = 0;
            p.armed = true;
            if (p.frame === 0) tick();
          }, DWELL_MS);
        }
        return;
      }
      restless();
      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed;
      if (scroller.scrollTop === before) return;
      place();
      p.frame = window.requestAnimationFrame(tick);
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== p.pointerId) return;
      const el = els.current.get(key);
      if (el === undefined) return;
      p.y = ev.clientY;
      if (!p.lifted) {
        if (Math.abs(p.y - p.startY) < LIFT_PX) return;
        const { shown: order, showing: now, group: groupOf } = latest.current;
        const from = order.indexOf(key);
        if (from < 0) return p.stop();
        p.from = from;
        p.over = from;
        p.sig = now;
        const rects = order.map((k) => els.current.get(k)?.getBoundingClientRect());
        p.tops = rects.map((r) => r?.top ?? 0);
        p.heights = rects.map((r) => r?.height ?? 0);
        p.centres = rects.map((r) => (r === undefined ? 0 : r.top + r.height / 2));
        p.bounds = boundsOf(order, from, groupOf);
        p.scroller = scrollerOf(el);
        p.scroll0 = p.scroller?.scrollTop ?? 0;
        p.scroller?.addEventListener("scroll", place);
        p.low = p.y;
        p.high = p.y;
        p.lifted = true;
        try {
          el.setPointerCapture(p.pointerId);
        } catch {
          // A pointer already gone: the window's listeners still see it.
        }
        setMoving({ key, from, over: from, size: p.heights[from] ?? 0 });
      }
      p.low = Math.min(p.low, p.y);
      p.high = Math.max(p.high, p.y);
      place();
      if (p.frame === 0) tick();
    };
    p.stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEsc, true);
      p.scroller?.removeEventListener("scroll", place);
      if (p.frame !== 0) window.cancelAnimationFrame(p.frame);
      p.frame = 0;
      restless();
      if (press.current === p) press.current = null;
    };
    p.finish = (cancel) => {
      p.stop();
      if (p.lifted) drop(p, cancel);
    };
    const onUp = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId === p.pointerId) p.finish(false);
    };
    const onCancel = () => p.finish(true);
    const onEsc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape" || !p.lifted) return;
      ev.preventDefault();
      ev.stopPropagation();
      p.finish(true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onEsc, true);
    press.current = p;
  };

  const row = (key: K): ReturnType<Reorder<K>["row"]> => {
    const at = shown.indexOf(key);
    const raised = moving?.key === key || landing === key;
    const shift = moving === null || raised ? 0 : shiftOf(at, moving.from, moving.over, moving.size);
    return {
      ref: (el) => {
        if (el === null) els.current.delete(key);
        else els.current.set(key, el);
      },
      onPointerDown: (e) => {
        // The main button, unmodified (⌃-click is the context menu on a Mac); one at a time; never while one lands.
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || press.current !== null || moving !== null || landing !== null || shown.length < 2) return;
        begin(e, key, at);
      },
      onKeyDown: (e) => {
        if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || moving !== null) return;
        e.preventDefault();
        const up = e.key === "ArrowUp";
        const [lo, hi] = boundsOf(shown, at, group);
        const to = clamp(at + (up ? -1 : 1), lo, hi);
        if (to === at) {
          setStatus(`${name(key)} is already ${up ? "first" : "last"}`);
          return;
        }
        refocus.current = key;
        commit(key, to);
      },
      onClickCapture: (e) => {
        if (!swallow.current) return;
        swallow.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      // An avatar's image would start the browser's own drag.
      onDragStart: (e) => e.preventDefault(),
      style: shift === 0 ? undefined : { transform: `translateY(${String(shift)}px)` },
      "data-reorder-row": "",
      ...(raised ? { "data-lifted": "" as const } : {}),
    };
  };

  return { shown, row, list: moving === null ? {} : { "data-reorder": "" }, status };
}
