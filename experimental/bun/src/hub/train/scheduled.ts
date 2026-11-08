// Scheduled runs on the base (crates/fleetd/src/hub/train/scheduled.rs). A workflow a schedule starts checks what pull
// requests don't, long after their merge. When the newest finished scheduled run of a workflow on the base failed, a
// fix order opens for the project's lead: it names the failed jobs, the run's link and the commits since that
// workflow's last green scheduled run. One failure opens one order; only a run that finished in the last day counts.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { WorkflowRun } from "./github.ts";
import { short } from "./rules.ts";
import { parseMs } from "./seams.ts";
import type { Train } from "./service.ts";

const SCHEDULED_EVERY_MS = 10 * 60_000;
const SCHEDULED_RECENT_MS = 24 * 60 * 60_000;
const COMMITS_SHOWN = 20;

/** A run or job that failed: a cancelled one didn't. */
const failed = (conclusion: string | null | undefined) => conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure";

/** Of `runs` (newest first), each workflow's newest run when it failed recently, with its newest green run before it. */
export function newestFailures(runs: WorkflowRun[], sinceMs: number): [WorkflowRun, WorkflowRun | undefined][] {
  const workflows = new Set<number>();
  const out: [WorkflowRun, WorkflowRun | undefined][] = [];
  runs.forEach((r, i) => {
    if (workflows.has(r.workflow_id)) return;
    workflows.add(r.workflow_id);
    const at = r.updated_at ? parseMs(r.updated_at) : undefined;
    if (!failed(r.conclusion) || at === undefined || at < sinceMs) return;
    out.push([r, runs.slice(i + 1).find((g) => g.workflow_id === r.workflow_id && g.conclusion === "success")]);
  });
  return out;
}

/** The fix order's text: which workflow failed where, its failed jobs and link, and the commits since its last green run. */
export function scheduledOrderText(
  base: string,
  run: WorkflowRun,
  jobs: string[],
  green: WorkflowRun | undefined,
  commits: { commits: [string, string][]; total: number } | undefined,
): string {
  const workflow = run.name ?? "a scheduled workflow";
  const names = jobs.map((j) => `\`${j}\``).join(", ");
  let since: string;
  if (!green) since = "None of its recent scheduled runs passed, so the commits that broke it aren't narrowed down.";
  else if (green.head_sha.toLowerCase() === run.head_sha.toLowerCase()) {
    since = `Its scheduled run passed on this same commit before (${green.html_url}), so a flaky check or a change outside the repo is likelier than a commit.`;
  } else if (!commits) since = `GitHub didn't list the commits since its last green scheduled run, at ${short(green.head_sha)}.`;
  else {
    since = `The commits since its last green scheduled run, at ${short(green.head_sha)}:`;
    for (const [sha, title] of commits.commits.slice(0, COMMITS_SHOWN)) since += `\n- ${sha} ${title}`;
    const more = Math.max(0, commits.total - Math.min(commits.commits.length, COMMITS_SHOWN));
    if (more > 0) since += `\n- and ${more} more`;
  }
  const file = run.path?.split("/").at(-1);
  const again = file !== undefined ? ` \`gh workflow run ${file} --ref ${base}\` runs it again.` : "";
  return (
    `Fix the scheduled run of \`${workflow}\` on ${base}: it failed at ${short(run.head_sha)} in ${names}. Its run: ${run.html_url} ` +
    `Pull requests and the merge train don't run it, so this is the first check of these commits there. ${since}\n` +
    `Find what broke it and make it pass again on ${base}.${again}`
  );
}

/** At most every `SCHEDULED_EVERY_MS`: each workflow's newest scheduled run on the base read, a fix order for a failure. */
export async function scheduledPass(t: Train, repo: string, projectRef: ProjectRef): Promise<void> {
  const now = t.nowMs();
  const last = t.scheduledReads.get(repo);
  if (last !== undefined && now - last < SCHEDULED_EVERY_MS) return;
  t.scheduledReads.set(repo, now);
  const base = t.sync.base(repo);
  if (base === undefined) return;
  let runs: WorkflowRun[];
  try {
    runs = await t.github.scheduledRuns(repo, base);
  } catch {
    return;
  }
  const owner = t.trainProject(repo, projectRef);
  for (const [run, green] of newestFailures(runs, now - SCHEDULED_RECENT_MS)) {
    const key = `${repo}\u0000${run.id}`;
    if (t.scheduledSeen.has(key)) continue;
    let jobs;
    try {
      jobs = await t.github.runJobs(repo, run.id);
    } catch (error) {
      t.warnHourly([`train: a scheduled run's jobs not read (${repo} run ${run.id})`], (error as Error).message, `train: a scheduled run's jobs not read (${repo} run ${run.id}): ${(error as Error).message}`);
      continue;
    }
    const red = jobs.filter((j) => failed(j.conclusion)).map((j) => j.name);
    // A run that failed before any job started (a broken workflow file): the workflow is what failed.
    if (red.length === 0) red.push(run.name ?? String(run.id));
    if (await scheduledFixOrder(t, repo, owner, base, run, green, red)) t.scheduledSeen.add(key);
  }
}

/** One fix order per failure; false when the order couldn't be opened, to try again next pass. */
async function scheduledFixOrder(
  t: Train,
  repo: string,
  projectRef: ProjectRef,
  base: string,
  run: WorkflowRun,
  green: WorkflowRun | undefined,
  jobs: string[],
): Promise<boolean> {
  const now = t.nowMs();
  const sha = run.head_sha.toLowerCase();
  const known = jobs.map((j) => t.records.fixOrder(repo, j)).filter((k): k is NonNullable<typeof k> => k !== undefined);
  if (known.length === jobs.length && known.every((k) => k.sha === sha)) return true;
  const open = known.find((k) => t.host.workstream(k.order)?.open);
  if (open) {
    for (const job of jobs) t.records.putFixOrder(repo, job, sha, open.order, now);
    return true;
  }
  let commits;
  if (green && green.head_sha.toLowerCase() !== run.head_sha.toLowerCase()) {
    try {
      commits = await t.github.commitsSince(repo, green.head_sha, run.head_sha);
    } catch {
      commits = undefined;
    }
  }
  try {
    const order = await t.host.openOrder(projectRef, scheduledOrderText(base, run, jobs, green, commits), `train-scheduled:${repo}:${run.id}`);
    console.info(`train: a scheduled run failed (${repo} run ${run.id}); fix order ${order} opened`);
    for (const job of jobs) t.records.putFixOrder(repo, job, sha, order, now);
    return true;
  } catch (error) {
    t.warnHourly([`train: fix order not opened for ${repo} run ${run.id}; tried again next pass`], (error as Error).message, `train: fix order not opened for ${repo} run ${run.id}; tried again next pass: ${(error as Error).message}`);
    return false;
  }
}
