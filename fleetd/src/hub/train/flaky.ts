// A check that fails on a PR's own head gets one more try before the train counts it red:
// the train re-runs that job alone, and the PR goes back to its author only
// when it fails again. A re-run that passes goes on to the merge, and the author and the lead hear in one line that the
// check was flaky, with the failing test when its log names one. Except a test the PR itself adds or changes: a flake
// there is the PR's own, and would turn the base red once merged (#1979's did), so that failure stands at once.
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

/** The most failing tests `failedTests` names. */
const TESTS_MAX = 20;

/** The first failing test a job's log names (cargo, nextest, Go, pytest, Bun, vitest, jest, Playwright); undefined for none. */
export function failedTest(log: string): string | undefined {
  return failedTests(log)[0];
}

/** Every failing test a job's log names, in order, each once, at most `TESTS_MAX`. */
export function failedTests(log: string): string[] {
  const out: string[] = [];
  for (const raw of log.split("\n")) {
    const line = plain(raw.endsWith("\r") ? raw.slice(0, -1) : raw).trim();
    let name: string | undefined;
    if (line.startsWith("test ") && line.endsWith(" ... FAILED")) name = line.slice(5, -" ... FAILED".length);
    else if (line.startsWith("FAIL [") && line.indexOf("]") >= 0) name = line.slice(line.indexOf("]") + 1);
    else if (line.startsWith("--- FAIL: ")) name = line.slice(10).split(/\s+/)[0] ?? "";
    else if (line.startsWith("FAILED ")) name = line.slice(7).split(" - ")[0] ?? "";
    // Bun: `(fail) describe > test [97.28ms]`.
    else if (line.startsWith("(fail) ")) name = line.slice(7).replace(/ \[[\d.]+m?s\]$/, "");
    else {
      const mark = ["FAIL ", "× ", "✗ ", "✘ ", "● "].find((m) => line.startsWith(m));
      if (mark === undefined) continue;
      name = line.slice(mark.length);
    }
    const n = [...name.trim()].slice(0, 200).join("");
    if (n !== "" && !out.includes(n)) out.push(n);
    if (out.length >= TESTS_MAX) break;
  }
  return out;
}

/**
 * A failing test's own name, as its source spells it: past its file and describe blocks (`a > b`, `a › b`, `a::b`), a
 * Go subtest's parent (`TestA/b`), without its timing (`12ms`, `(1.2s)`) or parameters (`[x-1]`).
 */
export function testLeaf(name: string): string {
  let leaf = name.replace(/\s+\(?[\d.]+m?s\)?$/, "");
  for (const sep of [" > ", " › ", "::"]) leaf = leaf.split(sep).at(-1) ?? leaf;
  if (/^Test\w*\//.test(leaf)) leaf = leaf.slice(0, leaf.indexOf("/"));
  return leaf.replace(/\[[^\]]*\]$/, "").trim();
}

/** Whether `path` is a test file by its name: under a test directory, or named as one. */
export function isTestFile(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const file = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((d) => ["test", "tests", "__tests__", "spec", "e2e"].includes(d))) return true;
  return /[._-](test|spec)s?\.[a-z]+$/.test(file) || /^test_.*\.py$/.test(file);
}

/**
 * The failing tests of `names` that the PR's `diff` adds or changes: whose own name is on a line of a hunk of a test
 * file that adds or removes lines. A test only its neighbours' hunks reach counts too; one far from any change doesn't.
 */
export function ownTests(diff: string, names: string[]): string[] {
  const hunks: string[] = [];
  let test = false;
  let hunk: string[] | undefined;
  const end = () => {
    if (hunk && test && hunk.some((l) => l.startsWith("+") || l.startsWith("-"))) hunks.push(hunk.join("\n").replaceAll("\\", ""));
    hunk = undefined;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      end();
      test = false;
    } else if (line.startsWith("+++ ")) {
      test = isTestFile(line.slice(4).replace(/^b\//, ""));
    } else if (line.startsWith("@@")) {
      end();
      hunk = [];
    } else if (hunk) {
      hunk.push(line);
    }
  }
  end();
  return names.filter((n) => {
    const leaf = testLeaf(n);
    return leaf !== "" && hunks.some((h) => h.includes(leaf));
  });
}

/**
 * A PR's own tests as one wait on its CI reads them: `of`, which of its failing tests its diff adds or changes
 * (`ownTests`, none when its diff can't be read); `tests`, the failing tests each failed run's log named, read once;
 * `own`, the ones of its own that failed.
 */
export type Mine = { of: (names: string[]) => Promise<string[]>; tests: Map<number, string[]>; own: Flaky[] };

/** The text a PR goes back with when its own tests `own` failed: the train doesn't re-run those as flakes. */
export function ownText(own: Flaky[]): string {
  const tests = own.map((f) => `${f.test} (${f.check})`).join(", ");
  const one = own.length === 1;
  return (
    `the failing test${one ? "" : "s"} ${tests} ${one ? "is one" : "are ones"} this PR adds or changes, so the train doesn't re-run ` +
    `${one ? "it" : "them"} as a flake: a test that fails even once here fails on the base after the merge. Make ${one ? "it" : "them"} pass every time`
  );
}

/** The failing tests the log of `r`'s job names; none when it has no job or its log can't be read. */
async function jobTests(t: Train, repo: string, r: CheckRun): Promise<string[]> {
  const job = jobOf(r);
  if (job === undefined) return [];
  try {
    return failedTests(await t.github.jobLog(repo, job));
  } catch (error) {
    console.warn(`train: job log not read (${repo} job ${job}): ${(error as Error).message}`);
    return [];
  }
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
 * whether it re-ran one now. Undefined when the failure stands. Each failed job it re-ran goes in `flaky`. A failed job
 * whose log names a test the PR adds or changes (`mine`) is never re-run: the failure stands, those tests in `mine.own`.
 */
export async function rerunFailed(t: Train, repo: string, red: CheckRun[], runs: CheckRun[], reruns: Reruns, flaky: Flaky[], mine: Mine): Promise<boolean | undefined> {
  const cancelled = (r: CheckRun) => r.conclusion === "cancelled";
  const failed = red.filter((r) => !cancelled(r));
  if (failed.length === 0) return false;
  // Read before the re-run: a failing test of the PR's own stands without one.
  for (const r of failed) {
    if (mine.tests.has(r.id)) continue;
    const names = await jobTests(t, repo, r);
    mine.tests.set(r.id, names);
    if (names.length === 0) continue;
    for (const test of await mine.of(names)) mine.own.push({ check: r.name, test });
  }
  if (mine.own.length > 0) return undefined;
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
    const test = (mine.tests.get(r.id) ?? (await jobTests(t, repo, r)))[0];
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
      t.warnHourly([`train: author ${change.taskId} of ${change.changeId} not messaged`], (error as Error).message, `train: author ${change.taskId} of ${change.changeId} not messaged: ${(error as Error).message}`);
    }
  }
  await t.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
}
