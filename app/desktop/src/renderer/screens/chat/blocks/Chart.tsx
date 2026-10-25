// A chart block: line, bar or area, drawn as plain SVG at the bubble's width. The series take the theme's series
// colours in order; words stay in the text colours. Hovering shows each series' value at that label, and the data
// is one press away as a table.
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { ChartBlock } from "../../../../shared/contracts";
import { Button, Text } from "../../../ui";
import { areaPath, barPath, compact, geometry, linePath, SERIES_MAX } from "./chartModel";
import { DataTable } from "./Table";
import b from "./blocks.module.css";

const HEIGHT = 180;
const color = (i: number) => `var(--series-${String(i + 1)})`;

export function Chart({ chart }: { chart: ChartBlock }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [at, setAt] = useState<number>();
  const [asTable, setAsTable] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    setWidth(Math.floor(el.clientWidth));
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable]);
  const series = chart.series.slice(0, SERIES_MAX);
  const unit = chart.unit === undefined ? "" : ` ${chart.unit}`;
  const title = (
    <div className={b.head}>
      <Text size="sm" strong>
        {chart.title}
      </Text>
      <Button variant="ghost" onClick={() => setAsTable((t) => !t)}>
        {asTable ? "Show chart" : "Show data"}
      </Button>
    </div>
  );
  if (asTable) {
    return (
      <div className={b.card}>
        {title}
        <DataTable columns={["", ...series.map((s) => s.name + unit)]} rows={chart.x.map((x, i) => [x, ...series.map((s) => compact(s.values[i] ?? 0))])} />
      </div>
    );
  }
  const g = width > 0 ? geometry(chart, width, HEIGHT) : undefined;
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (g === undefined) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = Math.floor((x - g.left) / g.band);
    setAt(i >= 0 && i < chart.x.length ? i : undefined);
  };
  const base = g === undefined ? 0 : g.y(Math.max(0, g.ticks[0] ?? 0));
  const k = series.length;
  const barW = g === undefined ? 0 : Math.min(24, (g.band * 0.72 - 2 * (k - 1)) / k);
  return (
    <div className={b.card}>
      {title}
      {k > 1 ? (
        <div className={b.legend}>
          {series.map((s, i) => (
            <span key={s.name} className={b.key}>
              <span className={b.swatch} style={{ background: color(i) }} aria-hidden />
              <Text size="xs" tone="quiet">
                {s.name}
              </Text>
            </span>
          ))}
        </div>
      ) : null}
      <div ref={box} className={b.plot}>
        {g === undefined ? null : (
          <svg
            width={g.width}
            height={g.height}
            role="img"
            aria-label={`${chart.title}: ${chart.chart} chart of ${series.map((s) => s.name).join(", ")}`}
            onPointerMove={move}
            onPointerLeave={() => setAt(undefined)}
          >
            {g.ticks.map((t) => (
              <g key={t}>
                <line className={b.grid} x1={g.left} x2={g.right} y1={g.y(t)} y2={g.y(t)} />
                <text className={b.tick} x={g.left - 6} y={g.y(t)} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {g.shownX.map((i) => (
              <text key={i} className={b.tick} x={g.xs[i]} y={g.bottom + 15} textAnchor="middle">
                {chart.x[i]}
              </text>
            ))}
            {at !== undefined ? <line className={b.cross} x1={g.xs[at]} x2={g.xs[at]} y1={g.top} y2={g.bottom} /> : null}
            {series.map((s, si) => {
              const ys = s.values.map(g.y);
              if (chart.chart === "bar") {
                return (
                  <g key={s.name} fill={color(si)}>
                    {s.values.map((v, i) => {
                      const x = (g.xs[i] ?? 0) - (k * barW + 2 * (k - 1)) / 2 + si * (barW + 2);
                      return <path key={i} d={barPath(x, barW, base, g.y(v))} opacity={at === undefined || at === i ? 1 : 0.55} />;
                    })}
                  </g>
                );
              }
              return (
                <g key={s.name}>
                  {chart.chart === "area" ? <path d={areaPath(g.xs, ys, base)} fill={color(si)} opacity={0.12} /> : null}
                  <path d={linePath(g.xs, ys)} fill="none" stroke={color(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {at !== undefined ? <circle className={b.ring} cx={g.xs[at]} cy={ys[at]} r={4} fill={color(si)} /> : null}
                </g>
              );
            })}
          </svg>
        )}
        {g !== undefined && at !== undefined ? (
          <div className={b.tip} style={{ left: Math.min(g.xs[at] ?? 0, g.width - 140) }} role="status">
            <Text size="xs" strong>
              {chart.x[at]}
            </Text>
            {series.map((s, si) => (
              <span key={s.name} className={b.key}>
                <span className={b.swatch} style={{ background: color(si) }} aria-hidden />
                <Text size="xs" tone="quiet">
                  {s.name}
                </Text>
                <Text size="xs" tabular>
                  {`${compact(s.values[at] ?? 0)}${unit}`}
                </Text>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
