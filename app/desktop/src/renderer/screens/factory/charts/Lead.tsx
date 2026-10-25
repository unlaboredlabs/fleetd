// Chart B: order to merged, one dot per landed change that belongs to an order, on a log time axis (10m, 1h, 6h,
// 1d, 1w), with the period's median as a line labelled at the right. One series in one hue, so no legend box: the
// title names it. Merged by hand is hollow, so the route is never colour alone. The pointer only has to be nearest
// a dot (within 24 px), and the arrow keys walk the dots in time order.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { MetricsMerge, RepoCoverage } from "../../../../shared/contracts";
import { Text, cx } from "../../../ui";
import { LOG_TICKS, ROUTE_LABEL, dayLabel, dayX, fmtMs, knownRoute, logDomain, logScale, mergeName, stages } from "../model";
import { BOTTOM, LEFT, PLOT_H, TOP, gutterFor, useWidth, type Hover } from "./parts";
import s from "../Factory.module.css";

/** How near the pointer must be to a dot to show it. */
const REACH = 24;

export interface LeadChartProps {
  readonly merges: readonly MetricsMerge[];
  /** The range's calendar days, oldest first: the x axis the column charts share. */
  readonly days: readonly string[];
  readonly medianMs: number | undefined;
  readonly coverage: readonly RepoCoverage[];
  /** An order's title, when the app knows it. */
  readonly orderTitle: (workstreamId: string) => string | undefined;
  readonly onHover: (h: Hover | undefined) => void;
}

export function LeadChart({ merges, days, medianMs, coverage, orderTitle, onHover }: LeadChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [active, setActive] = useState<number | undefined>();
  const dots = merges.filter((m) => m.orderToMergedMs !== undefined).toSorted((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  const values = dots.map((m) => m.orderToMergedMs ?? 0);
  const domain = logDomain(medianMs === undefined ? values : [...values, medianMs]);
  const baseline = TOP + PLOT_H;
  const y = logScale(domain, TOP, baseline);
  const right = gutterFor(width);
  const plotW = Math.max(0, width - LEFT - right);
  // The same x as the column charts: one equal slot per calendar day, whatever the range's last day holds so far.
  const slot = days.length === 0 ? 0 : plotW / days.length;
  const index = new Map(days.map((d, i) => [d, i]));
  const x = (iso: string) => LEFT + dayX(iso, index) * slot;
  const ticks = LOG_TICKS.filter(([v]) => v >= domain[0] && v <= domain[1]);
  // Dates along the bottom, about every 80 px, at the start of their day's slot.
  const stride = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 80))));
  const xTicks = days.flatMap((d, i) => (i % stride === 0 ? [{ day: d, at: LEFT + i * slot }] : []));

  const show = (i: number, at?: { x: number; y: number }) => {
    const m = dots[i];
    if (m === undefined) return;
    setActive(i);
    const r = box.current?.getBoundingClientRect();
    const route = knownRoute(m.route);
    const order = m.workstreamId === undefined ? undefined : (orderTitle(m.workstreamId) ?? `order ${m.workstreamId}`);
    onHover({
      x: at?.x ?? (r?.left ?? 0) + x(m.mergedAt),
      y: at?.y ?? (r?.top ?? 0) + y(m.orderToMergedMs ?? 0),
      card: {
        title: `${fmtMs(m.orderToMergedMs ?? 0)} order to merged`,
        lines: [
          { text: `${mergeName(m, coverage)}${m.title === undefined ? "" : `: ${m.title}`}` },
          ...(order === undefined ? [] : [{ text: `For ${order}`, tone: "quiet" as const }]),
          ...stages(m).map((t) => ({ text: t, tone: "quiet" as const })),
          ...(m.requestedBasis === "opened" ? [{ text: "Timed from when the lead opened the order", tone: "warning" as const }] : []),
          { text: route === undefined ? "Merged" : ROUTE_LABEL[route], tone: "quiet" as const },
        ],
      },
    });
  };
  const hide = () => {
    setActive(undefined);
    onHover(undefined);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best: number | undefined;
    let dist = REACH * REACH;
    dots.forEach((m, i) => {
      const d = (x(m.mergedAt) - px) ** 2 + (y(m.orderToMergedMs ?? 0) - py) ** 2;
      if (d <= dist) {
        dist = d;
        best = i;
      }
    });
    if (best === undefined) hide();
    else show(best, { x: e.clientX, y: e.clientY });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") {
      if (e.key === "Escape") hide();
      return;
    }
    e.preventDefault();
    const at = active ?? -1;
    show(Math.min(dots.length - 1, Math.max(0, e.key === "ArrowRight" ? at + 1 : at < 0 ? dots.length - 1 : at - 1)));
  };

  return (
    <section className={cx(s.chart)} aria-labelledby="factory-lead">
      <div className={cx(s.chartHead)}>
        <Text as="h2" strong id="factory-lead">
          Order to merged
        </Text>
        <div className={cx(s.legend)} aria-hidden>
          <span className={cx(s.key)}>
            <span className={cx(s.swatchDot)} />
            <Text size="xs" tone="quiet">
              {ROUTE_LABEL.train}
            </Text>
          </span>
          <span className={cx(s.key)}>
            <span className={cx(s.swatchHollow)} />
            <Text size="xs" tone="quiet">
              {ROUTE_LABEL.fleetd_by_hand}
            </Text>
          </span>
        </div>
      </div>
      <div ref={box} className={cx(s.plot)}>
        {width > 0 ? (
          <svg
            width={width}
            height={baseline + BOTTOM}
            role="img"
            aria-label={`Order to merged for ${dots.length} changes${medianMs === undefined ? "" : `, median ${fmtMs(medianMs)}`}: the list below has each one.`}
            tabIndex={dots.length > 0 ? 0 : -1}
            onKeyDown={onKey}
            onBlur={hide}
            onPointerMove={onMove}
            onPointerLeave={hide}
          >
            {ticks.map(([v, label]) => (
              <g key={v}>
                <line className={cx(s.grid)} x1={LEFT} x2={LEFT + plotW} y1={y(v)} y2={y(v)} />
                <text className={cx(s.tick)} x={LEFT - 6} y={y(v)} dy="0.32em" textAnchor="end">
                  {label}
                </text>
              </g>
            ))}
            <line className={cx(s.baseline)} x1={LEFT} x2={LEFT + plotW} y1={baseline} y2={baseline} />
            {xTicks.map((t, i) => (
              <text key={t.day} className={cx(s.tick)} x={t.at} y={baseline + 14} textAnchor={i === 0 ? "start" : "middle"}>
                {dayLabel(t.day)}
              </text>
            ))}
            {medianMs !== undefined ? (
              <g>
                <line className={cx(s.median)} x1={LEFT} x2={LEFT + plotW} y1={y(medianMs)} y2={y(medianMs)} />
                {right > 24 ? (
                  <text className={cx(s.directLabel)} x={LEFT + plotW + 8} y={y(medianMs)} dy="0.32em">
                    {`median ${fmtMs(medianMs)}`}
                  </text>
                ) : null}
              </g>
            ) : null}
            {dots.map((m, i) => (
              <circle
                key={`${m.repo}#${m.prNumber ?? m.sha ?? i}`}
                className={cx(m.route === "fleetd_by_hand" ? s.dotHollow : s.dot, active === i && s.dotActive)}
                cx={x(m.mergedAt)}
                cy={y(m.orderToMergedMs ?? 0)}
                r={4}
              />
            ))}
          </svg>
        ) : (
          <div style={{ height: baseline + BOTTOM }} />
        )}
      </div>
    </section>
  );
}
