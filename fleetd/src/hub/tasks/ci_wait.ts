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
import {
  BY,
  type Merge,
  giveUpMs,
  givenUpLine,
  headRead,
  mergeLine,
  notProjectRepo,
  ownPr,
  passed,
  PER_TASK,
  POLL_EVERY_MS,
  type Read,
  READ_TRIES,
  summary,
  type Target,
  targetFor,
  targetOf,
  targetUrl,
  tooManyWaits,
  type Waiting,
  waitingMerge,
  waitLabel,
  waitNext,
  unreadLine,
} from "./ci_rules.ts";

export {
  CLOSED,
  type Check,
  GIVE_UP_MS,
  headRead,
  type Merge,
  MERGE_GIVE_UP_MS,
  POLL_EVERY_MS,
  type Read,
  READ_TRIES,
  SETTLE_MS,
  summary,
  type Target,
  targetOf,
  targetUrl,
  type Waiting,
  WAITING_ON,
  waitsNote,
} from "./ci_rules.ts";

/** GitHub's reads, and the train's for `merged`; the hub's go through the train and its GitHub reader, tests fake them. */
export type CiReads = {
  read(target: Target): Promise<Read>;
  /** The PR's way to merging, as `by`'s person may see it. */
  merge(by: ProjectRef, target: Target): Promise<Merge>;
};

/**
 * Keeps `url` for `taskId` until it finishes, or with `merged` (a PR's only), until it merges. Only a run or PR in one
 * of the task's project's repos, or its own PR's.
 */
export function waitCi(tasks: Tasks, db: Database, now: number, taskId: TaskId, url: string, merged = false): { url: string; next: string } {
  const task = tasks.get(taskId);
  if (!task) throw new ToolError("not_found", `No task ${taskId}.`);
  const target = targetFor(url, merged);
  const canonical = targetUrl(target);
  if (!ownPr(task, target) && !tasks.reposOf(task.projectRef).some((repo) => holdsPr(repo, canonical))) throw notProjectRepo(target);
  const open = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM ci_waits WHERE task_id = ? AND url <> ?").get(taskId, canonical)?.n ?? 0;
  if (open >= PER_TASK) throw tooManyWaits(taskId, open);
  // Asked again, a wait keeps its start and the failure it last woke for; the newest call says which kind it is.
  db.query(
    `INSERT INTO ci_waits (task_id, url, created_ms, merged) VALUES (?, ?, ?, ?)
     ON CONFLICT (task_id, url) DO UPDATE SET
       created_ms = CASE WHEN (excluded.merged IS NULL) = (merged IS NULL) THEN created_ms ELSE excluded.created_ms END,
       merged = CASE WHEN excluded.merged IS NULL THEN NULL ELSE COALESCE(merged, '') END`,
  ).run(taskId, canonical, now, merged ? "" : null);
  return { url: canonical, next: waitNext(merged) };
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
  for (const w of ciWaits(db)) open.set(w.task_id, [...(open.get(w.task_id) ?? []), waitLabel(w.url, w.merged !== null)]);
  return open;
}


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
          line = unreadLine(url, why);
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
        line = mergeLine(url, m);
        goesOn = m.why;
      } else if (m.kind === "merged" || m.kind === "over") line = mergeLine(url, m);
    }
    const givenUp = now - created >= giveUpMs(merged !== null);
    if (line === undefined && givenUp) {
      line = givenUpLine(url, merged !== null);
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

/** The train's reads a merge wait needs (train/next.rs `upstream`). */
export type MergeReads = {
  upstream(url: string): Promise<Waiting | undefined>;
};

/** A merge wait's answer from the train's reads. */
export async function mergeOf(train: MergeReads | undefined, by: ProjectRef, target: Target): Promise<Merge> {
  // Until the train sets its reads, a merge wait waits (and is given up on after MERGE_GIVE_UP_MS).
  if (!train) return { kind: "pending" };
  return waitingMerge(await train.upstream(targetUrl(target)));
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
