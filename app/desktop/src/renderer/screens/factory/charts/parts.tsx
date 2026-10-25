// What the Factory's three charts share: their width, the hover card, the legend, and the stacked columns that
// charts A and C both are. Plain SVG drawn from the tokens, as the time inspector draws its marks: no chart library.
// The hover is per mark (dataviz): each column is its own hit target over the whole plot height, and the arrow keys
// walk the same targets with the same card, so nothing needs a pointer.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Text, cx } from "../../../ui";
import { GAP, columnPath, stack, type Column } from "../model";
import s from "../Factory.module.css";

/** The element's content width, kept current; 0 until it is laid out. */
export const useWidth = (ref: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = () => setWidth(Math.floor(el.clientWidth));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
};

export interface CardLine {
  readonly text: string;
  /** A series' class: the row is keyed with a short stroke of its colour. */
  readonly key?: string | undefined;
  readonly tone?: "quiet" | "warning" | undefined;
}

export interface Card {
  readonly title: string;
  readonly lines: readonly CardLine[];
  readonly hint?: string | undefined;
}

export interface Hover {
  readonly card: Card;
  /** Viewport px. */
  readonly x: number;
  readonly y: number;
}

/** The one floating card, kept inside the window. Values lead and names follow (dataviz). */
export function HoverCard({ hover }: { hover: Hover }) {
  const ref = useRef<HTMLDivElement>(null);
  const { x, y, card } = hover;
  const [pos, setPos] = useState({ left: x + 12, top: y + 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const margin = 8;
    const left = Math.min(x + 12, window.innerWidth - el.offsetWidth - margin);
    const top = y + 16 + el.offsetHeight > window.innerHeight - margin ? Math.max(margin, y - el.offsetHeight - 8) : y + 16;
    setPos({ left: Math.max(margin, left), top });
  }, [x, y, card]);
  return (
    <div ref={ref} className={cx(s.card)} style={pos} role="tooltip">
      <Text strong>{card.title}</Text>
      {card.lines.map((l, i) => (
        <span key={i} className={cx(s.cardRow)}>
          {l.key !== undefined ? <span className={cx(s.lineKey, l.key)} aria-hidden /> : null}
          <Text size="xs" tone={l.tone ?? "default"} tabular>
            {l.text}
          </Text>
        </span>
      ))}
      {card.hint !== undefined ? (
        <Text as="div" size="xs" tone="quiet">
          {card.hint}
        </Text>
      ) : null}
    </div>
  );
}

export interface Series<K extends string> {
  readonly key: K;
  readonly label: string;
  /** Its direct label beside the plot, where the legend's name is too long. */
  readonly short?: string;
  /** The slot's class (s1…s5). */
  readonly slot: string;
  /** Its marks take the texture where hue can't carry identity (estimated figures). */
  readonly estimated?: boolean;
}

/** The legend, a row above the plot: a swatch shaped like the mark beside each name, in the series' order. */
export function Legend<K extends string>({ series, compare }: { series: readonly Series<K>[]; compare?: boolean }) {
  return (
    <div className={cx(s.legend)} aria-hidden>
      {series.map((x) => (
        <span key={x.key} className={cx(s.key)}>
          <span className={cx(s.swatch, x.slot)} />
          <Text size="xs" tone="quiet">
            {x.estimated === true ? `${x.label} (estimated)` : x.label}
          </Text>
        </span>
      ))}
      {compare === true ? (
        <span className={cx(s.key)}>
          <span className={cx(s.previousKey)} />
          <Text size="xs" tone="quiet">
            The period before
          </Text>
        </span>
      ) : null}
    </div>
  );
}

export const PLOT_H = 160;
export const TOP = 8;
export const BOTTOM = 20;
export const LEFT = 40;
/**
 * Right of the plot: room for direct labels, the same on all three charts so a day lines up down the screen (the
 * charts share their x domain). Narrow, just enough for the last x label.
 */
export const gutterFor = (width: number): number => (width >= 560 ? 132 : 24);
/** The widest a column gets: never the whole slot (dataviz: thin marks, air between). */
const MAX_BAR = 24;
/** Room for an x label, "Oct 12" at 11 px, and the air between two. */
const X_LABEL_W = 60;

export interface StackedProps<K extends string> {
  readonly label: string;
  readonly columns: readonly Column[];
  readonly series: readonly Series<K>[];
  readonly value: (c: Column, key: K) => number;
  readonly ticks: (max: number) => number[];
  readonly tickLabel: (v: number) => string;
  readonly card: (c: Column) => Card;
  /** A column picked: the list below shows its days. */
  readonly picked?: Column | undefined;
  readonly onPick?: ((c: Column) => void) | undefined;
  /** The period before, column for column (compare): its total is a short quiet rule over each column. */
  readonly previous?: readonly Column[] | undefined;
  /** Right of the plot: direct labels for the last non-empty column's segments, when there's room. */
  readonly directLabels?: boolean;
  readonly onHover: (h: Hover | undefined) => void;
}

/** Stacked columns on one count axis, zero days an empty slot on the baseline. */
export function StackedColumns<K extends string>(p: StackedProps<K>) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [active, setActive] = useState<number | undefined>();
  const gutter = gutterFor(width);
  const plotW = Math.max(0, width - LEFT - gutter);
  const n = p.columns.length;
  const slot = n === 0 ? 0 : plotW / n;
  const bar = Math.max(2, Math.min(MAX_BAR, slot - GAP));
  const sumOf = (c: Column) => p.series.reduce((a, x) => a + p.value(c, x.key), 0);
  const totals = p.columns.map(sumOf);
  const before = p.previous?.map(sumOf);
  const ticks = p.ticks(Math.max(0, ...totals, ...(before ?? [])));
  const top = ticks.at(-1) ?? 1;
  const baseline = TOP + PLOT_H;
  const px = (v: number) => (v / top) * PLOT_H;
  const every = Math.max(1, Math.ceil(X_LABEL_W / Math.max(1, slot)));
  const xOf = (i: number) => LEFT + i * slot + (slot - bar) / 2;

  const show = (i: number, at?: { x: number; y: number }) => {
    const c = p.columns[i];
    if (c === undefined) return;
    setActive(i);
    const r = box.current?.getBoundingClientRect();
    p.onHover({ card: p.card(c), x: at?.x ?? (r?.left ?? 0) + xOf(i) + bar, y: at?.y ?? (r?.top ?? 0) + TOP });
  };
  const hide = () => {
    setActive(undefined);
    p.onHover(undefined);
  };
  const onKey = (e: KeyboardEvent) => {
    const at = active ?? -1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      show(Math.min(n - 1, Math.max(0, e.key === "ArrowRight" ? at + 1 : at < 0 ? n - 1 : at - 1)));
    } else if ((e.key === "Enter" || e.key === " ") && active !== undefined) {
      e.preventDefault();
      const c = p.columns[active];
      if (c !== undefined) p.onPick?.(c);
    } else if (e.key === "Escape") hide();
  };

  // Direct labels: each series' name beside its segment of the last column that has any, bottom up, nudged up
  // only as far as the one below needs, and dropped past the top (the legend carries it).
  const last = totals.findLastIndex((t) => t > 0);
  const labels: { key: K; label: string; y: number }[] = [];
  if (p.directLabels === true && gutter > 24 && last >= 0) {
    const c = p.columns[last];
    const segs = c === undefined ? [] : stack(p.series.map((x) => [x.key, p.value(c, x.key)] as const), px, baseline);
    let floor = Number.POSITIVE_INFINITY;
    for (const seg of segs) {
      const mid = Math.min(seg.y + seg.h / 2, floor - 14);
      if (mid < TOP + 4) break;
      const series = p.series.find((x) => x.key === seg.key);
      const name = series?.short ?? series?.label ?? "";
      labels.push({ key: seg.key, label: name, y: mid });
      floor = mid;
    }
  }

  return (
    <div ref={box} className={cx(s.plot)}>
      {width > 0 ? (
        <svg
          width={width}
          height={baseline + BOTTOM}
          role="img"
          aria-label={p.label}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={hide}
          onPointerLeave={hide}
        >
          {p.series.some((x) => x.estimated === true) ? (
            <defs>
              <pattern id="factory-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="CanvasText" strokeWidth="2" />
              </pattern>
            </defs>
          ) : null}
          {ticks.map((t) => (
            <g key={t}>
              <line className={cx(t === 0 ? s.baseline : s.grid)} x1={LEFT} x2={LEFT + plotW} y1={baseline - px(t)} y2={baseline - px(t)} />
              <text className={cx(s.tick)} x={LEFT - 6} y={baseline - px(t)} dy="0.32em" textAnchor="end">
                {p.tickLabel(t)}
              </text>
            </g>
          ))}
          {p.columns.map((c, i) => {
            const x = xOf(i);
            const segs = stack(p.series.map((x) => [x.key, p.value(c, x.key)] as const), px, baseline);
            const picked = p.picked !== undefined && p.picked.from === c.from;
            return (
              <g key={c.from}>
                {picked ? <rect className={cx(s.picked)} x={LEFT + i * slot} y={TOP} width={slot} height={PLOT_H} /> : null}
                {segs.map((seg) => {
                  const series = p.series.find((x) => x.key === seg.key);
                  return (
                    <path
                      key={seg.key}
                      className={cx(series?.slot, series?.estimated === true && s.estimated)}
                      d={columnPath(x, seg.y, bar, seg.h, seg.top)}
                    />
                  );
                })}
                {before?.[i] !== undefined && (before[i] ?? 0) > 0 ? (
                  <line className={cx(s.previous)} x1={x - 2} x2={x + bar + 2} y1={baseline - px(before[i] ?? 0)} y2={baseline - px(before[i] ?? 0)} />
                ) : null}
                {i % every === 0 ? (
                  <text className={cx(s.tick)} x={LEFT + i * slot + slot / 2} y={baseline + 14} textAnchor={i === 0 && slot < X_LABEL_W ? "start" : "middle"}>
                    {c.label.split(" to ")[0]}
                  </text>
                ) : null}
              </g>
            );
          })}
          {labels.map((l) => (
            <text key={l.key} className={cx(s.directLabel)} x={LEFT + plotW + 8} y={l.y} dy="0.32em">
              {l.label}
            </text>
          ))}
          {/* Hit targets last, over the marks: the whole slot, the full plot height. */}
          {p.columns.map((c, i) => (
            <rect
              key={c.from}
              className={cx(s.hit, active === i && s.active)}
              x={LEFT + i * slot}
              y={TOP}
              width={slot}
              height={PLOT_H}
              onPointerMove={(e) => show(i, { x: e.clientX, y: e.clientY })}
              onClick={() => p.onPick?.(c)}
            />
          ))}
        </svg>
      ) : (
        <div style={{ height: baseline + BOTTOM }} />
      )}
    </div>
  );
}
