// New bubbles glide in (decision ui.bubble-entrance: option A of the bubble-motion report). The conversation moves as
// one sheet: a new message, or the last one growing (a streamed reply's text taking its dots' place, a picture
// loading), adds its height under the end the reader is at, and the rows are drawn
// where they were, the new one hanging behind the composer's glass island (the list runs on under it to the window's
// edge), then spring up by that height. So a bubble rises from behind the island with the rows above it, and nothing
// ever crosses anything. It is one additive transform on the rows (composite
// "add"): a burst sums, and a reply arriving mid-glide adds its height to the motion already running, with no restart.
// The bubble itself only fades in (view.module.css .enter); text never scales. Scrolled up, or with reduced motion,
// the list takes its new place at once.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { springCurve, type Spring } from "../../ui/lib/spring";
import { isMineRow, type Row } from "./model";

/** The springs, all critically damped. The phone runs the same (app/mobile/src/ui/motion.ts GLIDE). */
export const GLIDE = {
  /** A reply: 95% there at 212 ms. */
  theirs: { stiffness: 500, damping: 44.7, mass: 1 },
  /** Your send, quicker, since you made it happen: 187 ms. */
  mine: { stiffness: 650, damping: 51, mass: 1 },
  /** The last message growing: 180 ms. */
  grow: { stiffness: 700, damping: 53, mass: 1 },
} as const satisfies Record<string, Spring>;

/** Where the conversation stood when last looked at: its scroll, and its last few rows' keys and starts. */
export interface Place {
  readonly height: number;
  readonly top: number;
  readonly view: number;
  readonly width: number;
  /** Where the rows end, px, short of the room the list keeps after them (the composer's island). */
  readonly end: number;
  /** Oldest first. A few, since the last may go as a message comes. */
  readonly tail: readonly { readonly key: string; readonly start: number }[];
}

/** How many of the last rows a Place keeps. */
const TAIL = 4;

/** The newest of `was`'s last rows still in the list: where it started then and starts now, and the rows after it. */
export function anchorOf(was: Place, rows: readonly Row[], startOf: (key: string) => number | undefined): { readonly was: number; readonly now: number | undefined; readonly after: readonly Row[] } | undefined {
  for (const t of [...was.tail].reverse()) {
    const at = rows.findIndex((r) => r.key === t.key);
    if (at !== -1) return { was: t.start, now: startOf(t.key), after: rows.slice(at + 1) };
  }
  return undefined;
}

/** Within this of the end, the reader is at it (VirtualList's followOptions). */
const AT_END = 24;

/**
 * The spring the list makes room on, from `was` to `now`, or undefined when it doesn't glide. It glides only when it
 * grew under the end the reader was at, and the newest row that stayed (`anchor`, anchorOf) hasn't moved: an older
 * page landing above, or the window resizing, isn't a new message. A message of yours after it glides on your send's
 * spring, any other on a reply's, and none (the last row grew) on the growing one. The island growing with its words
 * only adds room after the rows: the last message moves up with the pill in the same frame, as the pill grows, so a
 * line wrap doesn't redraw the conversation and its glass for a spring's frames while you type.
 */
export function glideOf(was: Place, now: Pick<Place, "height" | "view" | "width" | "end">, anchor: ReturnType<typeof anchorOf>): Spring | undefined {
  if (now.height <= was.height || now.end === was.end || was.height - was.top - was.view > AT_END) return undefined;
  if (now.view !== was.view || now.width !== was.width || anchor === undefined || anchor.now !== anchor.was) return undefined;
  if (anchor.after.length === 0) return GLIDE.grow;
  return anchor.after.some(isMineRow) ? GLIDE.mine : GLIDE.theirs;
}

/**
 * The glide on a VirtualList's rows. It follows the end itself as the list grows, in the same frame (a ResizeObserver
 * runs after layout and before paint), so the jump to the end and the rows drawn back where they were land together.
 */
export function useGlide(list: RefObject<Virtualizer<HTMLDivElement, Element> | null>, rows: readonly Row[]): void {
  const rowsNow = useRef(rows);
  useLayoutEffect(() => {
    rowsNow.current = rows;
  });
  useEffect(() => {
    const v = list.current;
    const el = v?.scrollElement;
    const inner = el?.firstElementChild;
    const sheet = inner?.firstElementChild;
    if (!v || !el || !inner || !(sheet instanceof HTMLElement)) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const look = (): Place => ({
      height: el.scrollHeight,
      top: el.scrollTop,
      view: el.clientHeight,
      width: el.clientWidth,
      end: v.measurementsCache.at(-1)?.end ?? 0,
      tail: v.measurementsCache.slice(-TAIL).map((m) => ({ key: String(m.key), start: m.start })),
    });
    let was = look();
    // The reader scrolling. A scroll that came with the list growing (the virtualizer following the end) is left to
    // the observer, which still has to see where it was before.
    const onScroll = () => {
      const now = look();
      if (now.height === was.height) was = now;
    };
    const ro = new ResizeObserver(() => {
      const before = was;
      was = look();
      if (reduce.matches) return;
      const spring = glideOf(before, was, anchorOf(before, rowsNow.current, (key) => v.measurementsCache.find((m) => m.key === key)?.start));
      if (spring === undefined) return;
      el.scrollTop = el.scrollHeight;
      was = look();
      const by = was.top - before.top;
      if (by <= 0) return;
      const { ms, ease } = springCurve(spring);
      sheet.animate([{ transform: `translateY(${String(by)}px)` }, { transform: "translateY(0px)" }], { duration: ms, easing: ease, composite: "add" });
    });
    ro.observe(inner);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [list]);
}
