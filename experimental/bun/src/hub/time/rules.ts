// The insight rules (crates/fleetd/src/hub/time/rules.rs): deterministic aggregates over a period's spans, never a
// model. Thresholds are the constants below, and every finding carries the numbers it was built from.
import type { FiredIn, Insight, InsightNumber, InsightRule } from "../../shared/contracts.ts";
import { dur, type Row, type RuleInput } from "./model.ts";

const MIN = 60_000;
const SEC = 1_000;
export const FULL_SUITE_MIN_RUNS = 5;
export const FULL_SUITE_MIN_TOTAL = 10 * MIN;
export const REPEAT_MIN_RUNS = 3;
export const SLOW_MIN_TOTAL = 2 * MIN;
export const SLOW_TOP = 10;
/** The most findings returned, and the most span ids one finding carries. */
export const MAX_INSIGHTS = 30;
export const MAX_SPAN_IDS = 200;

/** The program families the `full_suite_repeat` rule treats as test runners. */
const TEST_FAMILIES = ["cargo test", "cargo nextest", "npm test", "pnpm test", "yarn test", "vp test", "pytest", "go test", "jest", "vitest"];

/** One rule's result for one key, fired or not: the numbers are kept either way so a comparison can show them. */
type Candidate = {
  rule: InsightRule;
  key: string;
  fired: boolean;
  message: string;
  numbers: [string, number][];
  /** (start, id), sorted. */
  spans: [number, number][];
  /** The total time the finding names; findings rank by it. */
  weight: number;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pad = (n: number) => String(n).padStart(2, "0");

/** "34s", "2m10s", "51m", "1h12m". */
export function fmtDur(ms: number): string {
  const s = Math.floor(Math.max(ms, 0) / SEC);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  if (h > 0) return m === 0 ? `${h}h` : `${h}h${pad(m)}m`;
  if (m >= 10 || (m > 0 && sec === 0)) return `${m}m`;
  if (m > 0) return `${m}m${pad(sec)}s`;
  return `${sec}s`;
}

/** Nearest-rank percentile; 0 for no values. */
function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const idx = Math.max(Math.ceil((v.length * p) / 100), 1) - 1;
  return v[Math.min(idx, v.length - 1)] as number;
}

function short(label: string): string {
  let out = "";
  for (const ch of label) {
    if (out.length + ch.length > 150) return `${out}…`;
    out += ch;
  }
  return out;
}

const label = (row: Row) => row.label ?? "";

function spansOf(rows: Row[]): [number, number][] {
  const out = rows.map((r): [number, number] => [r.startMs, r.id]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.filter((x, i) => i === 0 || x[0] !== (out[i - 1] as [number, number])[0] || x[1] !== (out[i - 1] as [number, number])[1]);
}

const total = (rows: Row[]) => rows.reduce((n, r) => n + dur(r), 0);

function taskName(input: RuleInput, row: Row): string {
  if (row.taskId !== undefined) {
    const title = input.taskTitles.get(row.taskId);
    return title === undefined ? row.taskId : `${row.taskId} ${title}`;
  }
  return row.threadId !== undefined ? `thread ${row.threadId}` : "a session";
}

const isCommand = (row: Row) => (row.kind === "tool.bash" || row.kind === "git") && row.label !== undefined;

function familyOf(row: Row): string | undefined {
  const fam = row.family ?? "";
  const lab = label(row);
  return TEST_FAMILIES.find((f) => fam === f || lab === f || lab.startsWith(`${f} `));
}

/** The label runs the whole suite: after the family (and a `run` subcommand) nothing but flags until a shell operator. */
function isFullSuite(row: Row, family: string): boolean {
  const lab = label(row);
  const pos = lab.indexOf(family);
  if (pos < 0) return true;
  const rest = lab
    .slice(pos + family.length)
    .split(/\s+/)
    .filter(Boolean);
  if (rest[0] === "run") rest.shift();
  let afterDashes = false;
  for (const tok of rest) {
    if (["|", "||", "&&", ";"].includes(tok) || tok.includes(">") || tok.includes("<")) break;
    if (tok === "--") {
      afterDashes = true;
      continue;
    }
    if (afterDashes || !tok.startsWith("-")) return false;
  }
  return true;
}

/** Rows by thread (sorted by thread), oldest first within each. */
function byThread(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.threadId === undefined) continue;
    const list = out.get(r.threadId) ?? [];
    list.push(r);
    out.set(r.threadId, list);
  }
  for (const v of out.values()) v.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
  return new Map([...out.entries()].sort(([a], [b]) => cmp(a, b)));
}

function groupBy(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  return new Map([...out.entries()].sort(([a], [b]) => cmp(a, b)));
}

const editedBetween = (edits: Row[], from: number, to: number) => edits.some((e) => e.startMs >= from && e.startMs < to);

function fullSuiteRepeat(input: RuleInput, out: Candidate[]): void {
  const edits = byThread(input.rows.filter((r) => r.kind === "tool.edit"));
  const runs0 = input.rows.filter((r) => {
    if (r.kind !== "tool.bash") return false;
    const f = familyOf(r);
    return f !== undefined && isFullSuite(r, f);
  });
  for (const [lab, runs] of groupBy(runs0, label)) {
    let k = 0;
    for (const [thread, threadRuns] of byThread(runs)) {
      const e = edits.get(thread) ?? [];
      for (let i = 1; i < threadRuns.length; i++) {
        if (!editedBetween(e, (threadRuns[i - 1] as Row).startMs, (threadRuns[i] as Row).startMs)) k += 1;
      }
    }
    const [n, sum] = [runs.length, total(runs)];
    out.push({
      rule: "full_suite_repeat",
      key: lab,
      fired: n >= FULL_SUITE_MIN_RUNS && sum >= FULL_SUITE_MIN_TOTAL,
      message: `agents ran the full test suite \`${short(lab)}\` ${n}× (${fmtDur(sum)}); ${k} runs followed no edit since the previous run`,
      numbers: [
        ["runs", n],
        ["total_ms", sum],
        ["no_edit", k],
      ],
      spans: spansOf(runs),
      weight: sum,
    });
  }
}

/** The longest streak per (thread, label) of runs of that label with nothing edited between them. */
function streaks(input: RuleInput): Row[][] {
  const edits = byThread(input.rows.filter((r) => r.kind === "tool.edit"));
  const found: Row[][] = [];
  for (const [thread, rows] of byThread(input.rows.filter(isCommand))) {
    const e = edits.get(thread) ?? [];
    for (const runs of groupBy(rows, label).values()) {
      let best: Row[] = [];
      let cur: Row[] = [];
      for (const r of runs) {
        const prev = cur[cur.length - 1];
        if (prev && editedBetween(e, prev.startMs, r.startMs)) cur = [];
        cur.push(r);
        if (cur.length > best.length) best = [...cur];
      }
      if (best.length > 0) found.push(best);
    }
  }
  return found;
}

function repeatNoChange(input: RuleInput, out: Candidate[]): void {
  for (const runs of streaks(input)) {
    const first = runs[0] as Row;
    const sum = total(runs);
    out.push({
      rule: "repeat_no_change",
      key: `${first.threadId ?? ""}|${label(first)}`,
      fired: runs.length >= REPEAT_MIN_RUNS,
      message: `\`${short(label(first))}\` ran ${runs.length}× in a row in ${taskName(input, first)} with nothing changed between runs (${fmtDur(sum)})`,
      numbers: [
        ["runs", runs.length],
        ["total_ms", sum],
      ],
      spans: spansOf(runs),
      weight: sum,
    });
  }
}

function slowCommands(input: RuleInput, out: Candidate[]): void {
  const all = [...groupBy(input.rows.filter(isCommand), label).entries()]
    .map(([l, rows]): [number, string, Row[]] => [total(rows), l, rows])
    .sort((a, b) => b[0] - a[0] || cmp(a[1], b[1]));
  all.forEach(([sum, lab, rows], i) => {
    const p50 = pct(rows.map(dur), 50);
    out.push({
      rule: "slow_commands",
      key: lab,
      fired: i < SLOW_TOP && sum >= SLOW_MIN_TOTAL,
      message: `\`${short(lab)}\`: ${rows.length}×, ${fmtDur(sum)}, median ${fmtDur(p50)}`,
      numbers: [
        ["runs", rows.length],
        ["total_ms", sum],
        ["p50_ms", p50],
      ],
      spans: spansOf(rows),
      weight: sum,
    });
  });
}

function candidates(input: RuleInput): Candidate[] {
  const out: Candidate[] = [];
  fullSuiteRepeat(input, out);
  repeatNoChange(input, out);
  slowCommands(input, out);
  return out;
}

const numbers = (n: [string, number][]): InsightNumber[] => n.slice(0, 12).map(([name, value]) => ({ name, value }));
const zeros = (n: [string, number][]): [string, number][] => n.map(([k]) => [k, 0]);

function message(m: string): string {
  let s = m;
  while (s.length > 600) s = s.slice(0, -1);
  return s || "-";
}

const toInsight = (c: Candidate): Insight => ({
  rule: c.rule,
  message: message(c.message),
  numbers: numbers(c.numbers),
  spanIds: c.spans.slice(0, MAX_SPAN_IDS).map(([, id]) => id),
});

/** Strongest first: the time a finding names, then rule name and key. */
const byStrength = (a: Candidate, b: Candidate, wa: number, wb: number) => wb - wa || cmp(a.rule, b.rule) || cmp(a.key, b.key);

/** Every rule that fires on `input`, strongest first, at most MAX_INSIGHTS. */
export function insights(input: RuleInput): Insight[] {
  return candidates(input)
    .filter((c) => c.fired)
    .sort((a, b) => byStrength(a, b, a.weight, b.weight))
    .slice(0, MAX_INSIGHTS)
    .map(toInsight);
}

/** `insights` for the current period, with each finding's numbers for the compare period beside it. */
export function compare(current: RuleInput, previous: RuleInput): Insight[] {
  const key = (c: Candidate) => `${c.rule}\u0000${c.key}`;
  const cur = new Map(candidates(current).map((c) => [key(c), c]));
  const prev = new Map(candidates(previous).map((c) => [key(c), c]));
  const keys = [...new Set([...[...cur.entries(), ...prev.entries()].filter(([, c]) => c.fired).map(([k]) => k)])].sort(cmp);
  const found = keys.map((k): [number, Candidate, Candidate | undefined, FiredIn] => {
    const c = cur.get(k);
    const p = prev.get(k);
    const fired: FiredIn = c?.fired && p?.fired ? "both" : c?.fired ? "current" : "compare";
    const shown = (fired === "compare" ? p : c) as Candidate;
    const main: Candidate = { ...shown, numbers: c ? c.numbers : zeros(shown.numbers) };
    return [Math.max(c?.weight ?? 0, p?.weight ?? 0), main, p, fired];
  });
  found.sort((a, b) => byStrength(a[1], b[1], a[0], b[0]));
  return found.slice(0, MAX_INSIGHTS).map(([, main, p, fired]) => ({
    ...toInsight(main),
    compare: numbers(p ? p.numbers : zeros(main.numbers)),
    firedIn: fired,
  }));
}

/** The span ids a rule links to on `input`, all of them, oldest first. */
export function ruleSpans(input: RuleInput, rule: InsightRule): number[] {
  const all = candidates(input)
    .filter((c) => c.fired && c.rule === rule)
    .flatMap((c) => c.spans)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return all.filter((x, i) => i === 0 || x[0] !== (all[i - 1] as [number, number])[0] || x[1] !== (all[i - 1] as [number, number])[1]).map(([, id]) => id);
}
