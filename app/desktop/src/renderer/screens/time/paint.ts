// Painting the timeline's rows onto one canvas. Called on a change (data, zoom, scroll, size, theme, highlight,
// drag), never on a timer: nothing repaints while the view is idle. Hover moves only the DOM card.
import { CAT_CODE, bars, type Bar, type Model } from "./model";
import { CATEGORIES } from "./types";

export const ROW_H = 26;
export const BAR_H = 12;
/** Off the critical path, bars drop to this: still 3:1 against the background, as non-text contrast needs. */
export const OFF_PATH = 0.75;
/** With a highlight on, the other bars drop to this. */
export const UNLIT = 0.22;

export interface Palette {
  readonly fill: readonly (string | CanvasPattern | undefined)[];
  readonly edge: readonly (string | undefined)[];
  readonly danger: string;
  readonly accent: string;
  readonly warning: string;
  readonly grid: string;
  readonly selection: string;
}

const cssVar = (el: Element, name: string, fallback: string): string => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

/** A static diagonal hatch: the same tile every paint, so nothing shimmers. */
const hatch = (color: string, line: number, gap: number, dpr: number): CanvasPattern | undefined => {
  const size = Math.round((line + gap) * 2 * dpr);
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const c = tile.getContext("2d");
  if (c === null) return undefined;
  c.strokeStyle = color;
  c.lineWidth = line * dpr;
  c.beginPath();
  for (let o = -size; o <= size * 2; o += size / 2) {
    c.moveTo(o, size);
    c.lineTo(o + size, 0);
  }
  c.stroke();
  return c.createPattern(tile, "repeat") ?? undefined;
};

/**
 * The category colours (spec §8), read from the design tokens: model accent fill; tools quiet fill; machine a
 * warning outline; queue warning hatched; you in the text colour, solid (the loud tone); pipeline quiet stripes.
 */
export const readPalette = (el: Element, dpr: number): Palette => {
  const accent = cssVar(el, "--accent", "#2360c4");
  const quiet = cssVar(el, "--quiet", "#63635d");
  const warning = cssVar(el, "--warning", "#8c5a00");
  const text = cssVar(el, "--text", "#1c1c1a");
  const fill: (string | CanvasPattern | undefined)[] = new Array<string | CanvasPattern | undefined>(CATEGORIES.length).fill(undefined);
  const edge: (string | undefined)[] = new Array<string | undefined>(CATEGORIES.length).fill(undefined);
  fill[CAT_CODE.model] = accent;
  fill[CAT_CODE.tools] = quiet;
  edge[CAT_CODE.machine] = warning;
  fill[CAT_CODE.queue] = hatch(warning, 1.5, 3, dpr);
  edge[CAT_CODE.queue] = warning;
  fill[CAT_CODE.human] = text;
  fill[CAT_CODE.pipeline] = hatch(quiet, 1, 2.5, dpr);
  edge[CAT_CODE.pipeline] = quiet;
  return {
    fill,
    edge,
    danger: cssVar(el, "--danger", "#b63531"),
    accent,
    warning,
    grid: cssVar(el, "--hairline", "#e6e6e2"),
    selection: cssVar(el, "--selected", "#00000012"),
  };
};

/**
 * Palettes by the theme the document actually has (`data-theme` on <html>), not React's theme state: the theme
 * provider sets the attribute in an effect that runs after its children's, so a read keyed on React state could
 * cache the old colours under the new key.
 */
export const paletteCache = (read: (el: Element, dpr: number) => Palette) => {
  let cached: { key: string; palette: Palette } | undefined;
  return (theme: string, dpr: number, el: Element): Palette => {
    const key = `${theme}:${dpr}`;
    if (cached?.key !== key) cached = { key, palette: read(el, dpr) };
    return cached.palette;
  };
};

/** The document's theme, and a subscription to its changes, for useSyncExternalStore. */
export const documentTheme = (): string => document.documentElement.dataset["theme"] ?? "";
export const watchDocumentTheme = (onChange: () => void): (() => void) => {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
};

export interface Frame {
  readonly model: Model;
  readonly v0: number;
  readonly v1: number;
  /** CSS px of the track area. */
  readonly width: number;
  readonly height: number;
  readonly scrollTop: number;
  readonly dpr: number;
  readonly ticks: readonly number[];
  /** Highlighted span ids, when a finding or a row lit some. */
  readonly lit: ReadonlySet<number> | undefined;
  /** A drag in progress, track x from and to. */
  readonly drag: readonly [number, number] | undefined;
  readonly palette: Palette;
}

/** Paints the visible rows and returns their bars by row, for hit testing until the next paint. */
export const paintRows = (ctx: CanvasRenderingContext2D, f: Frame): Map<number, Bar[]> => {
  const { model: m, v0, v1, width: w, height: h, dpr, palette: p } = f;
  const out = new Map<number, Bar[]>();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const xOf = (t: number) => ((t - v0) / (v1 - v0)) * w;

  ctx.fillStyle = p.grid;
  for (const t of f.ticks) ctx.fillRect(snap(xOf(t)), 0, 1 / dpr, h);
  if (f.drag !== undefined) {
    const a = Math.max(0, Math.min(f.drag[0], f.drag[1]));
    const b = Math.min(w, Math.max(f.drag[0], f.drag[1]));
    if (b > a) {
      ctx.fillStyle = p.selection;
      ctx.fillRect(a, 0, b - a, h);
    }
  }

  const first = Math.max(0, Math.floor(f.scrollTop / ROW_H));
  const last = Math.min(m.rows.length, Math.ceil((f.scrollTop + h) / ROW_H));
  const lit = f.lit;
  const isLit = lit === undefined ? () => false : (i: number) => lit.has(m.spans[m.itemSpan[i] ?? -1]?.id ?? -1);
  for (let r = first; r < last; r += 1) {
    const row = m.rows[r];
    if (row === undefined) continue;
    const y = snap(r * ROW_H - f.scrollTop + (ROW_H - BAR_H) / 2);
    // Missing data: a mark under the row, never a bar, so it takes no hover or click from the bars around it.
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.warning;
    for (const [a, b] of row.gaps) {
      if (b <= v0 || a >= v1) continue;
      const x0 = snap(xOf(Math.max(a, v0)));
      const x1 = snap(xOf(Math.min(b, v1)));
      ctx.fillRect(x0, y + BAR_H + 3, Math.max(1, x1 - x0), 3);
    }
    const list = bars(m, row.from, row.to, v0, v1, w, isLit);
    out.set(r, list);
    for (const bar of list) {
      const alpha = lit !== undefined ? (bar.lit ? 1 : UNLIT) : m.hasPath && !bar.onPath ? OFF_PATH : 1;
      const x0 = snap(bar.x0);
      const bw = Math.max(snap(bar.x1 - bar.x0), 1 / dpr);
      ctx.globalAlpha = alpha;
      const fill = p.fill[bar.cat];
      if (fill !== undefined) {
        ctx.fillStyle = fill;
        ctx.fillRect(x0, y, bw, BAR_H);
      }
      // A failure shows as a danger edge once the bar is wide enough to carry one; thinner, the hover card says it,
      // so a dense zoom-out isn't painted red by a few failed calls among thousands.
      const edge = bar.failed && bw >= 3 ? p.danger : p.edge[bar.cat];
      if (edge !== undefined) {
        if (bw >= 3) {
          ctx.strokeStyle = edge;
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, y + 0.5, bw - 1, BAR_H - 1);
        } else if (fill === undefined) {
          // An outline-only category too thin for an outline: the edge colour is the bar.
          ctx.fillStyle = edge;
          ctx.fillRect(x0, y, bw, BAR_H);
        }
      }
      if (bar.lit) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = p.accent;
        ctx.fillRect(x0, y + BAR_H + 2, bw, 2);
      }
    }
  }
  ctx.globalAlpha = 1;
  return out;
};

/** The critical path: a 2 px accent line per segment; "nothing running" stretches in the danger colour. */
export const paintPath = (ctx: CanvasRenderingContext2D, m: Model, v0: number, v1: number, w: number, h: number, dpr: number, p: Palette): void => {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const y = Math.round((h / 2 - 1) * dpr) / dpr;
  for (const s of m.path) {
    if (s.end <= v0 || s.start >= v1) continue;
    const x0 = ((Math.max(s.start, v0) - v0) / (v1 - v0)) * w;
    const x1 = ((Math.min(s.end, v1) - v0) / (v1 - v0)) * w;
    ctx.fillStyle = s.span === undefined ? p.danger : p.accent;
    ctx.fillRect(x0, y, Math.max(1, x1 - x0), 2);
  }
};
