// The watch after a merge. The train waits only for its fast set, so the repo's
// other checks finish after it merged: it watches them on the commit it put on the base, and the checks a batch skips,
// which never ran on the merged tree before. Its fast checks too: they passed on the batch, but the base's own run of
// them can still fail (a check scoped to some paths runs there on a change it skipped on the batch). A check there that
// fails is re-run once, its own job only: a flake or a GitHub blip passes then, and opens nothing. One that fails again
// opens a fix order for the project's lead, once per failure: the same check failing on later merges, while its order
// is still open, is that order's, not a new one, and isn't re-run. Runs a person or a schedule started on the commit
// aren't the merge's: the watch leaves them. Nor does it open one for a failure a fix is already under way for: an open
// PR or a write task under way that names the failing test or the run. What it did is kept per commit, so a restart
// re-runs nothing twice. A watch ends once every check on the commit has finished, no re-run is still to show, and
// after `WATCH_MAX_MS` at most.
import type { WorkstreamId } from "../../shared/contracts.ts";
import { failedTests, testLeaf } from "./flaky.ts";
import { type CheckRun, jobOf, TRAIN_CONTEXT, workflowRun } from "./github.ts";
import { batchNames, gatedName, workflows } from "./next.ts";
import type { Watch } from "./records.ts";
import { type Fast, isRed, short } from "./rules.ts";
import type { Train } from "./service.ts";
import { blame, verifying } from "./verify.ts";

/** A merged commit is watched at least this long, so checks that start late are seen. */
const WATCH_SETTLE_MS = 5 * 60_000;
/** And at most this long. */
const WATCH_MAX_MS = 6 * 60 * 60_000;
/** A re-run that shows no newer run of its check this long after the train asked for it counts as failed again. */
const RERUN_SHOW_MS = 15 * 60_000;
/** The events of workflow runs a person or a schedule started, not the merge. */
const NOT_THE_MERGES = ["workflow_dispatch", "schedule"];

/** What the watch did about a check's run on a merged commit: re-ran it once, saw that re-run pass, or left it. */
const RERAN = "reran";
const RECOVERED = "recovered";
const MANUAL = "manual";
/** A fix already under way named its failure: kept once per check and commit, as run 0. */
const FIXING = "fixing";
/** A test name shorter than this names nothing reliably in a PR's or a task's words. */
const NAME_MIN = 8;

/**
 * The checks on a merged commit that failed, in its fast set or not, or that a batch skips: the ones a fix order is
 * for. Outside the checks a batch skips, none for an empty fast set: the train then waited for every check before the
 * merge, except in "Merge, then verify" (`verify`), where the merged tree is one no CI ran on yet. Each with whether it
 * passed on the batch: a fast check the batch doesn't skip.
 */
export function failedAfter(runs: CheckRun[], fast: Fast, batch: string[], verify = false): [CheckRun, boolean][] {
  const skippedByBatch = (r: CheckRun) => batch.some((n) => gatedName(n, r.name));
  return runs
    .filter((r) => skippedByBatch(r) || ((verify || fast.set.length > 0) && r.name !== TRAIN_CONTEXT))
    .filter((r) => isRed(r) && r.conclusion !== "cancelled")
    .map((r) => [r, fast.holds(r.name) && !skippedByBatch(r)]);
}

/**
 * The fix order's text: what failed, where, the run's link, and what to do. `reran`: the train re-ran it once, and it
 * failed again. `onBatch`: it passed on the batch before the merge.
 */
export function fixOrderText(w: Watch, check: CheckRun, reran: boolean, onBatch: boolean): string {
  const link = check.html_url ? ` Its run: ${check.html_url}` : "";
  const again = reran ? ", and again when the train re-ran it once" : "";
  const why = onBatch
    ? `It passed on the merge train's batch, but failed on ${w.base}'s own run: look at what that run does differently ` +
      "(a check scoped to some paths runs there on changes the batch's run skipped it for)."
    : "The train doesn't wait for this check on what it merges, or its batches skip it, so it ran there only after the merge.";
  return (
    `Fix the check \`${check.name}\` on ${w.base}: it failed after the merge train merged ${w.prUrl} as ${short(w.sha)}${again}.${link} ` +
    `${why} Find why it fails on ${w.base} and make it pass again there.`
  );
}

/** After a merge onto `base` as `sha`: its checks outside the fast set are watched there from now on. */
export function watchMerge(t: Train, repo: string, base: string, sha: string, prUrl: string): void {
  const train = t.records.train(repo);
  if (!train) return;
  const projectRef = t.trainProject(repo, train.projectRef);
  t.records.watchMerge({ repo, sha: sha.toLowerCase(), base, projectRef, prUrl, sinceMs: t.nowMs() });
}

/**
 * Each pass: every watched commit's checks read, each new failure re-run once or given its fix order (`failedCheck`),
 * and the watch ended once they all finished and no re-run is still to show.
 */
export async function watchPass(t: Train, repo: string): Promise<void> {
  for (const w of t.records.watches(repo)) {
    const now = t.nowMs();
    if (now - w.sinceMs >= WATCH_MAX_MS) {
      t.records.endWatch(repo, w.sha);
      continue;
    }
    const fast = await t.fast(repo, w.base);
    if (!fast) continue;
    const wf = await workflows(t, repo, w.base);
    const batch = wf ? batchNames(wf) : [];
    let runs: CheckRun[];
    try {
      runs = await t.github.checkRuns(repo, w.sha);
    } catch (error) {
      const message = (error as Error).message;
      t.warnHourly(["watch.checks", repo, w.sha], message, `train: merged commit's checks not read (${repo}@${w.sha}): ${message}`);
      continue;
    }
    recovered(t, w, runs);
    const events: Events = { read: undefined };
    // The workflow runs it re-ran a job of in this pass: going again, though `runs` read them done.
    const reranNow = new Set<number>();
    let waiting = false;
    for (const [check, onBatch] of failedAfter(runs, fast, batch, verifying(t, w.projectRef))) {
      if (await failedCheck(t, w, check, onBatch, runs, events, reranNow)) waiting = true;
    }
    const done = runs.every((r) => r.status === "completed");
    if (done && !waiting && now - w.sinceMs >= WATCH_SETTLE_MS) t.records.endWatch(repo, w.sha);
  }
}

/** The commit's workflow runs (id, event), read once a pass when a failed check needs them. */
type Events = { read: [number, string][] | undefined };

/** Each check the watch re-ran on `w`'s commit whose newer run passed: recorded, so the status no longer says it is re-run. */
function recovered(t: Train, w: Watch, runs: CheckRun[]): void {
  const seen = t.records.watchChecks(w.repo, w.sha);
  for (const { name, runId, did } of seen) {
    const settled = seen.some((s) => s.name === name && s.did === RECOVERED);
    if (did !== RERAN || settled) continue;
    const passed = runs.find((r) => r.name === name && r.id !== runId && r.status === "completed" && !isRed(r));
    if (passed) {
      console.info(`train: ${name} re-run after the merge of ${w.repo}@${w.sha} passed; no fix order`);
      t.records.putWatchCheck(w.repo, w.sha, name, passed.id, RECOVERED, t.nowMs());
    }
  }
}

/**
 * What the watch does about `check` failing on `w`'s commit (`runs`, its checks; `onBatch`, whether it passed on the
 * batch): nothing more once its failure there has a fix order, or it is a manual or scheduled run. Otherwise the open
 * fix order of the same check takes it; failed again after the train re-ran it, it opens one; failed the first time,
 * its job is re-run once, when its workflow run is done (GitHub re-runs none before, so a run with a job re-run this
 * pass, `reranNow`, waits for the next). True while the watch still has to see that re-run.
 */
async function failedCheck(t: Train, w: Watch, check: CheckRun, onBatch: boolean, runs: CheckRun[], events: Events, reranNow: Set<number>): Promise<boolean> {
  const { repo, sha } = w;
  const name = check.name;
  const now = t.nowMs();
  if (t.records.fixOrderAt(repo, name, sha) !== undefined) return false;
  const seen = t.records.watchChecks(repo, sha).filter((s) => s.name === name);
  if (seen.some((s) => s.did === FIXING)) return false;
  const mine = seen.find((s) => s.runId === check.id);
  if (mine) {
    if (mine.did !== RERAN) return false;
    if (now - mine.atMs < RERUN_SHOW_MS) return true;
    console.warn(`train: ${name} re-run after the merge of ${repo}@${sha} never showed; opening its fix order`);
    return fixOrder(t, w, check, true, onBatch);
  }
  const reran = seen.some((s) => s.did === RERAN);
  const run = workflowRun(check);
  const busy = (id: number) => runs.some((r) => r.status !== "completed" && workflowRun(r) === id);
  if (!reran && run !== undefined && reranNow.has(run)) return true;
  if (!reran && run !== undefined && busy(run)) return false;
  if (run !== undefined) {
    if (events.read === undefined) {
      try {
        events.read = await t.github.shaRunEvents(repo, sha);
      } catch (error) {
        console.warn(`train: merged commit's workflow runs not read (${repo}@${sha}): ${(error as Error).message}`);
        return false;
      }
    }
    if (events.read.some(([r, event]) => r === run && NOT_THE_MERGES.includes(event))) {
      console.info(`train: a manual or scheduled run ${run} of ${name} failed on ${repo}@${sha}; not the merge's, left to it`);
      t.records.putWatchCheck(repo, sha, name, check.id, MANUAL, now);
      return false;
    }
  }
  const order = openFixOrder(t, repo, name);
  if (order !== undefined) {
    t.records.putFixOrder(repo, name, sha, order, now);
    return false;
  }
  if (reran) return fixOrder(t, w, check, true, onBatch);
  // A check no Actions job reports: nothing re-runs it.
  const job = jobOf(check);
  if (job === undefined) return fixOrder(t, w, check, false, onBatch);
  try {
    await t.github.rerunJob(repo, job);
  } catch (error) {
    console.warn(`train: ${name} failed after the merge of ${repo}@${sha} and GitHub refused its re-run; opening its fix order: ${(error as Error).message}`);
    return fixOrder(t, w, check, false, onBatch);
  }
  console.info(`train: ${name} failed after the merge of ${repo}@${sha}; re-ran job ${job} once`);
  t.records.putWatchCheck(repo, sha, name, check.id, RERAN, now);
  if (run !== undefined) reranNow.add(run);
  return true;
}

/** The newest fix order of `check` failing on the base, while it is open. */
function openFixOrder(t: Train, repo: string, check: string): WorkstreamId | undefined {
  const known = t.records.fixOrder(repo, check);
  return known && t.host.workstream(known.order)?.open ? known.order : undefined;
}

/** The checks the watch re-ran on merged commit `sha` that haven't passed or got a fix order since: what the status says is being re-run. */
export function rerunning(t: Train, repo: string, rawSha: string): string[] {
  const sha = rawSha.toLowerCase();
  const seen = t.records.watchChecks(repo, sha);
  const names: string[] = [];
  for (const { name, did } of seen) {
    const settled = seen.some((s) => s.name === name && [RECOVERED, FIXING].includes(s.did)) || t.records.fixOrderAt(repo, name, sha) !== undefined;
    if (did === RERAN && !settled && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The checks failing on merged commit `sha` that a fix already under way names: what the status says is being fixed. */
export function fixing(t: Train, repo: string, rawSha: string): string[] {
  const names = t.records.watchChecks(repo, rawSha.toLowerCase()).filter((s) => s.did === FIXING).map((s) => s.name);
  return [...new Set(names)];
}

/**
 * The fix already under way for `check` failing on `w`'s commit: the first open PR (`#n`) or write task under way
 * (its id) whose words name a failing test its job's log names, or its workflow run's id. Undefined for none, and when
 * the open PRs can't be read: a fix order then rather than none.
 */
export async function fixUnderWay(t: Train, w: Watch, check: CheckRun): Promise<string | undefined> {
  const names: string[] = [];
  const run = workflowRun(check);
  if (run !== undefined) names.push(String(run));
  const job = jobOf(check);
  if (job !== undefined) {
    try {
      for (const test of failedTests(await t.github.jobLog(w.repo, job))) {
        const leaf = testLeaf(test);
        if ([...leaf].length >= NAME_MIN && !names.includes(leaf)) names.push(leaf);
      }
    } catch (error) {
      console.warn(`train: job log not read (${w.repo} job ${job}): ${(error as Error).message}`);
    }
  }
  if (names.length === 0) return undefined;
  const named = (text: string) => names.some((n) => text.includes(n));
  const task = (t.host.tasksUnderWay?.(w.projectRef) ?? []).find((v) => named(v.text));
  if (task) return task.taskId;
  try {
    const pull = (await t.github.openPulls(w.repo)).find((p) => named(`${p.title}\n${p.body}`));
    return pull ? `#${pull.number}` : undefined;
  } catch (error) {
    console.warn(`train: open PRs of ${w.repo} not read for a fix under way: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Opens the fix order for `check` failing on `w`'s commit (`reran`: again, after its re-run; `onBatch`: it passed on the
 * batch), and records it; in "Merge, then verify", reverts the merge that broke it instead where it can (verify.ts).
 * True while the watch must stay for it: a bisect still waits on a run.
 */
async function fixOrder(t: Train, w: Watch, check: CheckRun, reran: boolean, onBatch: boolean): Promise<boolean> {
  const repo = w.repo;
  const fix = await fixUnderWay(t, w, check);
  if (fix !== undefined) {
    console.info(`train: ${check.name} failed after the merge of ${repo}@${w.sha}; ${fix} already names it, so no fix order`);
    t.records.putWatchCheck(repo, w.sha, check.name, 0, FIXING, t.nowMs());
    return false;
  }
  // "Merge, then verify": the merge that broke it is found and reverted instead, where it can be.
  if (verifying(t, w.projectRef)) {
    const blamed = await blame(t, w, check);
    if (blamed === "waiting") return true;
    if (blamed === "taken") {
      t.records.putWatchCheck(repo, w.sha, check.name, 0, FIXING, t.nowMs());
      return false;
    }
  }
  try {
    const order = await t.host.openOrder(w.projectRef, fixOrderText(w, check, reran, onBatch), `train-fix:${repo}:${w.sha}:${check.name}`);
    console.info(`train: ${check.name} failed after the merge of ${repo}@${w.sha}; fix order ${order} opened`);
    t.records.putFixOrder(repo, check.name, w.sha, order, t.nowMs());
  } catch (error) {
    const message = (error as Error).message;
    t.warnHourly(["watch.fix_order", repo, w.sha, check.name], message, `train: fix order for ${check.name} on ${repo} not opened; tried again next pass: ${message}`);
  }
  return false;
}
