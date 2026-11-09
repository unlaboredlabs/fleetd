// A check GitHub still shows pending after its workflow run finished (crates/fleetd/src/hub/train/stale.rs). On #1362
// the Desktop QA run had completed green, but GitHub kept its job `qa (ubuntu-latest, 1/4)` in_progress (conclusion
// success), and the PR waited 45 minutes as "still running" until the lead re-ran the run by hand. Nothing finishes
// such a check by itself: once its run has been done `STALE_AFTER_MS`, the train re-runs that workflow run, once per
// head, and waits for the fresh result. The stale check never counts as passed.
import { type CheckRun, workflowRun } from "./github.ts";
import { parseMs } from "./seams.ts";
import type { Train } from "./service.ts";

/** How long a workflow run has been finished before a check of it GitHub still shows pending counts as stale. */
export const STALE_AFTER_MS = 5 * 60_000;
/** How often the train reads the workflow run of a check still pending on a head. */
const READ_EVERY_MS = 60_000;
/** How long the train remembers a head it looked at. */
const KEPT_MS = 24 * 60 * 60_000;

/** What the train read and did about one head's pending checks. */
export type StaleHead = {
  /** The workflow run it re-ran, and the checks of it that were stale then: once per head. */
  reran?: [number, number[]];
  /** When it last read each workflow run with a check pending. */
  read: Map<number, number>;
  /** When it last looked at the head. */
  at: number;
};

/** A head held by a stale check, and what the train did about it. */
export type Stale = {
  /** It re-ran the check's workflow run now. */
  now: boolean;
  /** Why the head still waits, as a PR left out of a batch says it. */
  why: string;
};

/** Why a head waits on `stale`, checks of a workflow run the train re-ran. */
function rerunWhy(stale: CheckRun[]): string {
  const names = stale.map((r) => `\`${r.name}\``).join(", ");
  return `its own head's ${names} stayed pending after its workflow run finished; the train re-ran that run and waits for the fresh result`;
}

/**
 * Re-runs the workflow run of a check in `waited` (the checks the train waits on, on head `sha`) that GitHub still
 * shows pending though the run finished `STALE_AFTER_MS` ago: once per head, its runs read at most every
 * `READ_EVERY_MS`. Defined while a check it re-ran is still the stale one; undefined when no check is stale.
 */
export async function rerunStale(t: Train, repo: string, sha: string, waited: CheckRun[]): Promise<Stale | undefined> {
  const pending = waited.filter((r) => r.status !== "completed");
  if (pending.length === 0) return undefined;
  const now = t.nowMs();
  for (const [k, h] of t.staleHeads) if (now - h.at >= KEPT_MS) t.staleHeads.delete(k);
  const key = `${repo}\u0000${sha}`;
  const head: StaleHead = t.staleHeads.get(key) ?? { read: new Map(), at: now };
  t.staleHeads.set(key, head);
  head.at = now;
  if (head.reran) {
    const ids = head.reran[1];
    const still = pending.filter((r) => ids.includes(r.id));
    return still.length > 0 ? { now: false, why: rerunWhy(still) } : undefined;
  }
  const due = [...new Set(pending.map(workflowRun).filter((w): w is number => w !== undefined))]
    .sort((a, b) => a - b)
    .filter((run) => {
      const at = head.read.get(run);
      return at === undefined || now - at >= READ_EVERY_MS;
    });
  for (const run of due) head.read.set(run, now);
  for (const run of due) {
    let read;
    try {
      read = await t.github.workflowRun(repo, run);
    } catch (error) {
      const message = (error as Error).message;
      t.warnHourly([repo, String(run), "train: workflow run not read"], message, `train: workflow run ${run} of ${repo} not read: ${message}`);
      continue;
    }
    const doneAt = read.status === "completed" && read.updated_at ? parseMs(read.updated_at) : undefined;
    if (doneAt === undefined || now - doneAt < STALE_AFTER_MS) continue;
    const stale = pending.filter((r) => workflowRun(r) === run);
    try {
      await t.github.rerunRun(repo, run);
    } catch (error) {
      const message = (error as Error).message;
      t.warnHourly([repo, String(run), "train: stale workflow run not re-run"], message, `train: stale workflow run ${run} of ${repo} not re-run: ${message}`);
      continue;
    }
    console.info(
      `train: re-ran workflow run ${run} of ${repo}@${sha}, whose ${stale.map((r) => r.name).join(", ")} stayed pending after it finished`,
    );
    head.reran = [run, stale.map((r) => r.id)];
    return { now: true, why: rerunWhy(stale) };
  }
  return undefined;
}
