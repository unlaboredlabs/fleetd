import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cx } from "../lib/cx";
import s from "./VirtualList.module.css";

/**
 * Pinning to the end, done by TanStack itself: anchored to the end, the view stays at the bottom when items are
 * appended AND when the last item grows in place (a streaming message), as long as the reader is within
 * `scrollEndThreshold` px of the end. Scrolled up, nothing moves. `away`: the reader has scrolled toward the start
 * since they were last at the end (readerLeft), so they aren't at it however close they still are.
 */
export function followOptions(followOutput: boolean | undefined, away = false) {
  return followOutput
    ? ({ anchorTo: "end", followOnAppend: true, scrollEndThreshold: endThreshold(away) } as const)
    : ({ anchorTo: "start", followOnAppend: false } as const);
}

/** Within this of the end, a reader who hasn't scrolled away from it is at it; one who has never is (-1). */
const endThreshold = (away: boolean): number => (away ? -1 : 24);

/**
 * Whether a row changing size moves the view by as much, so what is on screen stays where it was: any row that starts
 * above the view's top, whichever way the reader scrolls, is measured again or for the first time. A picture loading
 * in a row the view's top cuts through (a reader scrolling up reaches it there) grows upward, out of sight, instead of
 * pushing every row in view down. TanStack's own rule leaves such a row alone, and any row at all while the reader
 * scrolls up. The last row is the exception while it reaches into the view: it grows at its bottom (a reply
 * streaming in), where the reader reads on.
 */
export function keepsPlace(item: VirtualItem, _delta: number, v: Virtualizer<HTMLDivElement, Element>): boolean {
  const offset = v.scrollOffset ?? 0;
  return item.start < offset && (item.end <= offset || item.index < v.options.count - 1);
}

/** Where a scroller stood at a scroll event. */
export interface Scrolled {
  readonly top: number;
  readonly height: number;
  readonly view: number;
}

/**
 * Whether, from `was` to `now`, the reader left the end (true), came back to it (false), or neither (undefined). Only
 * the reader moves the view toward the start while the list and the view keep their sizes: a row measured above, a
 * page landing or the end trimmed changes the height, and the list's own moves go to the end.
 */
export function readerLeft(was: Scrolled, now: Scrolled): boolean | undefined {
  if (now.height - now.top - now.view <= 1) return false;
  if (now.top < was.top && now.height === was.height && now.view === was.view) return true;
  return undefined;
}

export interface VirtualListProps<T> {
  items: ReadonlyArray<T>;
  /** A stable key per item (its id), so measured heights survive inserts. */
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  /** A first guess at a row's height; rows are measured after they render, so they can be any height. */
  estimateSize?: number;
  /** Heights of rows measured before, by key, kept and read across lists: a row drawn again (a chat opened again) starts
   * at its height rather than the guess, so its first layout is its last. Only for keys unique across the lists. */
  heights?: Map<string | number, number>;
  overscan?: number;
  /** Space between rows, px. */
  gap?: number;
  /** Room before the first row, px, which a row scrolled to also keeps clear (a bar floating over the list's top). */
  paddingStart?: number;
  /** Room after the last row, px: inside the list, so its rows are drawn and clipped there (the chat's glide). */
  paddingEnd?: number;
  /** Keep the view pinned to the end while new items arrive, unless the reader has scrolled up (logs, chat). */
  followOutput?: boolean;
  /** Start at the end instead of the top. */
  startAtEnd?: boolean;
  className?: string | undefined;
  /** For scroll-to-index and friends. */
  virtualizerRef?: RefObject<Virtualizer<HTMLDivElement, Element> | null>;
  "aria-label"?: string;
  /** `presentation` when the rows carry their own roles (a table's rows). */
  role?: "list" | "presentation";
}

/** How many rows' heights a `heights` map keeps, the oldest dropped first. */
const HEIGHTS_MAX = 5000;
const remember = (heights: Map<string | number, number>, key: string | number, height: number): void => {
  if (heights.get(key) === height) return;
  heights.delete(key);
  heights.set(key, height);
  if (heights.size > HEIGHTS_MAX) {
    const oldest = heights.keys().next().value;
    if (oldest !== undefined) heights.delete(oldest);
  }
};

/**
 * A long list that renders only what is on screen. It fills its parent's height and scrolls itself. Rows size to
 * their content (wrapped text included) and are re-measured when they resize.
 */
export function VirtualList<T>(props: VirtualListProps<T>) {
  const { items, getKey, followOutput, startAtEnd, gap = 0, paddingStart = 0, paddingEnd = 0 } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);

  // TanStack Virtual returns a mutable instance the React Compiler can't memoize; this component opts out of it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const item = items[i];
      return (item === undefined ? undefined : props.heights?.get(getKey(item, i))) ?? props.estimateSize ?? 28;
    },
    getItemKey: (i) => {
      const item = items[i];
      return item === undefined ? i : getKey(item, i);
    },
    overscan: props.overscan ?? 8,
    gap,
    paddingStart,
    scrollPaddingStart: paddingStart,
    paddingEnd,
    scrollPaddingEnd: paddingEnd,
    ...followOptions(followOutput, away),
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = keepsPlace;

  const { virtualizerRef } = props;
  useEffect(() => {
    if (!virtualizerRef) return;
    virtualizerRef.current = virtualizer;
    return () => {
      virtualizerRef.current = null;
    };
  }, [virtualizer, virtualizerRef]);

  // Following the end lets go the moment the reader scrolls toward the start, however little. Within the threshold,
  // a row appended or the last one growing would bring them back to the end, every time while replies come in, so a
  // slow scroll up from the end (a trackpad's first pixels) kept snapping back. The threshold is set here, in the
  // scroll event, as well as in the render it asks for: a row can be appended before that render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!followOutput || !el) return;
    const look = (): Scrolled => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight });
    let was = look();
    const onScroll = () => {
      const now = look();
      const left = readerLeft(was, now);
      was = now;
      if (left === undefined) return;
      virtualizer.options.scrollEndThreshold = endThreshold(left);
      setAway(left);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [followOutput, virtualizer]);

  // TanStack skips measuring rows that mount while the list is scrolling (and for 150 ms after) and leaves them to
  // its ResizeObserver, whose re-render lands a frame or more later; until then the list's height and the first
  // row's start count those rows at their estimates. Measuring every rendered row after each commit makes any frame
  // that paints consistent: a size change re-renders synchronously, before paint, and stops once nothing moves.
  useLayoutEffect(() => {
    const list = rowsRef.current;
    if (!list) return;
    const sizes = new Map(virtualizer.getVirtualItems().map((v) => [v.index, v.size]));
    for (const child of list.children) {
      if (!(child instanceof HTMLElement)) continue;
      const index = Number(child.dataset["index"]);
      const measured = Math.round(child.getBoundingClientRect().height);
      const item = items[index];
      if (props.heights && item !== undefined) remember(props.heights, getKey(item, index), measured);
      if (sizes.has(index) && sizes.get(index) !== measured) virtualizer.resizeItem(index, measured);
    }
  });

  useLayoutEffect(() => {
    if (startAtEnd && items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    // Only on mount: later growth is followOutput's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = virtualizer.getVirtualItems();
  return (
    <div
      ref={scrollRef}
      className={cx(s.scroller, props.className)}
      role={props.role ?? "list"}
      aria-label={props["aria-label"]}
    >
      <div className={s.inner} style={{ height: virtualizer.getTotalSize() }}>
        {/* The rows on screen stack in flow under the first one's start, rather than each at its own measured start:
            a row that grows before it is measured again (rewrapped by a resize, a font or an image landing) pushes the
            rows under it down in the same layout, where rows placed by their old sizes would overlap it until then. */}
        <div ref={rowsRef} className={s.rows} style={{ transform: `translateY(${String(rows[0]?.start ?? 0)}px)`, gap }}>
          {rows.map((row) => {
            const item = items[row.index];
            if (item === undefined) return null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className={s.row}
                role={props.role === "presentation" ? "presentation" : "listitem"}
              >
                {props.renderItem(item, row.index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
