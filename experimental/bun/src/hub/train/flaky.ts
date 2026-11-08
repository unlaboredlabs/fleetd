// A check that fails on a PR's own head gets one more try before the train counts it red
// (crates/fleetd/src/hub/train/flaky.rs): the train re-runs that job alone, and the PR goes back to its author only
// when it fails again. A re-run that passes goes on to the merge, and the author and the lead hear in one line that the
// check was flaky, with the failing test when its log names one.
import type { Change } from "../../shared/contracts.ts";
import { prNote } from "./events.ts";
import { type CheckRun, jobOf, latest, workflowRun } from "./github.ts";
import { reran, type Reruns, rerunJobs } from "./next.ts";
import { short } from "./rules.ts";
import { TRAIN_BY, type Train } from "./service.ts";

/** How many times the train re-runs a job whose check failed on a PR's own head before it counts it red. */
export const FAILED_RERUNS = 1;

/** A check that failed and was re-run, with the test its log named. */
export type Flaky = { check: string; test?: string };

/** The first failing test a job's log names (cargo, nextest, Go, pytest, vitest, jest, Playwright); undefined for none. */
export function failedTest(log: string): string | undefined {
  for (const raw of log.split("\n")) {
    const line = plain(raw.endsWith("\r") ? raw.slice(0, -1) : raw).trim();
    let name: string | undefined;
    if (line.startsWith("test ") && line.endsWith(" ... FAILED")) name = line.slice(5, -" ... FAILED".length);
    else if (line.startsWith("FAIL [") && line.indexOf("]") >= 0) name = line.slice(line.indexOf("]") + 1);
    else if (line.startsWith("--- FAIL: ")) name = line.slice(10).split(/\s+/)[0] ?? "";
    else if (line.startsWith("FAILED ")) name = line.slice(7).split(" - ")[0] ?? "";
    else {
      const mark = ["FAIL ", "× ", "✗ ", "✘ ", "● "].find((m) => line.startsWith(m));
      if (mark === undefined) continue;
      name = line.slice(mark.length);
    }
    const n = name.trim();
    if (n !== "") return [...n].slice(0, 200).join("");
  }
  return undefined;
}

/** A log line without GitHub's timestamp and terminal colours. */
function plain(line: string): string {
  const sp = line.indexOf(" ");
  let rest = line;
  if (sp >= 0) {
    const stamp = line.slice(0, sp);
    if (Buffer.byteLength(stamp) >= 20 && stamp.endsWith("Z") && stamp.includes("T")) rest = line.slice(sp + 1);
  }
  // An escape: `ESC [ ... letter`.
  return rest.replace(/\u001b[^A-Za-z]*[A-Za-z]?/g, "");
}

/** The line the author and the lead get when a re-run passed. */
export function flakyText(sha: string, flaky: Flaky[]): string {
  const checks = flaky.map((f) => (f.test !== undefined ? `${f.check} (test ${f.test})` : f.check));
  return `flaky CI on ${short(sha)}: ${checks.join(", ")} failed, then passed when the train re-ran it, so the train carries on; nothing to do`;
}

/**
 * Re-runs each job of `red` that failed (not cancelled), and each cancelled job of its workflow run, on its own, once:
 * whether it re-ran one now. Undefined when the failure stands. Each failed job it re-ran goes in `flaky`.
 */
export async function rerunFailed(t: Train, repo: string, red: CheckRun[], runs: CheckRun[], reruns: Reruns, flaky: Flaky[]): Promise<boolean | undefined> {
  const cancelled = (r: CheckRun) => r.conclusion === "cancelled";
  const failed = red.filter((r) => !cancelled(r));
  if (failed.length === 0) return false;
  // A job that failed because one it needs was cancelled passes only once that one re-runs too.
  const failedRuns = failed.map(workflowRun).filter((w): w is number => w !== undefined);
  const beside = latest(runs)
    .filter((r) => cancelled(r) && failedRuns.includes(workflowRun(r) ?? -1))
    .filter((r) => !failed.some((f) => f.name === r.name));
  const all = [...failed, ...beside].sort((a, b) => a.id - b.id);
  const out = await rerunJobs(t, repo, all, runs, reruns, FAILED_RERUNS);
  if (out.unknown || out.spent || out.gaveUp) return undefined;
  for (const r of all) {
    if (cancelled(r) || !reran(reruns, r) || flaky.some((f) => f.check === r.name)) continue;
    let test: string | undefined;
    const job = jobOf(r);
    if (job !== undefined) {
      try {
        test = failedTest(await t.github.jobLog(repo, job));
      } catch (error) {
        console.warn(`train: job log not read (${repo} job ${job}): ${(error as Error).message}`);
      }
    }
    flaky.push(test === undefined ? { check: r.name } : { check: r.name, test });
  }
  return out.now;
}

/** Its author and the lead hear, in one line, that `flaky` failed on `sha` and passed on the train's re-run. */
export async function flakyNote(t: Train, change: Change, sha: string, flaky: Flaky[]): Promise<void> {
  if (flaky.length === 0) return;
  const text = flakyText(sha, flaky);
  console.info(`train: ${change.changeId}: ${text}`);
  if (change.taskId !== undefined) {
    try {
      await t.host.messageTask(change.projectRef, TRAIN_BY, change.taskId, `Your PR ${change.prUrl} (${change.changeId}): ${text}.`);
    } catch (error) {
      console.warn(`train: author ${change.taskId} of ${change.changeId} not messaged: ${(error as Error).message}`);
    }
  }
  await t.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
}
