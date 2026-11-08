// The watch after a merge (crates/fleetd/src/hub/train/watch.rs). The train waits only for its fast set, so the repo's
// other checks finish after it merged: it watches them on the commit it put on the base, and the checks a batch skips.
// A check there that fails opens a fix order for the project's lead, once per failure; a watch ends once every check
// on the commit has finished, and after `WATCH_MAX_MS` at most.
import { type CheckRun, TRAIN_CONTEXT } from "./github.ts";
import { batchNames, gatedName, workflows } from "./next.ts";
import type { Watch } from "./records.ts";
import { type Fast, isRed, short } from "./rules.ts";
import type { Train } from "./service.ts";

/** A merged commit is watched at least this long, so checks that start late are seen. */
const WATCH_SETTLE_MS = 5 * 60_000;
/** And at most this long. */
const WATCH_MAX_MS = 6 * 60 * 60_000;

/** The checks on a merged commit that failed outside its fast set, or that a batch skips. */
export function failedAfter(runs: CheckRun[], fast: Fast, batch: string[]): CheckRun[] {
  const skippedByBatch = (r: CheckRun) => batch.some((n) => gatedName(n, r.name));
  return runs
    .filter((r) => skippedByBatch(r) || (fast.set.length > 0 && r.name !== TRAIN_CONTEXT && !fast.holds(r.name)))
    .filter((r) => isRed(r) && r.conclusion !== "cancelled");
}

/** The fix order's text: what failed, where, the run's link, and what to do. */
export function fixOrderText(w: Watch, check: CheckRun): string {
  const link = check.html_url ? ` Its run: ${check.html_url}` : "";
  return (
    `Fix the check \`${check.name}\` on ${w.base}: it failed after the merge train merged ${w.prUrl} as ${short(w.sha)}.${link} ` +
    "The train doesn't wait for this check on what it merges, or its batches skip it, so it ran there only after the merge. " +
    `Find why it fails on ${w.base} and make it pass again there.`
  );
}

/** After a merge onto `base` as `sha`: its checks outside the fast set are watched there from now on. */
export function watchMerge(t: Train, repo: string, base: string, sha: string, prUrl: string): void {
  const train = t.records.train(repo);
  if (!train) return;
  const projectRef = t.trainProject(repo, train.projectRef);
  t.records.watchMerge({ repo, sha: sha.toLowerCase(), base, projectRef, prUrl, sinceMs: t.nowMs() });
}

/** Each pass: every watched commit's checks read, a fix order for each new failure, and finished watches ended. */
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
      console.warn(`train: merged commit's checks not read (${repo}@${w.sha}): ${(error as Error).message}`);
      continue;
    }
    for (const check of failedAfter(runs, fast, batch)) await fixOrder(t, w, check);
    if (runs.every((r) => r.status === "completed") && now - w.sinceMs >= WATCH_SETTLE_MS) t.records.endWatch(repo, w.sha);
  }
}

/** One fix order per failure: none when this commit's failure has one, or an earlier one's order is still open. */
async function fixOrder(t: Train, w: Watch, check: CheckRun): Promise<void> {
  const repo = w.repo;
  const now = t.nowMs();
  const known = t.records.fixOrder(repo, check.name);
  if (known) {
    if (known.sha === w.sha) return;
    if (t.host.workstream(known.order)?.open) {
      t.records.putFixOrder(repo, check.name, w.sha, known.order, now);
      return;
    }
  }
  try {
    const order = await t.host.openOrder(w.projectRef, fixOrderText(w, check), `train-fix:${repo}:${w.sha}:${check.name}`);
    console.info(`train: ${check.name} failed after the merge of ${repo}@${w.sha}; fix order ${order} opened`);
    t.records.putFixOrder(repo, check.name, w.sha, order, now);
  } catch (error) {
    console.warn(`train: fix order for ${check.name} on ${repo} not opened; tried again next pass: ${(error as Error).message}`);
  }
}
