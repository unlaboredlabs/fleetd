// The train's figures' table, `metric_pipeline`: each landed change the train merged, folded once (pipeline.ts) from
// its state spans, the check runs the train read for it and its PR's review verdicts, all on this hub already. The fold
// runs over every train merge without a row, so its first pass is the backfill of what the spans still hold and each
// pass after it takes the new merges; a merge whose spans are gone gets a row that says so, and is never read again.
import type { Database } from "bun:sqlite";
import type { SpanKind } from "../../shared/contracts.ts";
import { kindCode, kindOf, statusOf } from "../time/kinds.ts";
import { DAY_MS } from "./rows.ts";
import { type CheckSpan, type CiRun, fold, type Member, type PipelineRow, SETTLE_MS, type StageSpan } from "./pipeline.ts";

/** Merges folded per transaction. */
export const FOLD_BATCH = 50;

const STAGE_KINDS: SpanKind[] = ["change.review", "change.queue", "change.rebase", "change.ci", "change.merge", "change.blocked"];
const STAGE_CODES = STAGE_KINDS.map(kindCode);
const CHECK = kindCode("ci.check");

type Pending = { change_id: string; repo: string; pr_number: number | null; merged_ms: number; merged_sha: string | null };

/** Folds up to FOLD_BATCH train merges settled before `nowMs` that have no row yet; true when there may be more. */
export function foldSome(c: Database, nowMs: number): boolean {
  const pending = c
    .query<Pending, [number, number]>(
      `SELECT m.change_id, m.repo, m.pr_number, m.merged_ms, m.merged_sha FROM metric_merges m
       WHERE m.route = 'train' AND m.change_id IS NOT NULL AND m.merged_ms < ?1
         AND NOT EXISTS (SELECT 1 FROM metric_pipeline p WHERE p.change_id = m.change_id)
       ORDER BY m.merged_ms LIMIT ?2`,
    )
    .all(nowMs - SETTLE_MS, FOLD_BATCH);
  const done = new Set<string>();
  for (const m of pending) {
    if (done.has(m.change_id)) continue;
    // The changes that landed in the same commit fold together: a batch's CI ran once for all of them.
    const group =
      m.merged_sha === null
        ? [m]
        : c
            .query<Pending, [string, string, number, number]>(
              `SELECT change_id, repo, pr_number, merged_ms, merged_sha FROM metric_merges
               WHERE merged_ms >= ?3 AND merged_ms < ?4 AND repo = ?1 AND merged_sha = ?2 AND route = 'train'
                 AND change_id IS NOT NULL`,
            )
            .all(m.repo, m.merged_sha, m.merged_ms - DAY_MS, m.merged_ms + DAY_MS);
    for (const row of fold(group.map((g) => member(c, g)))) {
      if (!done.has(row.changeId)) write(c, row);
      done.add(row.changeId);
    }
  }
  return pending.length === FOLD_BATCH;
}

type SpanSql = { src_key: string; kind: number; start_ms: number; end_ms: number | null; status: number; extra: string | null };

const extraOf = (s: SpanSql): Record<string, unknown> => {
  try {
    const v = JSON.parse(s.extra ?? "{}") as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The spans the train keyed under `prefix` (`change/X12/`): a range of the (src, src_key) index. */
function spans(c: Database, prefix: string): SpanSql[] {
  // '0' follows '/', so [prefix, prefix with its '/' as '0') is every key under it.
  return c
    .query<SpanSql, [string, string]>(
      `SELECT src_key, kind, start_ms, end_ms, status, extra FROM time_spans
       WHERE src = 'h' AND src_key >= ?1 AND src_key < ?2`,
    )
    .all(prefix, `${prefix.slice(0, -1)}0`);
}

function member(c: Database, m: Pending): Member {
  const stages: StageSpan[] = spans(c, `change/${m.change_id}/`)
    .filter((s) => STAGE_CODES.includes(s.kind))
    .map((s) => {
      const reason = extraOf(s).reason;
      return {
        kind: kindOf(s.kind) ?? "",
        startMs: s.start_ms,
        ...(s.end_ms === null ? {} : { endMs: s.end_ms }),
        ...(typeof reason === "string" ? { reason } : {}),
      };
    });
  const checks: CheckSpan[] = spans(c, `check/${m.change_id}/`)
    .filter((s) => s.kind === CHECK)
    .flatMap((s) => {
      // `check/<change>/<sha>/<name>`, the name its own `/`s and all.
      const [, , sha, ...rest] = s.src_key.split("/");
      const extra = extraOf(s);
      const name = typeof extra.check === "string" ? extra.check : rest.join("/");
      if (sha === undefined || name === "") return [];
      const url = typeof extra.url === "string" ? extra.url : "";
      return [
        {
          sha,
          name,
          startMs: s.start_ms,
          endMs: Math.max(s.end_ms ?? s.start_ms, s.start_ms),
          failed: statusOf(s.status) === "failed",
          reran: extra.reran === true,
          actions: url.includes("/actions/runs/"),
        },
      ];
    });
  const verdicts =
    m.pr_number === null
      ? []
      : c
          .query<{ blocking: number }, [string]>("SELECT blocking FROM review_verdicts WHERE pr_key = ?1 ORDER BY at_ms")
          .all(`${m.repo}/pull/${m.pr_number}`)
          .map((v) => v.blocking);
  return {
    changeId: m.change_id,
    repo: m.repo,
    ...(m.pr_number === null ? {} : { prNumber: m.pr_number }),
    mergedMs: m.merged_ms,
    stages,
    checks,
    verdicts,
  };
}

function write(c: Database, r: PipelineRow): void {
  c.query(
    `INSERT INTO metric_pipeline (change_id, repo, pr_number, merged_ms, known, review_ms, back_ms, queue_ms, ci_ms,
       merge_ms, conflicts, red_ci, reviews, blocking, runs)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(change_id) DO NOTHING`,
  ).run(
    r.changeId,
    r.repo,
    r.prNumber ?? null,
    r.mergedMs,
    r.known ? 1 : 0,
    r.stages.review,
    r.stages.back,
    r.stages.queue,
    r.stages.ci,
    r.stages.merge,
    r.sentBack.conflicts,
    r.sentBack.redCi,
    r.reviews,
    r.blocking,
    JSON.stringify(r.runs),
  );
}

export const PIPELINE_COLUMN_LIST = `change_id, repo, pr_number, merged_ms, known, review_ms, back_ms, queue_ms, ci_ms,
  merge_ms, conflicts, red_ci, reviews, blocking, runs`;

/** Every row with `merged_ms` in `[since, until)`: the SQL and its parameters. */
export function pipelineSql(sinceMs: number, untilMs: number): [string, number[]] {
  return [`SELECT ${PIPELINE_COLUMN_LIST} FROM metric_pipeline WHERE merged_ms >= ?1 AND merged_ms < ?2`, [sinceMs, untilMs]];
}

const runsOf = (text: unknown): CiRun[] => {
  try {
    const v = JSON.parse(typeof text === "string" ? text : "[]") as unknown;
    return Array.isArray(v) ? (v as CiRun[]) : [];
  } catch {
    return [];
  }
};

/** A row of PIPELINE_COLUMN_LIST's values. */
export function pipelineOfValues(v: unknown[]): PipelineRow {
  const num = (i: number) => (typeof v[i] === "number" ? (v[i] as number) : 0);
  return {
    changeId: v[0] as string,
    repo: v[1] as string,
    ...(typeof v[2] === "number" ? { prNumber: v[2] } : {}),
    mergedMs: num(3),
    known: v[4] !== 0,
    stages: { review: num(5), back: num(6), queue: num(7), ci: num(8), merge: num(9) },
    sentBack: { conflicts: num(10), redCi: num(11) },
    reviews: num(12),
    blocking: num(13),
    runs: runsOf(v[14]),
  };
}
