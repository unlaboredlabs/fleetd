import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { cx } from "../lib/cx";
import s from "./VirtualList.module.css";

/**
 * Pinning to the end, done by TanStack itself: anchored to the end, the view stays at the bottom when items are
 * appended AND when the last item grows in place (a streaming message), as long as the reader is within
 * `scrollEndThreshold` px of the end. Scrolled up, nothing moves.
 */
export function followOptions(followOutput: boolean | undefined) {
  return followOutput
    ? ({ anchorTo: "end", followOnAppend: true, scrollEndThreshold: 24 } as const)
    : ({ anchorTo: "start", followOnAppend: false } as const);
}

export interface VirtualListProps<T> {
  items: ReadonlyArray<T>;
  /** A stable key per item (its id), so measured heights survive inserts. */
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  /** A first guess at a row's height; rows are measured after they render, so they can be any height. */
  estimateSize?: number;
  overscan?: number;
  /** Space between rows, px. */
  gap?: number;
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

/**
 * A long list that renders only what is on screen. It fills its parent's height and scrolls itself. Rows size to
 * their content (wrapped text included) and are re-measured when they resize.
 */
export function VirtualList<T>(props: VirtualListProps<T>) {
  const { items, getKey, followOutput, startAtEnd, gap = 0 } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // TanStack Virtual returns a mutable instance the React Compiler can't memoize; this component opts out of it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => props.estimateSize ?? 28,
    getItemKey: (i) => {
      const item = items[i];
      return item === undefined ? i : getKey(item, i);
    },
    overscan: props.overscan ?? 8,
    gap,
    ...followOptions(followOutput),
  });

  const { virtualizerRef } = props;
  useEffect(() => {
    if (!virtualizerRef) return;
    virtualizerRef.current = virtualizer;
    return () => {
      virtualizerRef.current = null;
    };
  }, [virtualizer, virtualizerRef]);

  // TanStack skips measuring rows that mount while the list is scrolling (and for 150 ms after) and leaves them to
  // its ResizeObserver, whose re-render lands a frame or more later; until then those rows sit at their estimated
  // positions and overlap. Measuring every rendered row after each commit makes any frame that paints consistent:
  // a size change re-renders synchronously, before paint, and stops once nothing moves.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const sizes = new Map(virtualizer.getVirtualItems().map((v) => [v.index, v.size]));
    for (const child of inner.children) {
      if (!(child instanceof HTMLElement)) continue;
      const index = Number(child.dataset["index"]);
      const measured = Math.round(child.getBoundingClientRect().height);
      if (sizes.has(index) && sizes.get(index) !== measured) virtualizer.resizeItem(index, measured);
    }
  });

  useLayoutEffect(() => {
    if (startAtEnd && items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    // Only on mount: later growth is followOutput's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={scrollRef}
      className={cx(s.scroller, props.className)}
      role={props.role ?? "list"}
      aria-label={props["aria-label"]}
    >
      <div ref={innerRef} className={s.inner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (item === undefined) return null;
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              className={s.row}
              role={props.role === "presentation" ? "presentation" : "listitem"}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {props.renderItem(item, row.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
