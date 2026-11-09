// The critical path of an order: a backward last-finisher walk over the order's
// lanes, cut into exclusive tiles. Deterministic: no clock, no randomness; the same input gives the same path.
import type { Category, CategoryMs, CriticalPath, PathSegment, SpanKind } from "../../shared/contracts.ts";
import { type Claim, tile } from "../../shared/tiles.ts";
import { CATEGORIES, categoryOf, kindCode, pathRank } from "./kinds.ts";
import { isDetail, type PathInput, rank, type Row } from "./model.ts";

/** The most segments a path returns; the totals still cover every one. */
export const MAX_SEGMENTS = 400;

type Piece = { start: number; end: number; spanId: number; kind: SpanKind; cat: Category; label?: string };

/** Rows the walk may step on: leaves, plus `run` envelopes whose uncovered time is `runner.other`. */
const stepsOn = (row: Row) => row.kind === "run" || !(isDetail(row.kind) || row.kind === "idle");

/** Cuts one lane's rows into exclusive pieces, oldest first. */
function lanePieces(rows: Row[]): Piece[] {
  if (rows.length === 0) return [];
  const base = Math.min(...rows.map((r) => r.startMs));
  const to = Math.max(...rows.map((r) => r.endMs));
  const off = (ms: number) => Math.max(ms - base, 0);
  const claims: Claim[] = rows.map((r) => ({ start: off(r.startMs), end: off(r.endMs), rank: r.kind === "run" ? 0 : Math.max(rank(r.kind), 1) }));
  return tile(claims, 0, off(to)).flatMap((t) => {
    if (t.owner === undefined) return [];
    const row = rows[t.owner] as Row;
    const kind: SpanKind = row.kind === "run" ? "runner.other" : row.kind;
    return [{ start: base + t.start, end: base + t.end, spanId: row.id, kind, cat: categoryOf(kind), ...(row.label === undefined ? {} : { label: row.label }) }];
  });
}

/** `s` cut to at most `max` UTF-16 units. */
function clip(s: string, max: number): string {
  let n = 0;
  let out = "";
  for (const ch of s) {
    n += ch.length;
    if (n > max) break;
    out += ch;
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The first index whose piece starts at or after `t` (pieces ascend). */
function partition(pieces: Piece[], t: number): number {
  let [lo, hi] = [0, pieces.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((pieces[mid] as Piece).start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The order's critical path from `input.endMs` back to `input.startMs`. Its segments add up to the order's wall time
 * exactly; time with nothing running becomes a `gap` segment (`nothingRunningMs`).
 */
export function criticalPath(input: PathInput): CriticalPath {
  const start = input.startMs;
  const end = Math.max(input.endMs, input.startMs);
  const byLane = new Map<string, Row[]>();
  for (const row of input.rows) {
    if (!stepsOn(row) || row.endMs <= row.startMs) continue;
    const list = byLane.get(row.lane) ?? [];
    list.push(row);
    byLane.set(row.lane, list);
  }
  const lanes: [string, Piece[]][] = [...byLane.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([lane, rows]): [string, Piece[]] => [lane, lanePieces(rows)])
    .filter(([, p]) => p.length > 0);
  const walked: [lane: number | undefined, piece: Piece | undefined, start: number, end: number][] = [];
  let t = end;
  let current: number | undefined;
  while (t > start) {
    let best: [reach: number, lane: number, piece: number] | undefined;
    for (let li = 0; li < lanes.length; li++) {
      const [lane, pieces] = lanes[li] as [string, Piece[]];
      const k = partition(pieces, t);
      if (k === 0) continue;
      const piece = pieces[k - 1] as Piece;
      const reach = Math.min(piece.end, t);
      let better = best === undefined;
      if (best !== undefined) {
        const [br, bl, bk] = best;
        const other = (lanes[bl] as [string, Piece[]])[1][bk] as Piece;
        if (reach !== br) better = reach > br;
        else {
          const causal = (l: string) => current !== undefined && (input.waitsOn.get((lanes[current] as [string, Piece[]])[0]) ?? []).includes(l);
          const key = (p: Piece, l: string): [number, number, number] => [causal(l) ? 0 : 1, pathRank(p.cat), p.spanId];
          const [a, b] = [key(piece, lane), key(other, (lanes[bl] as [string, Piece[]])[0])];
          better = a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
        }
      }
      if (better) best = [reach, li, k - 1];
    }
    if (best === undefined || best[0] <= start) {
      walked.push([undefined, undefined, start, t]);
      break;
    }
    const [reach, li, k] = best;
    if (reach < t) walked.push([undefined, undefined, reach, t]);
    const piece = (lanes[li] as [string, Piece[]])[1][k] as Piece;
    walked.push([li, piece, Math.max(piece.start, start), reach]);
    current = li;
    t = piece.start;
  }
  walked.reverse();
  const totals = new Map<Category, { ms: number; kinds: Map<SpanKind, [number, number]> }>();
  let nothingRunning = 0;
  const segments: PathSegment[] = [];
  for (const [li, piece, s, e] of walked) {
    const ms = e - s;
    let segment: PathSegment;
    if (li !== undefined && piece) {
      segment = {
        spanId: piece.spanId,
        lane: (lanes[li] as [string, Piece[]])[0],
        kind: piece.kind,
        cat: piece.cat,
        startMs: s,
        endMs: e,
        ...(piece.label === undefined ? {} : { label: clip(piece.label, 500) }),
      };
    } else {
      nothingRunning += ms;
      segment = { lane: "none", kind: "gap", cat: "idle", startMs: s, endMs: e };
    }
    const tot = totals.get(segment.cat) ?? { ms: 0, kinds: new Map() };
    totals.set(segment.cat, tot);
    tot.ms += ms;
    const k = tot.kinds.get(segment.kind) ?? [0, 0];
    tot.kinds.set(segment.kind, k);
    k[0] += ms;
    // Adjacent pieces of the same lane, kind and label are one step of the path (tiles of one span).
    const last = segments[segments.length - 1];
    if (last && last.lane === segment.lane && last.kind === segment.kind && last.label === segment.label && last.endMs === segment.startMs) {
      last.endMs = segment.endMs;
    } else {
      k[1] += 1;
      segments.push(segment);
    }
  }
  const onPath = end - start - nothingRunning;
  const agent = input.rows.filter((r) => !isDetail(r.kind)).reduce((n, r) => n + r.exclMs, 0);
  const catTotals: CategoryMs[] = CATEGORIES.flatMap((c) => {
    const tot = totals.get(c);
    if (!tot || tot.ms <= 0) return [];
    const kinds = [...tot.kinds.entries()]
      .sort(([a], [b]) => kindCode(a) - kindCode(b))
      .map(([kind, [kms, n]]) => ({ kind, ms: kms, n }));
    return [{ cat: c, ms: tot.ms, kinds }];
  });
  return {
    startMs: start,
    endMs: end,
    // Every segment: what is stored and what the rules read. `forOutput` cuts it for the wire.
    segments,
    segmentsTruncated: false,
    totals: catTotals,
    nothingRunningMs: nothingRunning,
    offPathMs: Math.max(agent - onPath, 0),
  };
}

/** The path as a tool returns it: at most MAX_SEGMENTS segments, the longest ones in time order. */
export function forOutput(path: CriticalPath): CriticalPath {
  if (path.segments.length <= MAX_SEGMENTS) return { ...path };
  const keep = [...path.segments]
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs)
    .slice(0, MAX_SEGMENTS)
    .sort((a, b) => a.startMs - b.startMs);
  return { ...path, segments: keep, segmentsTruncated: true };
}

/** A stored path: the same JSON as a CriticalPath. */
export function decodeStored(json: string): CriticalPath | undefined {
  try {
    const s = JSON.parse(json) as CriticalPath;
    if (!Array.isArray(s.segments) || !Array.isArray(s.totals)) return undefined;
    return { ...s, segmentsTruncated: false };
  } catch {
    return undefined;
  }
}
