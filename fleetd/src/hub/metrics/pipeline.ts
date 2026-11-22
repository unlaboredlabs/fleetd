// A landed change's time in the train and its CI runs, pure: folded once from the train's own records (its state
// spans, the check runs it read, its PR's review verdicts) into a row that outlives them, and read back as the
// Factory's pipeline figures. No GitHub call: the check runs are the ones the train already read to decide each
// merge. store.ts reads and writes the rows; the hosted service folds its own records with the same rules.
import type {
  CiJob,
  CiJobTime,
  MergePipeline,
  PipelineDay,
  PipelineTiles,
  SentBack,
  SparkPoint,
  StageMs,
} from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import { type Day, median, percentile, slices } from "./compute.ts";

export const STAGES = ["review", "back", "queue", "ci", "merge"] as const satisfies readonly (keyof StageMs)[];
export type Stage = (typeof STAGES)[number];

/** The train's state spans (`change/<id>/…`) by kind, as the stage they count to. */
const STAGE_OF: Record<string, Stage> = {
  "change.review": "review",
  "change.blocked": "back",
  "change.queue": "queue",
  "change.rebase": "queue",
  "change.ci": "ci",
  "change.merge": "merge",
};

/** A merge is folded this long after it lands: the train's last spans reach the database after its event. */
export const SETTLE_MS = 2 * 60_000;
/** A run's jobs start this soon before the train's CI state opens at the latest (its push and the poll race). */
const SLACK_MS = 30_000;
/** The slowest jobs the read names. */
export const MAX_JOBS = 8;

/** How a job of a run ended: passed (or cancelled, never a failure), failed, or passed when the train re-ran it. */
export const PASSED = 0;
export const FAILED = 1;
export const RERAN = 2;
export type JobEnd = typeof PASSED | typeof FAILED | typeof RERAN;

/** One job of a CI run: its check's name, its run time, how it ended. */
export type Job = [name: string, ms: number, end: JobEnd];

/** One head the train ran CI on: when its first job started, its wall time, the changes that rode it, its jobs. */
export type CiRun = { sha: string; atMs: number; wallMs: number; waitMs?: number; riders: number; jobs: Job[] };

/** A landed change's row. `known` is false when the hub had no record of its time in the train left to fold. */
export type PipelineRow = {
  changeId: string;
  repo: string;
  prNumber?: number;
  mergedMs: number;
  known: boolean;
  stages: StageMs;
  /** Times it went back to its writer, by why. */
  sentBack: SentBack;
  reviews: number;
  blocking: number;
  runs: CiRun[];
};

/** One of the train's state spans of a change. */
export type StageSpan = { kind: string; startMs: number; endMs?: number; reason?: string };

/** One check run the train read for a change: `actions` when it is a GitHub Actions job. */
export type CheckSpan = {
  sha: string;
  name: string;
  startMs: number;
  endMs: number;
  failed: boolean;
  reran: boolean;
  actions: boolean;
};

/** A landed change with its records: one of the changes that landed in the same commit (a batch), or alone. */
export type Member = {
  changeId: string;
  repo: string;
  prNumber?: number;
  mergedMs: number;
  stages: StageSpan[];
  checks: CheckSpan[];
  /** Its PR's review verdicts: the blocking findings of each. */
  verdicts: number[];
};

export const noStages = (): StageMs => ({ review: 0, back: 0, queue: 0, ci: 0, merge: 0 });

/**
 * The rows of the changes that landed in one commit. A batch's CI ran on one head, which the train records under one
 * of its changes: each member rides the runs it recorded and those that started while it was in CI, and a run's
 * runner time is split over the members that rode it.
 */
export function fold(members: Member[]): PipelineRow[] {
  const byHead = new Map<string, { sha: string; checks: CheckSpan[]; owners: Set<string> }>();
  for (const m of members) {
    for (const c of m.checks) {
      let run = byHead.get(c.sha);
      if (!run) byHead.set(c.sha, (run = { sha: c.sha, checks: [], owners: new Set() }));
      run.checks.push(c);
      run.owners.add(m.changeId);
    }
  }
  const windows = new Map(
    members.map((m) => [
      m.changeId,
      m.stages.filter((s) => s.kind === "change.ci").map((s) => [s.startMs, Math.min(s.endMs ?? m.mergedMs, m.mergedMs)] as const),
    ]),
  );
  const startOf = (checks: CheckSpan[]) => Math.min(...checks.map((c) => c.startMs));
  const windowOf = (id: string, at: number) => windows.get(id)?.find(([a, b]) => at >= a - SLACK_MS && at <= b);
  const rides = new Map<string, string[]>();
  for (const m of members) {
    rides.set(
      m.changeId,
      [...byHead.values()].filter((r) => r.owners.has(m.changeId) || windowOf(m.changeId, startOf(r.checks)) !== undefined).map((r) => r.sha),
    );
  }
  const riders = (sha: string) => members.filter((m) => rides.get(m.changeId)!.includes(sha)).length;
  return members.map((m) => {
    const stages = noStages();
    const sentBack: SentBack = { conflicts: 0, redCi: 0 };
    for (const s of m.stages) {
      const stage = STAGE_OF[s.kind];
      if (stage === undefined) continue;
      const end = Math.min(s.endMs ?? m.mergedMs, m.mergedMs);
      stages[stage] += Math.max(0, end - s.startMs);
      if (s.reason === "needs_rebase") sentBack.conflicts++;
      else if (s.reason === "ci_failed") sentBack.redCi++;
    }
    const runs = rides
      .get(m.changeId)!
      .map((sha) => {
        const all = byHead.get(sha)!.checks;
        // A repo's other checks (a deploy preview, an outside CI) aren't Actions: only Actions jobs, when it has any.
        const checks = all.some((c) => c.actions) ? all.filter((c) => c.actions) : all;
        const at = startOf(checks);
        const w = windowOf(m.changeId, at);
        const run: CiRun = {
          sha,
          atMs: at,
          wallMs: Math.max(0, Math.max(...checks.map((c) => c.endMs)) - at),
          riders: Math.max(1, riders(sha)),
          jobs: checks
            .map((c): Job => [c.name, Math.max(0, c.endMs - c.startMs), c.failed ? FAILED : c.reran ? RERAN : PASSED])
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
        };
        if (w !== undefined) run.waitMs = Math.max(0, at - w[0]);
        return run;
      })
      .sort((a, b) => a.atMs - b.atMs);
    return {
      changeId: m.changeId,
      repo: m.repo,
      ...(m.prNumber === undefined ? {} : { prNumber: m.prNumber }),
      mergedMs: m.mergedMs,
      known: m.stages.length > 0,
      stages,
      sentBack,
      reviews: m.verdicts.length,
      blocking: m.verdicts.reduce((a, b) => a + Math.max(0, b), 0),
      runs,
    };
  });
}

// ---- reading the rows back -------------------------------------------------------------------------------------------

const last = (r: PipelineRow): CiRun | undefined => r.runs[r.runs.length - 1];
const failedRun = (run: CiRun) => run.jobs.some((j) => j[2] === FAILED);
/** Its share of the runner time of every run it rode. */
export const runnerMs = (r: PipelineRow): number => r.runs.reduce((a, run) => a + run.jobs.reduce((x, j) => x + j[1], 0) / run.riders, 0);
export const firstPass = (r: PipelineRow): boolean | undefined => (r.runs[0] === undefined ? undefined : !failedRun(r.runs[0]));
export const flaky = (r: PipelineRow): number => r.runs.reduce((a, run) => a + run.jobs.filter((j) => j[2] === RERAN).length, 0);
export const wentBack = (r: PipelineRow): boolean => r.sentBack.conflicts + r.sentBack.redCi > 0;

const whole = (v: number) => Math.max(0, Math.round(v));

/** A row as the merge list and the hovers show it. */
export function item(r: PipelineRow): MergePipeline {
  const run = last(r);
  const slow = run?.jobs.find((j) => j[0] !== "");
  const pass = firstPass(r);
  const slowestJob: CiJobTime | undefined = slow === undefined ? undefined : { name: slow[0], ms: whole(slow[1]) };
  return {
    stages: { ...r.stages },
    ciRuns: r.runs.length,
    redRuns: r.runs.filter(failedRun).length,
    flaky: flaky(r),
    reviews: r.reviews,
    blocking: r.blocking,
    sentBack: { ...r.sentBack },
    ...(run === undefined ? {} : { ciWallMs: whole(run.wallMs), runnerMs: whole(runnerMs(r)) }),
    ...(run?.waitMs === undefined ? {} : { waitMs: whole(run.waitMs) }),
    ...(pass === undefined ? {} : { firstPass: pass }),
    ...(slowestJob === undefined ? {} : { slowestJob }),
  };
}

const sorted = (v: number[]) => v.toSorted((a, b) => a - b);
const pct = (k: number, n: number) => (n > 0 ? (100 * k) / n : undefined);
const per = (v: number, n: number) => (n > 0 ? v / n : undefined);
const opt = <K extends string, V>(key: K, v: V | undefined) => (v === undefined ? {} : ({ [key]: v } as { [P in K]: V }));
const optWhole = <K extends string>(key: K, v: number | undefined) => opt(key, v === undefined ? undefined : whole(v));

/** The four figures over a set of rows. */
class Figures {
  wall: number[];
  /** Each PR's share of runner time, sorted. */
  runners: number[];
  runner = 0;
  ran: number;
  first = 0;
  firsts = 0;
  flaky = 0;
  known: PipelineRow[];
  reviews = 0;
  blocking = 0;
  back = 0;
  conflicts = 0;
  redCi = 0;

  constructor(rows: PipelineRow[]) {
    this.known = rows.filter((r) => r.known);
    const ran = rows.filter((r) => r.runs.length > 0);
    this.ran = ran.length;
    this.wall = sorted(ran.map((r) => last(r)!.wallMs));
    this.runners = sorted(ran.map(runnerMs));
    for (const r of ran) {
      this.runner += runnerMs(r);
      this.flaky += flaky(r);
      this.firsts++;
      if (firstPass(r)) this.first++;
    }
    for (const r of this.known) {
      this.reviews += r.reviews;
      this.blocking += r.blocking;
      if (wentBack(r)) this.back++;
      if (r.sentBack.conflicts > 0) this.conflicts++;
      if (r.sentBack.redCi > 0) this.redCi++;
    }
  }
  firstPct = () => pct(this.first, this.firsts);
  reviewsPerPr = () => per(this.reviews, this.known.length);
  backPct = () => pct(this.back, this.known.length);
  runnerPerPr = () => per(this.runner, this.ran);
}

const inDays = (rows: PipelineRow[], ds: Day[]) => {
  const from = ds[0]?.start ?? 0;
  const to = ds[ds.length - 1]?.end ?? 0;
  return rows.filter((r) => r.mergedMs >= from && r.mergedMs < to);
};

function spark(rows: PipelineRow[], ds: Day[], value: (f: Figures) => number | undefined): SparkPoint[] {
  return slices(ds).map((slice) => {
    const v = value(new Figures(inDays(rows, slice)));
    const since = isoMs(slice[0]!.start);
    return v === undefined || !Number.isFinite(v) ? { since } : { since, value: Math.max(0, v) };
  });
}

/** The train's KPI row over the period's rows; `previous` the period before's, when its merges were known. */
export function tiles(rows: PipelineRow[], days: Day[], previous?: PipelineRow[]): PipelineTiles {
  const f = new Figures(rows);
  const p = previous === undefined ? undefined : new Figures(previous);
  return {
    ci: {
      n: f.ran,
      ...opt("medianMs", median(f.wall)),
      ...opt("p90Ms", percentile(f.wall, 0.9)),
      ...opt("previousMedianMs", p === undefined ? undefined : median(p.wall)),
      ...optWhole("runnerMedianMs", median(f.runners)),
      ...optWhole("runnerPerPrMs", f.runnerPerPr()),
      ...optWhole("previousRunnerPerPrMs", p?.runnerPerPr()),
      runnerTotalMs: whole(f.runner),
      spark: spark(rows, days, (x) => median(x.wall)),
    },
    firstPass: {
      n: f.firsts,
      ...opt("pct", f.firstPct()),
      ...opt("previousPct", p?.firstPct()),
      flaky: f.flaky,
      spark: spark(rows, days, (x) => x.firstPct()),
    },
    reviews: {
      n: f.known.length,
      ...opt("perPr", f.reviewsPerPr()),
      ...opt("blockingPerPr", per(f.blocking, f.known.length)),
      ...opt("previousPerPr", p?.reviewsPerPr()),
      spark: spark(rows, days, (x) => x.reviewsPerPr()),
    },
    sentBack: {
      n: f.known.length,
      ...opt("pct", f.backPct()),
      ...opt("previousPct", p?.backPct()),
      conflicts: f.conflicts,
      redCi: f.redCi,
      spark: spark(rows, days, (x) => x.backPct()),
    },
  };
}

/** One day's rows: their stage times summed, the PRs sent back by why, and the day's CI medians. */
export function day(rows: PipelineRow[]): PipelineDay {
  const stages = noStages();
  const sentBack: SentBack = { conflicts: 0, redCi: 0 };
  let n = 0;
  for (const r of rows) {
    if (!r.known) continue;
    n++;
    for (const s of STAGES) stages[s] += r.stages[s];
    if (r.sentBack.conflicts > 0) sentBack.conflicts++;
    if (r.sentBack.redCi > 0) sentBack.redCi++;
  }
  for (const s of STAGES) stages[s] = whole(stages[s]);
  const ran = rows.filter((r) => r.runs.length > 0);
  return {
    n,
    stages,
    sentBack,
    ...optWhole("ciMedianMs", median(sorted(ran.map((r) => last(r)!.wallMs)))),
    ...optWhole("runnerMedianMs", median(sorted(ran.map(runnerMs)))),
  };
}

/** Each run once, however many rows rode it. */
function distinctRuns(rows: PipelineRow[]): [repo: string, run: CiRun][] {
  const out = new Map<string, [string, CiRun]>();
  for (const r of rows) for (const run of r.runs) out.set(`${r.repo}@${run.sha}`, [r.repo, run]);
  return [...out.values()];
}

type JobTimes = { repo: string; name: string; ms: number[]; failed: number; runs: number };

/** Each repo's jobs, by "repo\0name". */
function jobTimes(rows: PipelineRow[]): Map<string, JobTimes> {
  const out = new Map<string, JobTimes>();
  for (const [repo, run] of distinctRuns(rows)) {
    for (const [name, ms, end] of run.jobs) {
      if (name === "") continue;
      const key = `${repo}\u0000${name}`;
      let j = out.get(key);
      if (!j) out.set(key, (j = { repo, name, ms: [], failed: 0, runs: 0 }));
      j.runs++;
      if (end === FAILED) j.failed++;
      else j.ms.push(ms);
    }
  }
  return out;
}

/** A job must have run this often in the range to be named: one run or two say little. */
const MIN_RUNS = 3;

/**
 * The slowest jobs over the period's runs, each run once, by their median when they passed; the period before's
 * median beside.
 */
export function jobs(rows: PipelineRow[], previous?: PipelineRow[]): CiJob[] {
  const before = previous === undefined ? undefined : jobTimes(previous);
  const out: CiJob[] = [];
  for (const [key, j] of jobTimes(rows)) {
    const ms = sorted(j.ms);
    const mid = median(ms);
    if (mid === undefined || mid <= 0 || j.runs < MIN_RUNS) continue;
    const was = before?.get(key);
    const prev = was === undefined ? undefined : median(sorted(was.ms));
    out.push({
      repo: j.repo,
      name: [...j.name].slice(0, 200).join(""),
      runs: j.runs,
      failed: j.failed,
      medianMs: whole(mid),
      p90Ms: whole(percentile(ms, 0.9) ?? mid),
      ...optWhole("previousMedianMs", prev),
    });
  }
  return out.sort((a, b) => b.medianMs - a.medianMs || (a.name < b.name ? -1 : 1)).slice(0, MAX_JOBS);
}
