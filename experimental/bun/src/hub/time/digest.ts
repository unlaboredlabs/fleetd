// A digest: what a Time breakdown and its insights need from a set of spans, summed. hours.ts keeps one per UTC hour
// and (machine, project, role), so a month's breakdown reads a few thousand digests instead of every span, and digests
// the spans it reads live the same way. Every part adds up to exactly what reads.ts sums from the spans themselves;
// only a thread's commands in order (`Seq`) depend on order, and they fold hour after hour.
import { categoryOf, kindCode, kindOf } from "./kinds.ts";
import { dur, isDetail, type Row } from "./model.ts";

/** Runs a command needs back to back to count as repeated (reads.ts `repeated`). */
const REPEATED = 3;

/** A command run back to back in a thread: its label, runs and ms, and its first run's task, start and id. */
export type Run = { label: number; n: number; ms: number; task?: string; start: number; id: number };

/**
 * A thread's commands and edits in order, folded: its first and last runs (null where an edit or an unlabelled
 * command stands), whether those are one run, and the runs of `REPEATED` or more between them.
 */
export type Seq = { first: Run | null; last: Run | null; one: boolean; done: Run[] };

export type Digest = {
  /** Kind code -> exclusive ms and spans. */
  kinds: Map<number, [number, number]>;
  /** Profile -> agent ms, model ms and output tokens. */
  profiles: Map<string, [number, number, number]>;
  /** A labelled command's label id -> runs and ms. A command's text has one label id: its family follows from it. */
  labels: Map<number, [number, number]>;
  /** Thread -> its commands and edits, folded. */
  seqs: Map<string, Seq>;
  /** The spans the reads use one by one: CI checks, waits on a person, and edits in a thread. */
  rows: Row[];
};

export const emptyDigest = (): Digest => ({ kinds: new Map(), profiles: new Map(), labels: new Map(), seqs: new Map(), rows: [] });

const isCommand = (r: Row) => r.kind === "tool.bash" || r.kind === "git";
/** The spans whose order `repeated` reads. */
export const inSeq = (r: Row) => (isCommand(r) || r.kind === "tool.edit") && r.threadId !== undefined;

function kept(r: Row): boolean {
  if (r.kind === "ci.check" || r.kind === "wait.request") return true;
  if (r.kind === "wait.permission") return r.extra.decidedBy === "human";
  return r.kind === "tool.edit" && r.threadId !== undefined;
}

function bump<K>(m: Map<K, number[]>, k: K, add: number[]): void {
  const v = m.get(k);
  if (v) for (let i = 0; i < add.length; i++) (v[i] as number) += add[i] as number;
  else m.set(k, [...add]);
}

/** Sums a span in, as reads.ts `totals`, `byProfile` and `topCommands` count it; its order is folded apart. */
function addRow(d: Digest, r: Row): void {
  bump(d.kinds as Map<number, number[]>, kindCode(r.kind), [r.exclMs, 1]);
  if (r.profile !== undefined) {
    const detail = isDetail(r.kind);
    const ms = detail ? 0 : r.exclMs;
    bump(d.profiles as Map<string, number[]>, r.profile, [ms, !detail && categoryOf(r.kind) === "model" ? ms : 0, Math.round(r.extra.outputTokens ?? 0)]);
  }
  if (isCommand(r) && r.label !== undefined && r.labelId !== undefined) bump(d.labels as Map<number, number[]>, r.labelId, [1, dur(r)]);
  if (kept(r)) d.rows.push(r);
}

/** One thread's commands and edits, in (start, id) order, folded. */
export function seqOf(rows: Row[]): Seq {
  const sorted = [...rows].sort((a, b) => a.startMs - b.startMs || a.id - b.id);
  // Edits and unlabelled commands break runs and never start one, as in `repeated`.
  const tokens: (Run | null)[] = [];
  for (const r of sorted) {
    const prev = tokens[tokens.length - 1];
    if (r.kind === "tool.edit" || r.label === undefined || r.labelId === undefined) tokens.push(null);
    else if (prev && prev.label === r.labelId) {
      prev.n += 1;
      prev.ms += dur(r);
    } else tokens.push({ label: r.labelId, n: 1, ms: dur(r), ...(r.taskId === undefined ? {} : { task: r.taskId }), start: r.startMs, id: r.id });
  }
  const first = tokens[0] ?? null;
  const last = tokens[tokens.length - 1] ?? null;
  const one = tokens.length === 1 && first !== null;
  return { first, last, one, done: tokens.slice(1, -1).filter((t): t is Run => t !== null && t.n >= REPEATED) };
}

const repeated = (r: Run | null): Run[] => (r && r.n >= REPEATED ? [r] : []);

/** `a` then `b`, the thread's commands in that order: a run that ends `a` and starts `b` is one run. */
export function fold(a: Seq, b: Seq): Seq {
  if (a.last && b.first && a.last.label === b.first.label) {
    const joined: Run = { ...a.last, n: a.last.n + b.first.n, ms: a.last.ms + b.first.ms };
    if (a.one && b.one) return { first: joined, last: joined, one: true, done: [] };
    if (a.one) return { first: joined, last: b.last, one: false, done: b.done };
    if (b.one) return { first: a.first, last: joined, one: false, done: a.done };
    return { first: a.first, last: b.last, one: false, done: [...a.done, ...repeated(joined), ...b.done] };
  }
  return {
    first: a.first,
    last: b.last,
    one: false,
    done: [...a.done, ...(a.one ? [] : repeated(a.last)), ...(b.one ? [] : repeated(b.first)), ...b.done],
  };
}

/** The runs of `REPEATED` or more in a folded thread. */
export const runsOf = (s: Seq): Run[] => (s.one ? repeated(s.first) : [...repeated(s.first), ...s.done, ...repeated(s.last)]);

/** The digest of `rows`. */
export function digestOf(rows: Row[]): Digest {
  const d = emptyDigest();
  const threads = new Map<string, Row[]>();
  for (const r of rows) {
    addRow(d, r);
    if (!inSeq(r)) continue;
    const list = threads.get(r.threadId as string);
    if (list) list.push(r);
    else threads.set(r.threadId as string, [r]);
  }
  for (const [t, rs] of threads) d.seqs.set(t, seqOf(rs));
  return d;
}

/** Adds `d`'s sums and rows to `into` (its kinds unless `kinds` is false); threads' order is the caller's to fold. */
export function addDigest(into: Digest, d: Digest, kinds = true): void {
  if (kinds) for (const [k, v] of d.kinds) bump(into.kinds as Map<number, number[]>, k, v);
  for (const [k, v] of d.profiles) bump(into.profiles as Map<string, number[]>, k, v);
  for (const [k, v] of d.labels) bump(into.labels as Map<number, number[]>, k, v);
  for (const r of d.rows) into.rows.push(r);
}

type WireRun = [label: number, n: number, ms: number, task: string | null, start: number, id: number];
type WireRow = [id: number, kind: number, start: number, end: number, workstream: string | null, thread: string | null, extra: Row["extra"] | null];
type Wire = {
  k: [number, number, number][];
  p: [string, number, number, number][];
  l: [number[], number[], number[]];
  s: [string, WireRun | null, WireRun | null, 0 | 1, WireRun[]][];
  r: WireRow[];
};

const runOut = (r: Run | null): WireRun | null => (r ? [r.label, r.n, r.ms, r.task ?? null, r.start, r.id] : null);
const runIn = (w: WireRun | null): Run | null =>
  w ? { label: w[0], n: w[1], ms: w[2], ...(w[3] === null ? {} : { task: w[3] }), start: w[4], id: w[5] } : null;

/** The fields of a kept span's extra the reads use. */
function extraOut(e: Row["extra"]): Row["extra"] | null {
  const out: Row["extra"] = {};
  if (e.check !== undefined) out.check = e.check;
  if (e.key !== undefined) out.key = e.key;
  if (e.tool !== undefined) out.tool = e.tool;
  if (e.decidedBy !== undefined) out.decidedBy = e.decidedBy;
  return Object.keys(out).length > 0 ? out : null;
}

export function encode(d: Digest): string {
  const labels: [number[], number[], number[]] = [[], [], []];
  for (const [id, [n, ms]] of d.labels) {
    labels[0].push(id);
    labels[1].push(n);
    labels[2].push(ms);
  }
  const wire: Wire = {
    k: [...d.kinds].map(([k, [ms, n]]) => [k, ms, n]),
    p: [...d.profiles].map(([p, [a, m, t]]) => [p, a, m, t]),
    l: labels,
    s: [...d.seqs].map(([t, s]) => [t, runOut(s.first), runOut(s.last), s.one ? 1 : 0, s.done.map((r) => runOut(r) as WireRun)]),
    r: d.rows.map((r) => [r.id, kindCode(r.kind), r.startMs, r.endMs, r.workstreamId ?? null, r.threadId ?? null, extraOut(r.extra)]),
  };
  return JSON.stringify(wire);
}

export const decode = (text: string): Digest => {
  const d = emptyDigest();
  d.seqs = addEncoded(d, text);
  return d;
};

/**
 * Adds an encoded digest's sums and rows to `into` (its kinds unless `kinds` is false), as `addDigest(into,
 * decode(text))` would without building its maps first: a month holds 100k labels. Returns its threads.
 */
export function addEncoded(into: Digest, text: string, kinds = true): Map<string, Seq> {
  const w = JSON.parse(text) as Wire;
  if (kinds) for (const [k, ms, n] of w.k) bump(into.kinds as Map<number, number[]>, k, [ms, n]);
  for (const [p, a, m, t] of w.p) bump(into.profiles as Map<string, number[]>, p, [a, m, t]);
  const [ids, ns, mss] = w.l;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as number;
    const v = into.labels.get(id);
    if (v) {
      v[0] += ns[i] as number;
      v[1] += mss[i] as number;
    } else into.labels.set(id, [ns[i] as number, mss[i] as number]);
  }
  for (const [id, kind, start, end, ws, thread, extra] of w.r) {
    const row: Row = { id, kind: kindOf(kind) ?? "runner.other", startMs: start, endMs: end, exclMs: 0, lane: "", status: "ok", extra: extra ?? {} };
    if (ws !== null) row.workstreamId = ws;
    if (thread !== null) row.threadId = thread;
    into.rows.push(row);
  }
  return new Map(w.s.map(([t, f, l, one, done]) => [t, { first: runIn(f), last: runIn(l), one: one === 1, done: done.map((r) => runIn(r) as Run) }]));
}
