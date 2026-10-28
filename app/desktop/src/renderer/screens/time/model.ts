// An order's spans arranged for drawing: one row per lane (the lead, each agent, the PR and each of its CI checks,
// the asks, the train), built once per answer from the hub and never per frame.
//
// Frame budget at any span count: items live in typed arrays sorted by row then start, with a running max of ends
// per row (`reach`), so the visible window of a row is two binary searches; spans narrower than a pixel at the
// current zoom merge into one bar per pixel column coloured by the category with the most time in it. A 15k-span
// order paints a few hundred rects per visible row at most, and only visible rows are painted.
import { CAT_LABEL, KIND_WORD, agentName, fmtDur, laneName, ordinal, tickLabel, type Names } from "./format";
import type { ProfileName } from "../../../shared/contracts";
import { profileWord } from "../../ui/primitives/profiles";
import { shortModel } from "../live/format";
import { CATEGORIES, type AgentRole, type Category, type Coverage, type CriticalPath, type GapWhy, type Span, type SpanKind } from "./types";

export type RowKind = "lead" | "agent" | "change" | "check" | "requests" | "other";

export interface Row {
  readonly key: string;
  readonly name: string;
  readonly role?: AgentRole;
  /** The agent's model ("claude-opus-5-5") and the lane id its live frames carry, when the store knows the lane. */
  readonly model?: string;
  readonly profile?: ProfileName;
  readonly laneId?: string;
  /** Output tokens its model messages report, summed: what it measured, for a lane that is no longer live. */
  readonly outputTokens: number;
  readonly kind: RowKind;
  /** Half-open range into the item arrays. */
  readonly from: number;
  readonly to: number;
  /** "Bash 41m · model 22m": the row's two biggest kinds. */
  readonly summary: string;
  readonly agentMs: number;
  /** Stretches the hub knows it has no spans for, and why. Drawn as a mark under the row; never hit. */
  readonly gaps: readonly (readonly [number, number, GapWhy])[];
}

export interface Seg {
  readonly row: number | undefined;
  readonly start: number;
  readonly end: number;
  readonly cat: Category;
  readonly kind: SpanKind;
  readonly label?: string;
  /** Index into `spans`; undefined on a "nothing running" gap. */
  readonly span: number | undefined;
}

export const CAT_CODE: Record<Category, number> = Object.fromEntries(CATEGORIES.map((c, i) => [c, i])) as Record<Category, number>;

export const FLAG_PATH = 1;
export const FLAG_FAILED = 2;

export interface Model {
  readonly spans: readonly Span[];
  readonly byId: ReadonlyMap<number, number>;
  readonly rows: readonly Row[];
  /** Per item: index into `spans`, start, end, category code, flags. Sorted by row, then start. */
  readonly itemSpan: Int32Array;
  readonly itemStart: Float64Array;
  readonly itemEnd: Float64Array;
  readonly itemCat: Uint8Array;
  readonly itemFlags: Uint8Array;
  /** Per row, the running max of `itemEnd` over its items (a row's spans can overlap, so ends alone aren't sorted). */
  readonly reach: Float64Array;
  readonly startMs: number;
  readonly endMs: number;
  readonly path: readonly Seg[];
  /** Calls that ran inside a `tools.parallel` group: each one's own time is an upper bound. */
  readonly parallel: ReadonlySet<number>;
  /** parent span id → its children (a message's phases, a group's calls), as span indexes. */
  readonly children: ReadonlyMap<number, readonly number[]>;
  /**
   * span id → the id of the span whose bar shows it: itself when drawn, its group for a call inside
   * `tools.parallel`. Spans with no bar (envelopes, idle, gaps) are absent. Lighting and listing go through it, so
   * what is lit and what is listed are the same set.
   */
  readonly barOf: ReadonlyMap<number, number>;
  readonly hasPath: boolean;
  /** The hub sent only the first 400 steps of a longer path. */
  readonly pathTruncated: boolean;
  /**
   * Stretches of the order, a tenth of it or longer, where no lane has a bar or a missing-data mark: nothing ran.
   * Marked in words, so a sparse order reads as one that waited rather than one that failed to draw.
   */
  readonly quiet: readonly (readonly [number, number])[];
}

/** A stretch with nothing running is marked once it is at least this share of the order, and a minute. */
export const QUIET_SHARE = 0.1;
export const QUIET_MIN_MS = 60_000;

const rowKey = (s: Span): string => {
  if (s.kind === "ci.check" && s.extra?.check !== undefined) return `${s.lane}#ci#${s.extra.check}`;
  return s.lane;
};

const rowKindOf = (s: Span, names: Names): RowKind => {
  if (s.kind === "ci.check") return "check";
  if (s.lane.startsWith("change:")) return "change";
  if (s.lane.startsWith("requests:")) return "requests";
  if (s.threadId !== undefined && names.leads.has(s.threadId)) return "lead";
  if (s.lane.startsWith("thread:")) return "agent";
  return "other";
};

const RANK: Record<RowKind, number> = { lead: 0, agent: 1, change: 2, check: 2, requests: 3, other: 4 };

export const buildModel = (
  spans: readonly Span[],
  path: CriticalPath | undefined,
  coverage: Coverage | undefined,
  names: Names,
  nowMs: number,
): Model => {
  const byId = new Map<number, number>();
  spans.forEach((s, i) => byId.set(s.id, i));
  const children = new Map<number, number[]>();
  spans.forEach((s, i) => {
    if (s.parent === undefined) return;
    const list = children.get(s.parent);
    if (list === undefined) children.set(s.parent, [i]);
    else list.push(i);
  });
  const parallel = new Set<number>();
  for (const s of spans) {
    const p = s.parent === undefined ? undefined : byId.get(s.parent);
    if (p !== undefined && spans[p]?.kind === "tools.parallel") parallel.add(s.id);
  }
  const pathIds = new Set<number>();
  for (const seg of path?.segments ?? []) if (seg.spanId !== undefined) pathIds.add(seg.spanId);

  // Leaves only: an envelope's time is its children's, and a group is drawn instead of its overlapping calls.
  const drawn = (s: Span): boolean => {
    if (s.kind === "run" || s.kind === "idle" || s.kind === "gap") return false;
    if (s.kind === "model.message") return !children.has(s.id);
    return !parallel.has(s.id);
  };

  // Lost data, per lane: the node's own gap spans and the hub's coverage gaps. A lane with no node spans at all
  // still gets a row, so the order doesn't look like it had fewer agents.
  const gaps = new Map<string, [number, number, GapWhy][]>();
  const addGap = (lane: string, g: [number, number, GapWhy]) => {
    const list = gaps.get(lane);
    if (list === undefined) gaps.set(lane, [g]);
    else list.push(g);
  };
  for (const s of spans) if (s.kind === "gap") addGap(s.lane, [s.startMs, s.endMs ?? nowMs, "node_dropped"]);
  for (const g of coverage?.gaps ?? []) if (g.lane !== undefined) addGap(g.lane, [g.fromMs, g.toMs, g.why]);

  const barOf = new Map<number, number>();
  for (const s of spans) {
    if (drawn(s)) barOf.set(s.id, s.id);
    else if (s.parent !== undefined && parallel.has(s.id)) barOf.set(s.id, s.parent);
  }

  const tokens = new Map<string, number>();
  for (const s of spans) {
    const out = s.kind === "model.message" ? s.extra?.outputTokens : undefined;
    if (out !== undefined) tokens.set(rowKey(s), (tokens.get(rowKey(s)) ?? 0) + out);
  }

  const groups = new Map<string, { first: number; kind: RowKind; items: number[] }>();
  spans.forEach((s, i) => {
    if (!drawn(s)) return;
    const key = rowKey(s);
    let g = groups.get(key);
    if (g === undefined) {
      g = { first: s.startMs, kind: rowKindOf(s, names), items: [] };
      groups.set(key, g);
    }
    g.first = Math.min(g.first, s.startMs);
    g.items.push(i);
  });

  // Lead, agents by start, then each PR with its checks under it, then the asks and the rest.
  const keys = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    const sub = (k: string, g: { kind: RowKind }) => (g.kind === "change" || g.kind === "check" ? (k.split("#ci#")[0] ?? k) : g.kind === "requests" ? k : "");
    return (
      RANK[a.kind] - RANK[b.kind] ||
      sub(ka, a).localeCompare(sub(kb, b)) ||
      Number(a.kind === "check") - Number(b.kind === "check") ||
      a.first - b.first ||
      ka.localeCompare(kb)
    );
  });

  const total = keys.reduce((n, [, g]) => n + g.items.length, 0);
  const itemSpan = new Int32Array(total);
  const itemStart = new Float64Array(total);
  const itemEnd = new Float64Array(total);
  const itemCat = new Uint8Array(total);
  const itemFlags = new Uint8Array(total);
  const reach = new Float64Array(total);
  const rows: Row[] = [];
  let at = 0;
  for (const [key, g] of keys) {
    const end = (i: number) => {
      const s = spans[i];
      return s === undefined ? 0 : Math.max(s.endMs ?? nowMs, s.startMs);
    };
    g.items.sort((a, b) => (spans[a]?.startMs ?? 0) - (spans[b]?.startMs ?? 0) || end(a) - end(b));
    const from = at;
    const totals = new Map<string, number>();
    let agentMs = 0;
    let max = -Infinity;
    for (const i of g.items) {
      const s = spans[i];
      if (s === undefined) continue;
      const e = end(i);
      itemSpan[at] = i;
      itemStart[at] = s.startMs;
      itemEnd[at] = e;
      itemCat[at] = CAT_CODE[s.cat];
      itemFlags[at] = (pathIds.has(s.id) ? FLAG_PATH : 0) | (s.status === "failed" ? FLAG_FAILED : 0);
      max = Math.max(max, e);
      reach[at] = max;
      at += 1;
      const ms = s.exclMs ?? e - s.startMs;
      agentMs += ms;
      const word = s.cat === "model" ? "model" : KIND_WORD[s.kind];
      totals.set(word, (totals.get(word) ?? 0) + ms);
    }
    const summary = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([w, ms]) => `${w} ${fmtDur(ms)}`)
      .join(" · ");
    const first = spans[g.items[0] ?? 0];
    if (first === undefined) continue;
    const lane = first.threadId === undefined ? undefined : names.threads.get(first.threadId);
    let name: string;
    let role: AgentRole | undefined;
    if (g.kind === "lead") {
      name = "lead";
      role = "lead";
    } else if (g.kind === "agent") {
      name = lane === undefined ? "an agent" : agentName(lane);
      role = lane?.role;
    } else if (g.kind === "check") {
      name = key.split("#ci#")[1] ?? "check";
    } else {
      name = laneName(names, first);
    }
    const rowGaps = g.kind === "check" ? [] : (gaps.get(key) ?? []);
    if (g.kind !== "check") gaps.delete(key);
    rows.push({
      key,
      name,
      kind: g.kind,
      from,
      to: at,
      summary,
      agentMs,
      gaps: rowGaps,
      outputTokens: tokens.get(key) ?? 0,
      ...(role === undefined ? {} : { role }),
      ...(lane?.model === undefined ? {} : { model: lane.model }),
      ...(lane?.profile === undefined ? {} : { profile: lane.profile }),
      ...(lane?.laneId === undefined ? {} : { laneId: lane.laneId }),
    });
  }
  // Lanes the hub knows of but has no spans for.
  for (const [lane, g] of [...gaps.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const thread = lane.startsWith("thread:") ? lane.split("/")[1] : undefined;
    const known = thread === undefined ? undefined : names.threads.get(thread);
    const name = known !== undefined ? agentName(known) : "an agent with no timeline";
    rows.push({
      key: lane,
      name,
      kind: "other",
      from: at,
      to: at,
      summary: "",
      agentMs: 0,
      gaps: g,
      outputTokens: 0,
      ...(known === undefined ? {} : { role: known.role, ...(known.model === undefined ? {} : { model: known.model }), ...(known.profile === undefined ? {} : { profile: known.profile }) }),
    });
  }

  // Names the store couldn't tell apart (agents it doesn't know, or the same work twice) get their order of start:
  // agent rows are already in start order, and lanes with no spans come after them.
  const byName = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (r.kind === "agent" || r.kind === "other") byName.set(r.name, [...(byName.get(r.name) ?? []), i]);
  });
  for (const [name, ix] of byName) {
    if (ix.length < 2) continue;
    ix.forEach((i, n) => {
      const r = rows[i];
      if (r !== undefined) rows[i] = { ...r, name: `${name} · ${ordinal(n + 1)}` };
    });
  }

  const rowIndex = new Map(rows.map((r, i) => [r.key, i] as const));
  const segs: Seg[] = (path?.segments ?? []).map((seg) => {
    const span = seg.spanId === undefined ? undefined : byId.get(seg.spanId);
    const s = span === undefined ? undefined : spans[span];
    return {
      row: s === undefined ? undefined : rowIndex.get(rowKey(s)),
      start: seg.startMs,
      end: seg.endMs,
      cat: seg.cat,
      kind: seg.kind,
      span,
      ...(seg.label === undefined ? {} : { label: seg.label }),
    };
  });
  let startMs: number;
  let endMs: number;
  if (path !== undefined) {
    startMs = path.startMs;
    endMs = path.endMs;
  } else {
    startMs = total === 0 ? nowMs : Math.min(...rows.filter((r) => r.to > r.from).map((r) => itemStart[r.from] ?? nowMs));
    endMs = total === 0 ? nowMs : Math.max(...rows.filter((r) => r.to > r.from).map((r) => reach[r.to - 1] ?? nowMs));
  }
  endMs = Math.max(endMs, startMs + 1);
  // Everything drawn (bars and missing-data marks) by start, swept for the holes between.
  const covered: [number, number][] = [];
  for (let i = 0; i < total; i += 1) covered.push([itemStart[i] ?? 0, itemEnd[i] ?? 0]);
  for (const r of rows) for (const [a, b] of r.gaps) covered.push([a, b]);
  covered.sort((a, b) => a[0] - b[0]);
  const quiet: [number, number][] = [];
  let reached = startMs;
  for (const [a, b] of total === 0 ? [] : [...covered, [endMs, endMs] as const]) {
    const to = Math.min(a, endMs);
    if (to - reached >= Math.max(QUIET_MIN_MS, (endMs - startMs) * QUIET_SHARE)) quiet.push([reached, to]);
    reached = Math.max(reached, b);
  }
  return {
    spans,
    byId,
    rows,
    itemSpan,
    itemStart,
    itemEnd,
    itemCat,
    itemFlags,
    reach,
    startMs,
    endMs,
    path: segs,
    parallel,
    children,
    barOf,
    hasPath: path !== undefined,
    pathTruncated: path?.segmentsTruncated === true,
    quiet,
  };
};

/** One drawn bar: an item, or (`n > 1`) the items that share one pixel column at this zoom. */
export interface Bar {
  x0: number;
  x1: number;
  cat: number;
  /** Absolute index of the first item in the bar. */
  first: number;
  n: number;
  start: number;
  end: number;
  onPath: boolean;
  failed: boolean;
  lit: boolean;
}

/** The first index in [lo, hi) whose value fails `before`, for arrays sorted so `before` holds on a prefix. */
const partition = (arr: Float64Array, lo: number, hi: number, before: (v: number) => boolean): number => {
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (before(arr[mid] ?? 0)) a = mid + 1;
    else b = mid;
  }
  return a;
};

/**
 * The bars of row items [from, to) for the view [v0, v1) across `width` px. Items at least a pixel wide stay one bar
 * each; narrower ones merge per pixel column into a bar coloured by the category with the most time in it.
 */
export const bars = (m: Model, from: number, to: number, v0: number, v1: number, width: number, lit: (item: number) => boolean): Bar[] => {
  const out: Bar[] = [];
  if (v1 <= v0 || width <= 0 || to <= from) return out;
  const k = width / (v1 - v0);
  // Everything before `lo` ended before the view; overlapping spans can't hide behind it, as `reach` only grows.
  const lo = partition(m.reach, from, to, (r) => r <= v0);
  const hi = partition(m.itemStart, from, to, (s) => s < v1);
  let bucket: Bar | undefined;
  let col = -1;
  const ms = new Float64Array(CATEGORIES.length);
  const flush = () => {
    if (bucket === undefined) return;
    if (bucket.n > 1) {
      let best = 0;
      for (let c = 1; c < ms.length; c += 1) if ((ms[c] ?? 0) > (ms[best] ?? 0)) best = c;
      bucket.cat = best;
    }
    out.push(bucket);
    bucket = undefined;
  };
  for (let i = lo; i < Math.max(hi, lo); i += 1) {
    const start = m.itemStart[i] ?? 0;
    const end = m.itemEnd[i] ?? 0;
    if (end <= v0) continue;
    const x0 = (Math.max(start, v0) - v0) * k;
    const x1 = (Math.min(end, v1) - v0) * k;
    const flags = m.itemFlags[i] ?? 0;
    const cat = m.itemCat[i] ?? 0;
    const one: Bar = {
      x0,
      x1,
      cat,
      first: i,
      n: 1,
      start,
      end,
      onPath: (flags & FLAG_PATH) !== 0,
      failed: (flags & FLAG_FAILED) !== 0,
      lit: lit(i),
    };
    if (x1 - x0 >= 1) {
      flush();
      out.push(one);
      continue;
    }
    const c = Math.floor(x0);
    if (bucket !== undefined && c === col) {
      ms[cat] = (ms[cat] ?? 0) + (end - start);
      bucket.n += 1;
      bucket.end = Math.max(bucket.end, end);
      bucket.onPath ||= one.onPath;
      bucket.failed ||= one.failed;
      bucket.lit ||= one.lit;
      continue;
    }
    flush();
    ms.fill(0);
    ms[cat] = end - start;
    col = c;
    bucket = { ...one, x0: c, x1: c + 1 };
  }
  flush();
  return out;
};

/**
 * The bar under the pointer, with 2 px of slack for hairline bars. Where bars overlap (a wait inside its tool), the
 * shortest one under the pointer wins: it is the innermost, and it is drawn on top.
 */
export const hit = (list: readonly Bar[], x: number): Bar | undefined => {
  let best: Bar | undefined;
  let bestD = Infinity;
  for (const b of list) {
    if (x < b.x0 - 2 || x > b.x1 + 2) continue;
    const d = x >= b.x0 && x <= b.x1 ? 0 : Math.min(Math.abs(b.x0 - x), Math.abs(b.x1 - x));
    if (best === undefined || d < bestD || (d === bestD && b.end - b.start < best.end - best.start)) {
      best = b;
      bestD = d;
    }
  }
  return best;
};

const DAY = 86_400_000;
const STEPS = [
  1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000,
  21_600_000, 43_200_000, DAY, 2 * DAY, 7 * DAY, 14 * DAY,
];

/** Round ticks, at most `most` of them across [v0, v1). */
export const ticks = (v0: number, v1: number, most = 8): number[] => {
  const span = Math.max(1, v1 - v0);
  const step = STEPS.find((s) => span / s <= most) ?? Math.ceil(span / most / DAY) * DAY;
  // Round marks on the viewer's clock, not on UTC's: a half-hour zone or a 6h step would otherwise read 10:30 or
  // 05:00. Stepping is in local time; each tick goes back to hub ms at its own offset, so a DST change stays round.
  const offset = (t: number) => -new Date(t).getTimezoneOffset() * 60_000;
  const off0 = offset(v0);
  const out: number[] = [];
  for (let local = Math.ceil((v0 + off0) / step) * step; ; local += step) {
    const t = local - offset(local - off0);
    if (t >= v1) break;
    if (t >= v0 && t > (out.at(-1) ?? -Infinity)) out.push(t);
  }
  return out;
};

/** Track px per axis tick: room for the longest label ("10:15:30", "Oct 18") with space either side. */
export const TICK_PX = 96;
/** An axis label's width in px: the mono xs digits, and the tick's own padding. */
const labelPx = (label: string): number => label.length * 7 + 4;

export interface Tick {
  readonly t: number;
  /** Track px. */
  readonly x: number;
  /** Undefined where the label would run past the track's end: the grid line stays, the label isn't cut. */
  readonly label: string | undefined;
}

/** The axis for the view [v0, v1) across `width` px: as many ticks as fit, each label whole or not at all. */
export const axisTicks = (v0: number, v1: number, width: number): Tick[] =>
  ticks(v0, v1, Math.max(2, Math.floor(width / TICK_PX))).map((t) => {
    const x = ((t - v0) / (v1 - v0)) * width;
    const label = tickLabel(t, v0, v1);
    return { t, x, label: x + labelPx(label) <= width ? label : undefined };
  });

/** The narrowest whole-order view: a lone 400 ms call would otherwise fill the track, with no tick to read it by. */
export const MIN_WHOLE_MS = 10_000;
/** Track px kept clear at either end, so the first bar doesn't touch the lane labels nor the last the window edge. */
export const EDGE_PX = 12;

/** The whole order as the timeline shows it across `width` px: at least MIN_WHOLE_MS, centred, inset by EDGE_PX. */
export const wholeView = (m: Pick<Model, "startMs" | "endMs">, width: number): [number, number] => {
  const span = Math.max(m.endMs - m.startMs, MIN_WHOLE_MS);
  const a = (m.startMs + m.endMs - span) / 2;
  const pad = width > 4 * EDGE_PX ? (span * EDGE_PX) / (width - 2 * EDGE_PX) : 0;
  return [a - pad, a + span + pad];
};

/** Per category, the time of the items in a merged bar, for its hover card. */
export const bucketShares = (m: Model, bar: Bar): { total: number; share: number } => {
  const ms = new Float64Array(CATEGORIES.length);
  for (let i = bar.first; i < bar.first + bar.n; i += 1) {
    const c = m.itemCat[i] ?? 0;
    ms[c] = (ms[c] ?? 0) + ((m.itemEnd[i] ?? 0) - (m.itemStart[i] ?? 0));
  }
  const total = ms.reduce((a, b) => a + b, 0);
  return { total, share: Math.floor(((ms[bar.cat] ?? 0) * 100) / Math.max(1, total)) };
};

/** The whole row's range, for "zoom to this lane". */
export const rowRange = (m: Model, row: Row): [number, number] | undefined => {
  if (row.to <= row.from) return undefined;
  const a = m.itemStart[row.from] ?? 0;
  const b = m.reach[row.to - 1] ?? a;
  return [a, Math.max(b, a + 1_000)];
};

/** Bars of a merged bucket or a single item, padded for a zoom on click. */
export const padded = (a: number, b: number): [number, number] => {
  const d = Math.max(Math.floor((b - a) / 4), 2_000);
  return [a - d, b + d];
};

/** The category's display label, re-exported for the canvas legend. */
export const catLabel = (code: number): string => CAT_LABEL[CATEGORIES[code] ?? "idle"];

/** The bars that show these spans: what a highlight lights, and so what its list lists. */
export const barsFor = (m: Model, ids: Iterable<number>): Set<number> => {
  const out = new Set<number>();
  for (const id of ids) {
    const bar = m.barOf.get(id);
    if (bar !== undefined) out.add(bar);
  }
  return out;
};

/** What an agent ran on, in a word: its task profile ("medium"), else its model ("opus") from an older hub. */
export const ranOn = (r: { readonly model?: string | undefined; readonly profile?: ProfileName | undefined }): string | undefined =>
  r.profile !== undefined ? profileWord(r.profile) : r.model === undefined ? undefined : shortModel(r.model);
