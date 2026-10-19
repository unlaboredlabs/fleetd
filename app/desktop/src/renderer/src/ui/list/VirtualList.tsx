import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { cx } from "../lib/cx";
import s from "./VirtualList.module.css";

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
  className?: string;
  /** For scroll-to-index and friends. */
  virtualizerRef?: RefObject<Virtualizer<HTMLDivElement, Element> | null>;
  "aria-label"?: string;
}

/**
 * A long list that renders only what is on screen. It fills its parent's height and scrolls itself. Rows size to
 * their content (wrapped text included) and are re-measured when they resize.
 */
export function VirtualList<T>(props: VirtualListProps<T>) {
  const { items, getKey, followOutput, startAtEnd, gap = 0 } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

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
  });

  const { virtualizerRef } = props;
  useEffect(() => {
    if (!virtualizerRef) return;
    virtualizerRef.current = virtualizer;
    return () => {
      virtualizerRef.current = null;
    };
  }, [virtualizer, virtualizerRef]);

  useLayoutEffect(() => {
    if (startAtEnd && items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    // Only on mount: later growth is followOutput's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (followOutput && atEnd.current && items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
  }, [followOutput, items.length, virtualizer]);

  return (
    <div
      ref={scrollRef}
      className={cx(s.scroller, props.className)}
      role="list"
      aria-label={props["aria-label"]}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      <div className={s.inner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (item === undefined) return null;
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              className={s.row}
              role="listitem"
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
