// The order timeline: one row per lane, each row's spans as bars on one time axis, the critical path as a line
// under them. Bars are painted on one canvas (only the visible rows); labels, the axis and the hover card are DOM.
// Drag to zoom, Ctrl/⌘ + wheel to zoom at the pointer, Shift + wheel to pan, click a bar for its transcript.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Button, RoleTag, Text, Truncate, cx } from "../../ui";
import { barCard, laneCard, pathCard, type Card } from "./cards";
import { CAT_LABEL, SHOWN, clockMs, fmtDur, type Names } from "./format";
import { hit, padded, rowRange, ticks, type Bar, type Model } from "./model";
import { ROW_H, documentTheme, paintPath, paintRows, paletteCache, readPalette, watchDocumentTheme } from "./paint";
import type { Span } from "./types";
import s from "./Time.module.css";

const LABEL_W = 240;
const MIN_VIEW_MS = 1_000;

type Hover =
  | { readonly kind: "bar"; readonly row: number; readonly bar: Bar; readonly x: number; readonly y: number }
  | { readonly kind: "lane"; readonly row: number; readonly x: number; readonly y: number }
  | { readonly kind: "path"; readonly seg: number; readonly x: number; readonly y: number };

export interface TimelineProps {
  readonly model: Model;
  readonly names: Names;
  readonly nowMs: number;
  /** The zoomed range in hub ms; undefined shows the whole order. */
  readonly view: readonly [number, number] | undefined;
  readonly onView: (view: readonly [number, number] | undefined) => void;
  /** Highlighted span ids. */
  readonly lit: ReadonlySet<number> | undefined;
  /** A click on one span: the screen opens its check, its transcript, or zooms to it. */
  readonly onSpan: (span: Span) => void;
}

const useSize = (ref: RefObject<HTMLElement | null>): { width: number; height: number } => {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
};

const currentDpr = () => window.devicePixelRatio || 1;

/**
 * Changes of the device pixel ratio (the window moved between a Retina and a 1x display, or the zoom changed): the
 * media query for the current ratio stops matching, and the canvases repaint at the new backing scale.
 */
const watchDpr = (onChange: () => void): (() => void) => {
  let mq: MediaQueryList | undefined;
  const arm = () => {
    mq?.removeEventListener("change", fire);
    mq = window.matchMedia(`(resolution: ${currentDpr()}dppx)`);
    mq.addEventListener("change", fire);
  };
  function fire() {
    arm();
    onChange();
  }
  arm();
  return () => mq?.removeEventListener("change", fire);
};

const sizeCanvas = (c: HTMLCanvasElement, w: number, h: number, dpr: number) => {
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw) c.width = pw;
  if (c.height !== ph) c.height = ph;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
};

export function Timeline({ model: m, names, nowMs, view, onView, lit, onSpan }: TimelineProps) {
  const theme = useSyncExternalStore(watchDocumentTheme, documentTheme);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<HTMLCanvasElement>(null);
  const barsRef = useRef<Map<number, Bar[]>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [drag, setDrag] = useState<readonly [number, number] | undefined>();
  const [hover, setHover] = useState<Hover | undefined>();
  const track = useSize(trackRef);
  const outer = useSize(scrollerRef);
  // The canvas covers the visible rows only; the scroller's own height scrolls under it.
  const size = { width: track.width, height: Math.min(outer.height, m.rows.length * ROW_H) };
  const dpr = useSyncExternalStore(watchDpr, currentDpr);
  const [v0, v1] = view ?? [m.startMs, m.endMs];
  const tickList = useMemo(() => ticks(v0, v1), [v0, v1]);
  // The category colours come from the tokens, so they are read again when the theme changes; patterns are cached.
  const [palettes] = useState(() => paletteCache(readPalette));

  // Painted synchronously on every change (a repaint takes well under a millisecond at 15k spans), so no frame
  // shows a canvas older than the DOM around it: after a theme change the bars are already in the new palette.
  useLayoutEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    const root = rootRef.current;
    if (c == null || ctx == null || root === null || size.width <= 0) return;
    sizeCanvas(c, size.width, size.height, dpr);
    const palette = palettes(theme, dpr, root);
    barsRef.current = paintRows(ctx, { model: m, v0, v1, width: size.width, height: size.height, scrollTop, dpr, ticks: tickList, lit, drag, palette });
  }, [m, v0, v1, size.width, size.height, scrollTop, dpr, tickList, lit, drag, palettes, theme]);

  useLayoutEffect(() => {
    const c = pathRef.current;
    const ctx = c?.getContext("2d");
    const root = rootRef.current;
    if (c == null || ctx == null || root === null || size.width <= 0) return;
    sizeCanvas(c, size.width, ROW_H, dpr);
    paintPath(ctx, m, v0, v1, size.width, ROW_H, dpr, palettes(theme, dpr, root));
  }, [m, v0, v1, size.width, dpr, palettes, theme]);

  const msAt = useCallback((x: number) => v0 + ((v1 - v0) * Math.min(Math.max(x, 0), size.width)) / Math.max(1, size.width), [v0, v1, size.width]);

  const zoomTo = useCallback(
    (a: number, b: number) => {
      if (b - a < MIN_VIEW_MS) {
        const mid = (a + b) / 2;
        [a, b] = [mid - MIN_VIEW_MS / 2, mid + MIN_VIEW_MS / 2];
      }
      onView(a <= m.startMs && b >= m.endMs ? undefined : [a, b]);
    },
    [m.startMs, m.endMs, onView],
  );

  /** Zooms by `factor` around time `at`, clamped to the order. */
  const zoomAt = useCallback(
    (at: number, factor: number) => {
      const whole = m.endMs - m.startMs;
      const span = Math.min(whole, Math.max(MIN_VIEW_MS, (v1 - v0) * factor));
      let a = at - ((at - v0) / (v1 - v0)) * span;
      a = Math.min(Math.max(a, m.startMs), m.endMs - span);
      zoomTo(a, a + span);
    },
    [m.startMs, m.endMs, v0, v1, zoomTo],
  );

  const pan = useCallback(
    (ms: number) => {
      if (view === undefined) return;
      const span = v1 - v0;
      const a = Math.min(Math.max(v0 + ms, m.startMs), m.endMs - span);
      onView([a, a + span]);
    },
    [view, v0, v1, m.startMs, m.endMs, onView],
  );

  // Wheel zoom needs a non-passive listener to keep the page from zooming instead.
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      const x = e.clientX - el.getBoundingClientRect().left;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(msAt(x), Math.exp(e.deltaY * 0.002));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        pan(((e.shiftKey ? e.deltaY : e.deltaX) / Math.max(1, size.width)) * (v1 - v0));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, pan, msAt, size.width, v0, v1]);

  const where = (e: PointerEvent) => {
    const r = trackRef.current?.getBoundingClientRect();
    const x = e.clientX - (r?.left ?? 0);
    const y = e.clientY - (r?.top ?? 0);
    return { x, row: Math.floor((y + scrollTop) / ROW_H) };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x } = where(e);
    setDrag([x, x]);
    setHover(undefined);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const { x, row } = where(e);
    if (drag !== undefined) {
      setDrag([drag[0], x]);
      return;
    }
    const bar = hit(barsRef.current.get(row) ?? [], x);
    setHover((prev) => {
      if (bar === undefined) return prev?.kind === "bar" ? undefined : prev;
      if (prev?.kind === "bar" && prev.row === row && prev.bar.first === bar.first && prev.bar.n === bar.n) return prev;
      return { kind: "bar", row, bar, x: e.clientX, y: e.clientY };
    });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag;
    setDrag(undefined);
    if (d === undefined) return;
    if (Math.abs(d[1] - d[0]) > 4) {
      zoomTo(msAt(Math.min(d[0], d[1])), msAt(Math.max(d[0], d[1])));
      return;
    }
    const { x, row } = where(e);
    const bar = hit(barsRef.current.get(row) ?? [], x);
    if (bar === undefined) return;
    if (bar.n > 1) {
      zoomTo(...padded(bar.start, bar.end));
      return;
    }
    const span = m.spans[m.itemSpan[bar.first] ?? -1];
    if (span === undefined) return;
    if (span.extra?.url === undefined && (span.itemId === undefined || span.threadId === undefined)) zoomTo(...padded(bar.start, bar.end));
    else onSpan(span);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mid = (v0 + v1) / 2;
    const step = (v1 - v0) / 4;
    if (e.key === "+" || e.key === "=") zoomAt(mid, 0.5);
    else if (e.key === "-" || e.key === "_") zoomAt(mid, 2);
    else if (e.key === "ArrowLeft") pan(-step);
    else if (e.key === "ArrowRight") pan(step);
    else if (e.key === "0") onView(undefined);
    else return;
    e.preventDefault();
  };

  const visible = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW_H));
    const last = Math.min(m.rows.length, Math.ceil((scrollTop + size.height) / ROW_H) + 1);
    const out: number[] = [];
    for (let r = first; r < last; r += 1) out.push(r);
    return out;
  }, [scrollTop, size.height, m.rows.length]);

  const pathAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = msAt(e.clientX - r.left);
    return m.path.findIndex((seg) => seg.start <= at && at < seg.end);
  };

  const card: Card | undefined =
    hover === undefined
      ? undefined
      : hover.kind === "bar"
        ? barCard(m, hover.row, hover.bar, names, nowMs)
        : hover.kind === "lane"
          ? laneCard(m, hover.row)
          : pathCard(m, hover.seg);

  const total = m.endMs - m.startMs;
  const hasGaps = m.rows.some((r) => r.gaps.length > 0);

  return (
    <div ref={rootRef} className={cx(s.timeline)} data-screen="time.timeline">
      <div className={cx(s.axis)} aria-hidden>
        <div style={{ width: LABEL_W, flex: "none" }} />
        <div className={cx(s.axisTicks)}>
          {tickList.map((t) => (
            <span key={t} className={cx(s.tick)} style={{ left: ((t - v0) / (v1 - v0)) * size.width }}>
              {v1 - v0 < 10 * 60_000 ? clockMs(t) : clockMs(t).slice(0, 5)}
            </span>
          ))}
        </div>
      </div>
      <div ref={scrollerRef} className={cx(s.scroller)} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: m.rows.length * ROW_H, position: "relative" }}>
          <div className={cx(s.sticky)} style={{ height: size.height }}>
            <div className={cx(s.labels)} style={{ width: LABEL_W }}>
              {visible.map((r) => {
                const row = m.rows[r];
                if (row === undefined) return null;
                const range = rowRange(m, row);
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={cx(s.label, row.kind === "check" && s.labelCheck)}
                    style={{ top: r * ROW_H - scrollTop, height: ROW_H }}
                    onClick={() => range !== undefined && zoomTo(range[0], range[1])}
                    onPointerEnter={(e) => setHover({ kind: "lane", row: r, x: e.clientX, y: e.clientY })}
                    onPointerLeave={() => setHover((h) => (h?.kind === "lane" && h.row === r ? undefined : h))}
                    aria-label={`${row.name}: ${fmtDur(row.agentMs)} of agent time. Zoom to this lane.`}
                  >
                    {row.role !== undefined ? <RoleTag role={row.role} width={72} /> : null}
                    {row.kind === "check" ? (
                      <Text size="xs" tone="quiet">
                        ci
                      </Text>
                    ) : null}
                    {row.taskId !== undefined ? (
                      <Text size="sm" mono tone="quiet" className={cx(s.noShrink)}>
                        {row.taskId}
                      </Text>
                    ) : null}
                    <Truncate expand="none" size={row.kind === "check" ? "sm" : "xs"} mono={row.kind === "check"} tone={row.to > row.from ? "default" : "quiet"}>
                      {row.kind === "lead" ? "split across its work" : row.name}
                    </Truncate>
                  </button>
                );
              })}
            </div>
            <div
              ref={trackRef}
              className={cx(s.track)}
              role="img"
              aria-label={`Timeline of ${m.rows.length} lanes, ${clockMs(v0)} to ${clockMs(v1)}. Use the Breakdown tab for the same figures as a table.`}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(undefined)}
              onPointerLeave={() => setHover((h) => (h?.kind === "bar" ? undefined : h))}
            >
              <canvas ref={canvasRef} className={cx(s.canvas)} />
            </div>
          </div>
        </div>
      </div>
      <div className={cx(s.pathRow)}>
        <div className={cx(s.pathLabel)} style={{ width: LABEL_W }}>
          <Text size="xs" strong>
            critical path
          </Text>
          <Text size="xs" tone="quiet">
            {!m.hasPath ? "when the work is done" : m.pathTruncated ? `${fmtDur(total)} (part drawn)` : fmtDur(total)}
          </Text>
        </div>
        <div
          className={cx(s.pathTrack)}
          onPointerMove={(e) => {
            const seg = pathAt(e);
            setHover((h) => (seg < 0 ? (h?.kind === "path" ? undefined : h) : h?.kind === "path" && h.seg === seg ? h : { kind: "path", seg, x: e.clientX, y: e.clientY }));
          }}
          onPointerLeave={() => setHover((h) => (h?.kind === "path" ? undefined : h))}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const at = msAt(e.clientX - r.left);
            const seg = m.path.find((x) => x.start <= at && at < x.end);
            if (seg === undefined) return;
            const span = seg.span === undefined ? undefined : m.spans[seg.span];
            if (span !== undefined && (span.extra?.url !== undefined || (span.itemId !== undefined && span.threadId !== undefined))) onSpan(span);
            else zoomTo(seg.start - 2_000, seg.end + 2_000);
          }}
        >
          <canvas ref={pathRef} className={cx(s.canvas)} />
        </div>
      </div>
      <div className={cx(s.legend)}>
        {SHOWN.map((c) => (
          <span key={c} className={cx(s.legendItem)}>
            <span className={cx(s.swatch, s[`sw_${c}`])} />
            <Text size="xs" tone="quiet">
              {CAT_LABEL[c]}
            </Text>
          </span>
        ))}
        <span className={cx(s.legendItem)}>
          <span className={cx(s.swatch, s.sw_failed)} />
          <Text size="xs" tone="quiet">
            failed
          </Text>
        </span>
        {hasGaps ? (
          <span className={cx(s.legendItem)}>
            <span className={cx(s.gapSwatch)} />
            <Text size="xs" tone="quiet">
              missing data
            </Text>
          </span>
        ) : null}
        <span className={cx(s.grow)} />
        <Text size="xs" tone="quiet">
          drag to zoom · {navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"} + scroll to zoom · click a bar for its transcript
        </Text>
        {view !== undefined ? (
          <Button variant="secondary" onClick={() => onView(undefined)}>
            Whole order
          </Button>
        ) : null}
      </div>
      {card !== undefined && hover !== undefined ? <HoverCard card={card} x={hover.x} y={hover.y} /> : null}
    </div>
  );
}

/** Under the pointer, kept inside the window, with no motion. It takes no pointer events, so it never steals hover. */
function HoverCard({ card, x, y }: { card: Card; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 12, top: y + 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const margin = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(x + 12, window.innerWidth - w - margin);
    const top = y + 16 + h > window.innerHeight - margin ? Math.max(margin, y - h - 8) : y + 16;
    setPos({ left: Math.max(margin, left), top });
  }, [x, y, card]);
  return (
    <div ref={ref} className={cx(s.card)} style={pos} role="tooltip">
      <div className={cx(s.cardHead)}>
        <Text size={card.mono ? "sm" : "md"} mono={card.mono} strong={!card.mono} tone={card.danger === true ? "danger" : "default"}>
          {card.title}
        </Text>
        {card.tag !== undefined ? (
          <Text size="xs" tone="quiet" className={cx(s.noShrink)}>
            {card.tag}
          </Text>
        ) : null}
      </div>
      {card.lines.map((l, i) => (
        <Text key={i} as="div" size="xs" tone="quiet" tabular>
          {l}
        </Text>
      ))}
      {card.warnings?.map((l, i) => (
        <Text key={`w${i}`} as="div" size="xs" tone="warning">
          {l}
        </Text>
      ))}
      {card.onPath === true ? (
        <Text as="div" size="xs" tone="accent">
          on the critical path
        </Text>
      ) : null}
      {card.note !== undefined ? (
        <Text as="div" size="xs" tone="quiet" className={cx(s.cardNote)}>
          {card.note}
        </Text>
      ) : null}
      <Text as="div" size="xs" tone="quiet" className={cx(s.cardNote)}>
        {card.hint}
      </Text>
    </div>
  );
}

