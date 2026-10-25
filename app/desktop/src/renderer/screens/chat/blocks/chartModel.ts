// A chart block's geometry, from its spec to plain numbers the SVG draws. Pure.
import type { ChartBlock } from "../../../../shared/contracts";

/** Up to five series take the theme's series colours in order; past that a chart reads as noise. */
export const SERIES_MAX = 5;

/** Round, evenly spaced y ticks from 0 (or the lowest value, when it is negative) up past the highest. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = max <= lo ? lo + 1 : max;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v < hi + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** "1.2K", "3.4M", "12", "0.25": ticks and labels stay short. */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e3) return `${trim(v / 1e3)}K`;
  return trim(v);
}
const trim = (v: number): string => String(Number(v.toFixed(Math.abs(v) >= 10 ? 0 : 2)));

export interface Geometry {
  readonly width: number;
  readonly height: number;
  /** The plot's box inside the SVG. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly ticks: readonly number[];
  readonly y: (v: number) => number;
  /** The centre of each x label's band. */
  readonly xs: readonly number[];
  readonly band: number;
  /** Which x labels to print: every one when they fit, else evenly thinned, the last always. */
  readonly shownX: readonly number[];
}

export function geometry(chart: Pick<ChartBlock, "x" | "series">, width: number, height: number): Geometry {
  const values = chart.series.slice(0, SERIES_MAX).flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const label = Math.max(...ticks.map((t) => compact(t).length));
  const left = 8 + label * 7;
  const right = width - 8;
  const top = 8;
  const bottom = height - 22;
  const lo = ticks[0] ?? 0;
  const hi = ticks.at(-1) ?? 1;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
  const n = chart.x.length;
  const band = (right - left) / Math.max(1, n);
  const xs = chart.x.map((_, i) => left + band * (i + 0.5));
  const longest = Math.max(...chart.x.map((x) => x.length), 1);
  const every = Math.max(1, Math.ceil((longest * 6.5 + 8) / band));
  const shownX: number[] = [];
  for (let i = 0; i < n; i += every) shownX.push(i);
  const lastShown = shownX.at(-1) ?? 0;
  if (lastShown !== n - 1) {
    if (n - 1 - lastShown < every && shownX.length > 1) shownX.pop();
    shownX.push(n - 1);
  }
  return { width, height, left, right, top, bottom, ticks, y, xs, band, shownX };
}

/** An SVG path through the points; an area closes it down to the baseline. */
export function linePath(xs: readonly number[], ys: readonly number[]): string {
  return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${(ys[i] ?? 0).toFixed(1)}`).join("");
}

export function areaPath(xs: readonly number[], ys: readonly number[], base: number): string {
  if (xs.length === 0) return "";
  return `${linePath(xs, ys)}L${(xs.at(-1) ?? 0).toFixed(1)},${base.toFixed(1)}L${(xs[0] ?? 0).toFixed(1)},${base.toFixed(1)}Z`;
}

/** A column with a rounded data end and a square foot on the baseline (negative values hang down from it). */
export function barPath(x: number, w: number, from: number, to: number): string {
  const h = Math.abs(to - from);
  const r = Math.min(4, w / 2, h);
  const up = to < from;
  const tip = to;
  const s = up ? 1 : -1;
  return [
    `M${x.toFixed(1)},${from.toFixed(1)}`,
    `L${x.toFixed(1)},${(tip + s * r).toFixed(1)}`,
    `Q${x.toFixed(1)},${tip.toFixed(1)} ${(x + r).toFixed(1)},${tip.toFixed(1)}`,
    `L${(x + w - r).toFixed(1)},${tip.toFixed(1)}`,
    `Q${(x + w).toFixed(1)},${tip.toFixed(1)} ${(x + w).toFixed(1)},${(tip + s * r).toFixed(1)}`,
    `L${(x + w).toFixed(1)},${from.toFixed(1)}Z`,
  ].join("");
}
