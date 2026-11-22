// The train's figures (metrics/pipeline.ts): a landed change folded from its state spans, the check runs the train
// read and its PR's review verdicts; a batch's CI split over its PRs; the fold as backfill and as each new merge, once;
// and metrics_get's tiles, days, slowest jobs and each merge's figures.
import { afterEach, expect, test } from "bun:test";
import type { SpanKind, SpanStatus } from "../src/shared/contracts.ts";
import * as pipeline from "../src/hub/metrics/pipeline.ts";
import { foldSome } from "../src/hub/metrics/pipeline_store.ts";
import * as store from "../src/hub/metrics/store.ts";
import { write } from "../src/hub/time/store.ts";
import { DAY, HOUR, MIN, NOW, REPO, admin, done, get, hub, ms, sql, type H } from "./metrics-helpers.ts";

afterEach(done);

const S = 1000;
const T0 = ms("2026-10-24T10:00:00.000Z");

const stage = (kind: string, startMs: number, endMs: number, reason?: string): pipeline.StageSpan => ({
  kind,
  startMs,
  endMs,
  ...(reason === undefined ? {} : { reason }),
});
const check = (sha: string, name: string, startMs: number, endMs: number, how: "ok" | "failed" | "reran" = "ok"): pipeline.CheckSpan => ({
  sha,
  name,
  startMs,
  endMs,
  failed: how === "failed",
  reran: how === "reran",
  actions: true,
});

test("a change's stages, its trips back to its writer and its reviews fold from the train's records", () => {
  const [row] = pipeline.fold([
    {
      changeId: "X1",
      repo: REPO,
      prNumber: 7,
      mergedMs: T0 + 60 * MIN,
      stages: [
        stage("change.review", T0, T0 + 10 * MIN),
        stage("change.blocked", T0 + 10 * MIN, T0 + 20 * MIN, "needs_rebase"),
        stage("change.queue", T0 + 20 * MIN, T0 + 25 * MIN),
        stage("change.rebase", T0 + 25 * MIN, T0 + 26 * MIN),
        stage("change.ci", T0 + 26 * MIN, T0 + 30 * MIN),
        stage("change.blocked", T0 + 30 * MIN, T0 + 40 * MIN, "ci_failed"),
        stage("change.ci", T0 + 40 * MIN, T0 + 59 * MIN),
        // Still open when the merge landed: it ends there.
        { kind: "change.merge", startMs: T0 + 59 * MIN },
      ],
      checks: [
        check("a1", "test", T0 + 27 * MIN, T0 + 29 * MIN, "failed"),
        check("a1", "lint", T0 + 27 * MIN, T0 + 28 * MIN),
        check("b2", "test", T0 + 41 * MIN, T0 + 50 * MIN, "reran"),
        check("b2", "lint", T0 + 41 * MIN, T0 + 43 * MIN),
      ],
      verdicts: [2, 0],
    },
  ]);
  expect(row!.stages).toEqual({ review: 10 * MIN, back: 20 * MIN, queue: 6 * MIN, ci: 23 * MIN, merge: MIN });
  expect(row!.sentBack).toEqual({ conflicts: 1, redCi: 1 });
  expect([row!.reviews, row!.blocking, row!.known]).toEqual([2, 2, true]);
  expect(row!.runs.map((r) => [r.sha, r.wallMs, r.waitMs, r.riders])).toEqual([
    ["a1", 2 * MIN, MIN, 1],
    ["b2", 9 * MIN, MIN, 1],
  ]);
  const item = pipeline.item(row!);
  expect([item.ciWallMs, item.runnerMs, item.ciRuns, item.redRuns, item.flaky, item.firstPass]).toEqual([9 * MIN, 14 * MIN, 2, 1, 1, false]);
  expect(item.slowestJob).toEqual({ name: "test", ms: 9 * MIN });
});

test("a batch's run counts for each PR that rode it, and its runner time is split between them", () => {
  const ci = (id: string, checks: pipeline.CheckSpan[]): pipeline.Member => ({
    changeId: id,
    repo: REPO,
    mergedMs: T0 + 20 * MIN,
    stages: [stage("change.ci", T0, T0 + 19 * MIN)],
    checks,
    verdicts: [],
  });
  // The train recorded the batch head's checks under X1 alone; X2 was in CI while they ran.
  const rows = pipeline.fold([ci("X1", [check("c3", "test", T0 + 10 * S, T0 + 8 * MIN), check("c3", "lint", T0 + 10 * S, T0 + 2 * MIN)]), ci("X2", [])]);
  expect(rows.map((r) => [r.changeId, r.runs.length, r.runs[0]?.riders])).toEqual([
    ["X1", 1, 2],
    ["X2", 1, 2],
  ]);
  expect(rows.map((r) => Math.round(pipeline.runnerMs(r)))).toEqual([(10 * MIN - 20 * S) / 2, (10 * MIN - 20 * S) / 2]);
  // Counted once among the slowest jobs, however many PRs rode it.
  expect(pipeline.jobs([...rows, ...rows, ...rows]).map((j) => [j.name, j.runs])).toEqual([]);
});

test("a change the hub kept nothing of is known as such, and counts nowhere", () => {
  const [row] = pipeline.fold([{ changeId: "X9", repo: REPO, mergedMs: T0, stages: [], checks: [], verdicts: [3] }]);
  expect(row!.known).toBe(false);
  const t = pipeline.tiles([row!], [{ date: { y: 2026, m: 10, d: 24 }, start: T0 - HOUR, end: T0 + HOUR, len: DAY }] as never);
  expect([t.ci.n, t.reviews.n, t.sentBack.n, t.ci.medianMs]).toEqual([0, 0, 0, undefined]);
});

// ---- on a hub -----------------------------------------------------------------------------------------------------

function span(h: H, srcKey: string, kind: SpanKind, startMs: number, endMs: number, status: SpanStatus = "ok", extra?: Record<string, unknown>) {
  write(h.db.conn, { src: "h", srcKey, kind, startMs, endMs, ids: {}, lane: "change:acme/web", status, ...(extra ? { extra: extra as never } : {}) });
}

function merged(h: H, n: number, pr: number, at: number, sha = `${n}`.repeat(40).slice(0, 40)) {
  store.upsertMerge(h.db.conn, { repo: REPO, unitKey: `pr:${pr}`, machineId: "devbox", projectId: "web", prNumber: pr, mergedMs: at, mergedSha: sha, route: "train", changeId: `X${n}`, src: "event" });
}

/** A PR through the train at `at`: 5 minutes in review, 1 in line, `ciMin` in CI with two jobs, merged a minute on. */
function through(h: H, n: number, pr: number, at: number, ciMin: number, red = false) {
  const id = `X${n}`;
  span(h, `change/${id}/reviewing/${at}`, "change.review", at, at + 5 * MIN);
  span(h, `change/${id}/ready/${at}`, "change.queue", at + 5 * MIN, at + 6 * MIN);
  span(h, `change/${id}/ci/${at}`, "change.ci", at + 6 * MIN, at + (6 + ciMin) * MIN);
  const url = { url: "https://github.com/acme/web/actions/runs/1/job/2" };
  span(h, `check/${id}/${String(n).repeat(40)}/test`, "ci.check", at + 6 * MIN + 5 * S, at + (6 + ciMin) * MIN, red ? "failed" : "ok", { check: "test", ...url });
  span(h, `check/${id}/${String(n).repeat(40)}/lint`, "ci.check", at + 6 * MIN + 5 * S, at + 7 * MIN, "ok", { check: "lint", ...url });
  span(h, `check/${id}/${String(n).repeat(40)}/Vercel`, "ci.check", at + 6 * MIN, at + 6 * MIN, "ok", { check: "Vercel", url: "https://vercel.com/x" });
  span(h, `change/${id}/merging/${at}`, "change.merge", at + (6 + ciMin) * MIN, at + (7 + ciMin) * MIN);
  sql(h, "INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?1, ?2, 'x', 1, ?3, '{}')", `T${n}`, `${REPO}/pull/${pr}`, at);
  merged(h, n, pr, at + (7 + ciMin) * MIN);
}

const fold = (h: H) => {
  let passes = 1;
  while (h.db.transaction((c) => foldSome(c, h.clock.now()))) passes++;
  return passes;
};

test("the fold backfills every train merge once, waits for a fresh one to settle, and metrics_get reads it back", async () => {
  const { hub: h } = hub();
  const now = ms(NOW);
  through(h, 1, 11, now - 2 * DAY, 4);
  through(h, 2, 12, now - 2 * DAY + HOUR, 8, true);
  through(h, 3, 13, now - DAY, 6);
  // Older than the spans the hub keeps: folded as unknown.
  merged(h, 4, 14, now - 3 * DAY);
  // Landed a minute ago: its last spans may not be written yet.
  merged(h, 5, 15, now - MIN);
  fold(h);
  const count = () => h.db.conn.query<{ n: number; k: number }, []>("SELECT count(*) AS n, sum(known) AS k FROM metric_pipeline").get();
  expect(count()).toEqual({ n: 4, k: 3 });
  // A second pass finds nothing new.
  fold(h);
  expect(count()!.n).toBe(4);

  const out = await get(h, admin(), { since: isoDay(now - 6 * DAY), tz: "UTC" });
  const t = out.tiles.pipeline!;
  // Actions jobs only: the Vercel check doesn't stretch the wall time.
  expect([t.ci.n, t.ci.medianMs]).toEqual([3, 6 * MIN - 5 * S]);
  expect(t.ci.runnerTotalMs).toBe(4 * MIN - 5 * S + 8 * MIN - 5 * S + 6 * MIN - 5 * S + 3 * (MIN - 5 * S));
  expect([t.firstPass.n, Math.round(t.firstPass.pct!)]).toEqual([3, 67]);
  expect([t.reviews.n, t.reviews.perPr, t.reviews.blockingPerPr]).toEqual([3, 1, 1]);
  expect([t.sentBack.n, t.sentBack.pct, t.sentBack.conflicts, t.sentBack.redCi]).toEqual([3, 0, 0, 0]);
  expect(out.ciJobs?.map((j) => [j.name, j.runs, j.failed, j.medianMs])).toEqual([
    ["test", 3, 1, 5 * MIN - 5 * S],
    ["lint", 3, 0, MIN - 5 * S],
  ]);
  const day = out.days.find((d) => d.day === isoDay(now - 2 * DAY).slice(0, 10))!;
  expect(day.pipeline).toEqual({
    n: 2,
    stages: { review: 10 * MIN, back: 0, queue: 2 * MIN, ci: 12 * MIN, merge: 2 * MIN },
    sentBack: { conflicts: 0, redCi: 0 },
    ciMedianMs: 6 * MIN - 5 * S,
    runnerMedianMs: 7 * MIN - 10 * S,
  });
  const pr12 = out.merges.find((m) => m.prNumber === 12)!;
  expect([pr12.pipeline?.ciWallMs, pr12.pipeline?.firstPass, pr12.pipeline?.redRuns]).toEqual([8 * MIN - 5 * S, false, 1]);
  // Unknown and unsettled merges have no figures.
  expect(out.merges.find((m) => m.prNumber === 14)?.pipeline).toBeUndefined();
});

test("the prune drops the train's figures with their merges", () => {
  const { hub: h } = hub();
  through(h, 1, 11, ms(NOW) - 2 * DAY, 4);
  fold(h);
  h.db.transaction((c) => store.prune(c, ms(NOW) + 500 * DAY));
  expect(h.db.conn.query<{ n: number }, []>("SELECT count(*) AS n FROM metric_pipeline").get()!.n).toBe(0);
});

const isoDay = (t: number) => `${new Date(t).toISOString().slice(0, 10)}T00:00:00.000Z`;
