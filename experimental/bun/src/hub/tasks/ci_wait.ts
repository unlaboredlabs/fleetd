// `wait_ci` (crates/fleetd/src/hub/tasks/ci_wait.rs): a task asks to be woken when a GitHub Actions run, or the checks
// on a PR's head, finish. Each wait is a row in `ci_waits`; every POLL_EVERY_MS the hub reads GitHub for each, and one
// that finished continues its task's thread with one line: the outcome and the failing jobs.
import type { Database } from "bun:sqlite";
import type { TaskId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { parseMs } from "../store/time.ts";
import type { Tasks } from "./index.ts";
import { taskHooks } from "./ports.ts";
import { holdsPr } from "./pr.ts";

export const POLL_EVERY_MS = 60_000;
/** A wait still open this long ends, telling its task so. */
export const GIVE_UP_MS = 6 * 3600 * 1000;
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

/** GitHub's reads; the hub's go through the train's GitHub reader, tests fake them. */
export type CiReads = { read(target: Target): Promise<Read> };

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

/** Keeps `url` for `taskId` until it finishes. Only a run or PR in one of the task's project's repos, or its own PR's. */
export function waitCi(tasks: Tasks, db: Database, now: number, taskId: TaskId, url: string): { url: string; next: string } {
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
  db.query("INSERT OR IGNORE INTO ci_waits (task_id, url, created_ms) VALUES (?, ?, ?)").run(taskId, canonical, now);
  return {
    url: canonical,
    next: "Waiting. End your turn now if you have nothing else to do: when it finishes, this thread continues with the outcome and the failing jobs.",
  };
}

type WaitRow = { task_id: string; url: string; created_ms: number; errors: number };

/** Every open wait: task, URL, when asked, GitHub reads failed in a row. */
function ciWaits(db: Database): WaitRow[] {
  try {
    return db.query<WaitRow, []>("SELECT task_id, url, created_ms, errors FROM ci_waits ORDER BY created_ms").all();
  } catch (error) {
    console.warn("ci waits not read:", error);
    return [];
  }
}

/** Each task's open wait URLs, by task id. */
export function openCiWaits(db: Database): Map<string, string[]> {
  const open = new Map<string, string[]>();
  for (const w of ciWaits(db)) open.set(w.task_id, [...(open.get(w.task_id) ?? []), w.url]);
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
  for (const { task_id: taskId, url, created_ms: created, errors } of ciWaits(db)) {
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
    let line: string | undefined;
    try {
      const read = await reads.read(target);
      if (errors > 0) setErrors(db, taskId, url, 0);
      line = summary(target, read);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (errors + 1 < READ_TRIES) {
        console.warn(`ci wait: GitHub not read (${url}): ${why}`);
        setErrors(db, taskId, url, errors + 1);
      } else {
        line = `CI you waited on (wait_ci) could not be read: GitHub failed ${READ_TRIES} times in a row for ${url} (${why}). Look at it with \`gh\`, or call wait_ci again.`;
      }
    }
    const givenUp = now - created >= GIVE_UP_MS;
    if (line === undefined && givenUp) {
      line = `CI you waited on (wait_ci) has not finished after ${GIVE_UP_MS / 3_600_000} h: ${url}. Look at it with \`gh\`, or call wait_ci again.`;
    }
    if (line === undefined) continue;
    // A PR's wake carries its still-open blocking findings, so a writer back from a rebase still fixes them.
    const open = target.kind === "pr" && task.kind !== "review" ? openBlocking(targetUrl(target)) : "";
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
    done(db, taskId, url);
  }
  return woken;
}

/** The train's GitHub reader as the CI reads need it (T2247's `TrainGitHub`). */
export type CiGitHub = {
  get(path: string): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }>;
  pull(repo: string, n: number): Promise<{ state: string; merged?: boolean; merged_at?: string | null; head: { sha: string } }>;
  checkRuns(repo: string, sha: string): Promise<{ name: string; status: string; conclusion?: string | null; completed_at?: string | null }[]>;
};

const statusText = (r: { status: number; message: string }) => `${r.status}: ${r.message}`;

/** The hub's GitHub reads, through the train's reader. */
export function hubReads(hub: Hub, gh: CiGitHub): CiReads {
  return {
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
  while (!signal.aborted) {
    await sleep(POLL_EVERY_MS);
    if (signal.aborted) return;
    // GitHub is read through the train's reader; until the train sets it, waits stay open.
    const train = taskHooks(hub).train;
    if (!train) continue;
    const reviews = taskHooks(hub).reviews;
    const n = await pollCiWaits(tasks, hub.db.conn, hub.clock.now(), hubReads(hub, train.github), (pr) => reviews?.openBlocking(pr) ?? "");
    if (n > 0) console.info(`${n} tasks woken by the CI they waited on`);
  }
}
