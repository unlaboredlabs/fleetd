// wait_ci's rules and words, with no database behind them: what a wait names, how GitHub's answer reads, the task's
// line once it ends, and the refusals (ci_wait.ts keeps the waits and runs the passes).
import type { Task } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

export const POLL_EVERY_MS = 60_000;
/** A wait still open this long ends, telling its task so. */
export const GIVE_UP_MS = 6 * 3600 * 1000;
/** A wait with `merged` still open this long ends: a PR can sit in the train's line for hours. */
export const MERGE_GIVE_UP_MS = 24 * 3600 * 1000;
/** GitHub reads that fail in a row before the wait ends, telling its task why. */
export const READ_TRIES = 3;
/** A PR head counts as finished only once its last check completed this long ago. */
export const SETTLE_MS = 2 * 60_000;
export const PER_TASK = 10;
/** Failing jobs named in the line; the rest are counted. */
const NAMED = 10;
/** Who wakes a waiting task: `tasks.message`'s `by`. */
export const BY = "ci";

/** What a wait names: an Actions run, or a PR whose current head's checks count. */
export type Target = { kind: "run"; repo: string; id: number } | { kind: "pr"; repo: string; number: number };

export const targetUrl = (t: Target) =>
  t.kind === "run" ? `https://github.com/${t.repo}/actions/runs/${t.id}` : `https://github.com/${t.repo}/pull/${t.number}`;

const positive = (s: string | undefined) => (s !== undefined && /^[0-9]+$/.test(s) && Number(s) > 0 ? Number(s) : undefined);

/** `https://github.com/<owner>/<repo>/actions/runs/<id>[/…]` or `…/pull/<n>[/…]`. */
export function targetOf(url: string): Target | undefined {
  const t = url.trim();
  if (!t.startsWith("https://github.com/")) return undefined;
  const parts = t.slice("https://github.com/".length).split(/[/?#]/);
  const [owner, name, a, b, c] = parts;
  if (!owner || !name || a === undefined || b === undefined) return undefined;
  const repo = `${owner}/${name}`;
  if (a === "actions" && b === "runs" && c !== undefined) {
    const id = positive(c);
    return id === undefined ? undefined : { kind: "run", repo, id };
  }
  if (a === "pull") {
    const number = positive(b);
    return number === undefined ? undefined : { kind: "pr", repo, number };
  }
  return undefined;
}

/** What GitHub says of a target now. */
export type Read =
  | { kind: "running" }
  /** Every job (a run's) or check (a PR head's) completed: `failing` names those that didn't pass, of `total`. */
  | { kind: "finished"; conclusion?: string; label: string; failing: string[]; total: number }
  /** Nothing more will happen: why, in a few words. */
  | { kind: "over"; why: string };

/** One check run on a PR's head. */
export type Check = { name: string; status: string; conclusion?: string; completedMs?: number };

/** Job and check conclusions that pass. */
export const passed = (c: string | undefined | null) => c === "success" || c === "skipped" || c === "neutral";

/** A PR head's state: running while any run or check is, while it has none yet, and SETTLE_MS after its last. */
export function headRead(sha: string, runs: string[], checks: Check[], now: number): Read {
  const done = checks.map((c) => c.completedMs).filter((x): x is number => x !== undefined);
  const last = done.length > 0 ? Math.max(...done) : undefined;
  if (checks.length === 0 || runs.some((r) => r !== "completed") || checks.some((c) => c.status !== "completed") || last === undefined || now - last < SETTLE_MS) {
    return { kind: "running" };
  }
  return { kind: "finished", label: [...sha].slice(0, 7).join(""), failing: checks.filter((c) => !passed(c.conclusion)).map((c) => c.name), total: checks.length };
}

/** Where a PR a wait with `merged` names stands. */
export type Merge =
  /** Neither merged nor failed: in the train's line or CI, back with its writer, or not on the train yet. */
  | { kind: "pending" }
  | { kind: "merged" }
  /** It failed on the train, why ("its CI failed"): its writer fixes it, so the wait goes on. */
  | { kind: "failed"; why: string }
  /** It won't merge, why: closed unmerged. */
  | { kind: "over"; why: string };

/** The task's line for a finished wait. */
export function summary(target: Target, read: Read): string | undefined {
  const url = targetUrl(target);
  let line: string;
  if (read.kind === "running") return undefined;
  if (read.kind === "over") line = `${url} ${read.why}.`;
  else {
    const { conclusion, label, failing, total } = read;
    const names = failing.slice(0, NAMED);
    if (failing.length > NAMED) names.push(`and ${failing.length - NAMED} more`);
    const named = names.join(", ");
    const c = conclusion ?? "without a conclusion";
    if (target.kind === "run") {
      if (conclusion === "success" && failing.length === 0) line = `${url} (${label}) succeeded: all ${total} jobs passed.`;
      else if (failing.length === 0) line = `${url} (${label}) ended ${c}.`;
      else line = `${url} (${label}) ended ${c}: ${failing.length} of ${total} jobs failed: ${named}.`;
    } else if (failing.length === 0) line = `${url} at ${label}: all ${total} checks passed.`;
    else line = `${url} at ${label}: ${failing.length} of ${total} checks failed: ${named}.`;
  }
  return `CI you waited on (wait_ci) finished: ${line}`;
}

export const repoOf = (t: Target) => t.repo.toLowerCase();

/** The train's hold for a Change waiting on an upstream PR: "held: waiting on owner/name#n: why" (train/next.rs). */
export const WAITING_ON = "held: waiting on ";
/** Why an upstream PR closed unmerged hasn't merged: it won't. */
export const CLOSED = "it was closed without merging";

/** Where an upstream PR stands on the train (train/next.rs `Waiting`): undefined once it merged. */
export type Waiting = { note: string; failed: boolean };

/** The lead's line for a done task with open waits: wait_ci wakes it, so it needs no steer. */
export const waitsNote = (taskId: string, urls: string[]) => `${taskId} waits on CI, and wait_ci wakes it as each ends: ${urls.join(" ")}.`;

/** A merge wait's answer from where the PR stands on the train (`upstream`'s answer: undefined once it merged). */
export function waitingMerge(waiting: Waiting | undefined): Merge {
  if (!waiting) return { kind: "merged" };
  // The train's hold: "held: waiting on owner/name#n: why".
  const rest = waiting.note.startsWith(WAITING_ON) ? waiting.note.slice(WAITING_ON.length) : undefined;
  const colon = rest?.indexOf(": ") ?? -1;
  const why = rest !== undefined && colon >= 0 ? rest.slice(colon + 2) : waiting.note;
  if (why === CLOSED) return { kind: "over", why };
  return waiting.failed ? { kind: "failed", why } : { kind: "pending" };
}

/** An open wait as its task's lead reads it: a wait with `merged` says so. */
export const waitLabel = (url: string, merged: boolean) => (merged ? `${url} (until it merges)` : url);

/** What `url` names, for a wait with `merged` or without; refused when it is neither a run's nor a PR's, or a run's with `merged`. */
export function targetFor(url: string, merged: boolean): Target {
  const target = targetOf(url);
  if (!target) {
    throw new ToolError(
      "invalid",
      `${url.trim()} is not a GitHub Actions run or pull request URL.`,
      "Pass https://github.com/<owner>/<repo>/actions/runs/<id> (`gh run view <id> --json url -q .url`) or the PR's URL.",
    );
  }
  if (merged && target.kind !== "pr") {
    throw new ToolError("invalid", `${targetUrl(target)} is not a pull request: only a PR merges.`, "Pass the PR's URL with merged, or the run's without it.");
  }
  return target;
}

/** Whether `target` is in the repo of one of the task's own PRs. */
export const ownPr = (task: Pick<Task, "pr" | "result">, target: Target) =>
  [task.pr, task.result?.prUrl]
    .filter((p): p is string => p !== undefined)
    .map(targetOf)
    .some((t) => t !== undefined && repoOf(t) === repoOf(target));

/** The refusal for a target in none of the project's repos. */
export const notProjectRepo = (target: Target) =>
  new ToolError("forbidden", `${repoOf(target)} is not one of this project's repos.`, "Wait only on CI of your project's repos; ask your lead about another repo.");

/** The refusal for a task that already waits on PER_TASK others. */
export const tooManyWaits = (taskId: string, open: number) =>
  new ToolError("invalid", `${taskId} already waits on ${open} CI runs or PRs.`, "Wait on fewer at once: each wakes you when it ends.");

/** wait_ci's `next`. */
export const waitNext = (merged: boolean) =>
  merged
    ? "Waiting. End your turn now if you have nothing else to do: this thread continues when the PR merges, or if it fails on the merge train or is closed unmerged."
    : "Waiting. End your turn now if you have nothing else to do: when it finishes, this thread continues with the outcome and the failing jobs.";

/** The task's line once GitHub failed READ_TRIES times in a row for `url`. */
export const unreadLine = (url: string, why: string) =>
  `CI you waited on (wait_ci) could not be read: GitHub failed ${READ_TRIES} times in a row for ${url} (${why}). Look at it with \`gh\`, or call wait_ci again.`;

/** The task's line for a merge wait's PR that failed on the train, merged, or won't merge; undefined while pending. */
export function mergeLine(url: string, m: Merge): string | undefined {
  if (m.kind === "failed") {
    return `A PR you waited on to merge (wait_ci merged) failed on the merge train: ${url}: ${m.why}. Its writer gets it back to fix; you still wait on it, and are woken when it merges or fails again.`;
  }
  if (m.kind === "merged") return `A PR you waited on to merge (wait_ci merged) has merged: ${url}.`;
  if (m.kind === "over") return `A PR you waited on to merge (wait_ci merged) won't merge: ${url}: ${m.why}. Ask your lead what to build on instead.`;
  return undefined;
}

/** How long a wait (with `merged` or not) stays open before it is given up on. */
export const giveUpMs = (merged: boolean) => (merged ? MERGE_GIVE_UP_MS : GIVE_UP_MS);

/** The task's line for a wait given up on. */
export function givenUpLine(url: string, merged: boolean): string {
  const what = merged ? "A PR you waited on to merge (wait_ci merged) has not merged" : "CI you waited on (wait_ci) has not finished";
  return `${what} after ${giveUpMs(merged) / 3_600_000} h: ${url}. Look at it with \`gh\`, or call wait_ci again.`;
}
