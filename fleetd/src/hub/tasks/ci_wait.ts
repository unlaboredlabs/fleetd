// `wait_ci`: a task asks to be woken when a GitHub Actions run, or the checks
// on a PR's head, finish. Each wait is a row in `ci_waits`; every POLL_EVERY_MS the hub reads GitHub for each, and one
// that finished continues its task's thread with one line: the outcome and the failing jobs.
//
// With `merged`, a PR's wait ends only when the PR merges, read from the merge train (a batch merges its PRs by closing
// them, so GitHub alone can't say): a writer whose next step needs another PR in waits on it so. It wakes its task too
// when the PR fails on the train (and goes on, as its writer fixes it) or is closed unmerged (and ends).
import type { Database } from "bun:sqlite";
import type { ProjectRef, TaskId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { parseMs } from "../store/time.ts";
import { limitReset } from "../train/budget.ts";
import type { Tasks } from "./index.ts";
import { taskHooks } from "./ports.ts";
import { holdsPr } from "./pr.ts";

export const POLL_EVERY_MS = 60_000;
/** A wait still open this long ends, telling its task so. */
export const GIVE_UP_MS = 6 * 3600 * 1000;
/** A wait with `merged` still open this long ends: a PR can sit in the train's line for hours. */
export const MERGE_GIVE_UP_MS = 24 * 3600 * 1000;
/** GitHub reads that fail in a row before the wait ends, telling its task why. */
export const READ_TRIES = 3;
/** A PR head counts as finished only once its last check completed this long ago. */
export const SETTLE_MS = 2 * 60_000;
const PER_TASK = 10;
/** Failing jobs named in the line; the rest are counted. */
const NAMED = 10;
const BY = "ci";

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
const passed = (c: string | undefined | null) => c === "success" || c === "skipped" || c === "neutral";

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

/** GitHub's reads, and the train's for `merged`; the hub's go through the train and its GitHub reader, tests fake them. */
export type CiReads = {
  read(target: Target): Promise<Read>;
  /** The PR's way to merging, as `by`'s person may see it. */
  merge(by: ProjectRef, target: Target): Promise<Merge>;
};

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

const repoOf = (t: Target) => t.repo.toLowerCase();

/**
 * Keeps `url` for `taskId` until it finishes, or with `merged` (a PR's only), until it merges. Only a run or PR in one
 * of the task's project's repos, or its own PR's.
 */
export function waitCi(tasks: Tasks, db: Database, now: number, taskId: TaskId, url: string, merged = false): { url: string; next: string } {
  const task = tasks.get(taskId);
  if (!task) throw new ToolError("not_found", `No task ${taskId}.`);
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
  const canonical = targetUrl(target);
  const ownPr = [task.pr, task.result?.prUrl]
    .filter((p): p is string => p !== undefined)
    .map(targetOf)
    .some((t) => t !== undefined && repoOf(t) === repoOf(target));
  if (!ownPr && !tasks.reposOf(task.projectRef).some((repo) => holdsPr(repo, canonical))) {
    throw new ToolError(
      "forbidden",
      `${repoOf(target)} is not one of this project's repos.`,
      "Wait only on CI of your project's repos; ask your lead about another repo.",
    );
  }
  const open = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM ci_waits WHERE task_id = ? AND url <> ?").get(taskId, canonical)?.n ?? 0;
  if (open >= PER_TASK) {
    throw new ToolError("invalid", `${taskId} already waits on ${open} CI runs or PRs.`, "Wait on fewer at once: each wakes you when it ends.");
  }
  // Asked again, a wait keeps its start and the failure it last woke for; the newest call says which kind it is.
  db.query(
    `INSERT INTO ci_waits (task_id, url, created_ms, merged) VALUES (?, ?, ?, ?)
     ON CONFLICT (task_id, url) DO UPDATE SET
       created_ms = CASE WHEN (excluded.merged IS NULL) = (merged IS NULL) THEN created_ms ELSE excluded.created_ms END,
       merged = CASE WHEN excluded.merged IS NULL THEN NULL ELSE COALESCE(merged, '') END`,
  ).run(taskId, canonical, now, merged ? "" : null);
  return {
    url: canonical,
    next: merged
      ? "Waiting. End your turn now if you have nothing else to do: this thread continues when the PR merges, or if it fails on the merge train or is closed unmerged."
      : "Waiting. End your turn now if you have nothing else to do: when it finishes, this thread continues with the outcome and the failing jobs.",
  };
}

/** A wait with `merged` keeps the failure it last woke its task for ('' none); NULL for a CI wait. */
type WaitRow = { task_id: string; url: string; created_ms: number; errors: number; merged: string | null };

/** Every open wait: task, URL, when asked, GitHub reads failed in a row, and a merge wait's last told failure. */
function ciWaits(db: Database): WaitRow[] {
  try {
    return db.query<WaitRow, []>("SELECT task_id, url, created_ms, errors, merged FROM ci_waits ORDER BY created_ms").all();
  } catch (error) {
    console.warn("ci waits not read:", error);
    return [];
  }
}

/** Each task's open wait URLs, by task id; a wait with `merged` says so. */
export function openCiWaits(db: Database): Map<string, string[]> {
  const open = new Map<string, string[]>();
  for (const w of ciWaits(db)) open.set(w.task_id, [...(open.get(w.task_id) ?? []), w.merged !== null ? `${w.url} (until it merges)` : w.url]);
  return open;
}

/** The lead's line for a done task with open waits: wait_ci wakes it, so it needs no steer. */
export const waitsNote = (taskId: string, urls: string[]) => `${taskId} waits on CI, and wait_ci wakes it as each ends: ${urls.join(" ")}.`;

function done(db: Database, taskId: string, url: string): void {
  try {
    db.query("DELETE FROM ci_waits WHERE task_id = ? AND url = ?").run(taskId, url);
  } catch (error) {
    console.warn(`ci wait not cleared (${taskId}):`, error);
  }
}

function told(db: Database, taskId: string, url: string, why: string): void {
  try {
    db.query("UPDATE ci_waits SET merged = ? WHERE task_id = ? AND url = ?").run(why, taskId, url);
  } catch (error) {
    console.warn(`merge wait: failure not kept (${taskId}):`, error);
  }
}

function setErrors(db: Database, taskId: string, url: string, errors: number): void {
  try {
    db.query("UPDATE ci_waits SET errors = ? WHERE task_id = ? AND url = ?").run(errors, taskId, url);
  } catch (error) {
    console.warn(`ci wait: errors not counted (${taskId}):`, error);
  }
}

/**
 * One pass: each finished wait wakes its task and goes. A wait of a failed, cancelled or deleted task goes silently.
 * `openBlocking` gives a PR's still-open blocking findings for its line. Returns how many tasks were woken.
 */
export async function pollCiWaits(
  tasks: Tasks,
  db: Database,
  now: number,
  reads: CiReads,
  openBlocking: (prUrl: string) => string = () => "",
): Promise<number> {
  let woken = 0;
  for (const { task_id: taskId, url, created_ms: created, errors, merged } of ciWaits(db)) {
    let task: ReturnType<Tasks["get"]>;
    try {
      task = tasks.get(taskId);
    } catch (error) {
      console.warn("ci wait: task not read:", error);
      continue;
    }
    if (!task || task.state === "cancelled" || task.state === "failed") {
      done(db, taskId, url);
      continue;
    }
    const target = targetOf(url);
    if (!target) {
      done(db, taskId, url);
      continue;
    }
    // The line, and for a merge wait that goes on after it, the failure it tells.
    let line: string | undefined;
    let goesOn: string | undefined;
    if (merged === null) {
      try {
        const read = await reads.read(target);
        if (errors > 0) setErrors(db, taskId, url, 0);
        line = summary(target, read);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // GitHub's rate limit is used up: no failure of the wait, which reads again once it resets.
        if (limitReset(error) !== undefined) continue;
        if (errors + 1 < READ_TRIES) {
          console.warn(`ci wait: GitHub not read (${url}): ${why}`);
          setErrors(db, taskId, url, errors + 1);
        } else {
          line = `CI you waited on (wait_ci) could not be read: GitHub failed ${READ_TRIES} times in a row for ${url} (${why}). Look at it with \`gh\`, or call wait_ci again.`;
        }
      }
    } else {
      // A merge read that fails (the train's records busy) leaves the wait as it is, for the next pass.
      let m: Merge;
      try {
        m = await reads.merge(task.projectRef, target);
      } catch (error) {
        console.warn(`merge wait: the train not read (${url}):`, error);
        continue;
      }
      if (m.kind === "pending") {
        // Back on its way, its next failure wakes the task again.
        if (merged !== "") told(db, taskId, url, "");
      } else if (m.kind === "failed" && m.why !== merged) {
        line = `A PR you waited on to merge (wait_ci merged) failed on the merge train: ${url}: ${m.why}. Its writer gets it back to fix; you still wait on it, and are woken when it merges or fails again.`;
        goesOn = m.why;
      } else if (m.kind === "merged") line = `A PR you waited on to merge (wait_ci merged) has merged: ${url}.`;
      else if (m.kind === "over") line = `A PR you waited on to merge (wait_ci merged) won't merge: ${url}: ${m.why}. Ask your lead what to build on instead.`;
    }
    const [giveUpMs, what] =
      merged === null
        ? [GIVE_UP_MS, "CI you waited on (wait_ci) has not finished"]
        : [MERGE_GIVE_UP_MS, "A PR you waited on to merge (wait_ci merged) has not merged"];
    const givenUp = now - created >= giveUpMs;
    if (line === undefined && givenUp) {
      line = `${what} after ${giveUpMs / 3_600_000} h: ${url}. Look at it with \`gh\`, or call wait_ci again.`;
      goesOn = undefined;
    }
    if (line === undefined) continue;
    // A PR's CI wake carries its still-open blocking findings, so a writer back from a rebase still fixes them.
    const open = target.kind === "pr" && task.kind !== "review" && merged === null ? openBlocking(targetUrl(target)) : "";
    if (open !== "") line = `${line}\n\n${open}`;
    try {
      await tasks.message({ projectRef: task.projectRef, by: BY }, taskId, line);
      woken += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Kept, to try again on the next pass, until it is given up.
      if (!givenUp) {
        console.warn(`ci wait: task not woken (${taskId}): ${message}`);
        continue;
      }
      console.warn(`ci wait: given up unsent (${taskId}): ${message}`);
    }
    if (goesOn !== undefined && !givenUp) told(db, taskId, url, goesOn);
    else done(db, taskId, url);
  }
  return woken;
}

/** The train's GitHub reader as the CI reads need it (T2247's `TrainGitHub`). */
export type CiGitHub = {
  get(path: string): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }>;
  pull(repo: string, n: number): Promise<{ state: string; merged?: boolean; merged_at?: string | null; head: { sha: string } }>;
  checkRuns(repo: string, sha: string): Promise<{ name: string; status: string; conclusion?: string | null; completed_at?: string | null }[]>;
  /** `ms`, or longer while GitHub's budget is low or used up. */
  spread?(ms: number): number;
};

const statusText = (r: { status: number; message: string }) => `${r.status}: ${r.message}`;

/** The train's hold for a Change waiting on an upstream PR: "held: waiting on owner/name#n: why" (train/next.rs). */
export const WAITING_ON = "held: waiting on ";
/** Why an upstream PR closed unmerged hasn't merged: it won't. */
export const CLOSED = "it was closed without merging";

/** Where an upstream PR stands on the train (train/next.rs `Waiting`): undefined once it merged. */
export type Waiting = { note: string; failed: boolean };

/** The train's reads a merge wait needs (train/next.rs `upstream`). */
export type MergeReads = {
  upstream(url: string): Promise<Waiting | undefined>;
};

/** A merge wait's answer from the train's reads. */
export async function mergeOf(train: MergeReads | undefined, by: ProjectRef, target: Target): Promise<Merge> {
  // Until the train sets its reads, a merge wait waits (and is given up on after MERGE_GIVE_UP_MS).
  if (!train) return { kind: "pending" };
  const url = targetUrl(target);
  const waiting = await train.upstream(url);
  if (!waiting) return { kind: "merged" };
  // The train's hold: "held: waiting on owner/name#n: why".
  const rest = waiting.note.startsWith(WAITING_ON) ? waiting.note.slice(WAITING_ON.length) : undefined;
  const colon = rest?.indexOf(": ") ?? -1;
  const why = rest !== undefined && colon >= 0 ? rest.slice(colon + 2) : waiting.note;
  if (why === CLOSED) return { kind: "over", why };
  return waiting.failed ? { kind: "failed", why } : { kind: "pending" };
}

/** The hub's GitHub reads, through the train's reader, and its merge reads, the train's. */
export function hubReads(hub: Hub, gh: CiGitHub, train?: MergeReads): CiReads {
  return {
    merge: (by, target) => mergeOf(train, by, target),
    async read(target) {
      if (target.kind === "run") {
        const run = await gh.get(`repos/${target.repo}/actions/runs/${target.id}`);
        if (!run.ok && run.status === 404) return { kind: "over", why: "is not a run GitHub has" };
        if (!run.ok) throw new Error(statusText(run));
        const r = run.value as { status?: string; conclusion?: string | null; name?: string };
        if (r.status !== "completed") return { kind: "running" };
        const jobs = await gh.get(`repos/${target.repo}/actions/runs/${target.id}/jobs?filter=latest&per_page=100`);
        if (!jobs.ok) throw new Error(statusText(jobs));
        const list = ((jobs.value as { jobs?: { name?: string; conclusion?: string | null }[] }).jobs ?? []) as { name?: string; conclusion?: string | null }[];
        return {
          kind: "finished",
          ...(typeof r.conclusion === "string" ? { conclusion: r.conclusion } : {}),
          label: r.name ?? "run",
          failing: list.filter((j) => !passed(j.conclusion)).flatMap((j) => (typeof j.name === "string" ? [j.name] : [])),
          total: list.length,
        };
      }
      const pull = await gh.pull(target.repo, target.number);
      if (pull.merged === true || (pull.merged_at ?? null) !== null) return { kind: "over", why: "was merged" };
      if (pull.state !== "open") return { kind: "over", why: "was closed" };
      const sha = pull.head.sha;
      const runs = await gh.get(`repos/${target.repo}/actions/runs?head_sha=${sha}&per_page=100`);
      if (!runs.ok) throw new Error(statusText(runs));
      const statuses = ((runs.value as { workflow_runs?: { status?: string }[] }).workflow_runs ?? []).flatMap((r) =>
        typeof r.status === "string" ? [r.status] : [],
      );
      const checks = (await gh.checkRuns(target.repo, sha)).map((c) => {
        const completedMs = c.completed_at ? parseMs(c.completed_at) : undefined;
        return {
          name: c.name,
          status: c.status,
          ...(typeof c.conclusion === "string" ? { conclusion: c.conclusion } : {}),
          ...(completedMs !== undefined ? { completedMs } : {}),
        };
      });
      return headRead(sha, statuses, checks, hub.clock.now());
    },
  };
}

/** Every POLL_EVERY_MS: reads GitHub for each open wait and wakes the tasks whose CI finished. */
export async function run(hub: Hub, tasks: Tasks, sleep: (ms: number) => Promise<void>): Promise<void> {
  const signal = hub.shutdown.signal;
  let every = POLL_EVERY_MS;
  while (!signal.aborted) {
    await sleep(every);
    if (signal.aborted) return;
    // GitHub is read through the train's reader; until the train sets it, waits stay open.
    const train = taskHooks(hub).train;
    if (!train) continue;
    // Spread out while GitHub's budget is low, until it resets.
    every = train.github.spread?.(POLL_EVERY_MS) ?? POLL_EVERY_MS;
    const reviews = taskHooks(hub).reviews;
    const n = await pollCiWaits(tasks, hub.db.conn, hub.clock.now(), hubReads(hub, train.github, train.merges), (pr) => reviews?.openBlocking(pr) ?? "");
    if (n > 0) console.info(`${n} tasks woken by the CI they waited on`);
  }
}
