// Priority on scarce CI runners, and merge order across PRs. The train puts
// `fleetd:next` on what it is merging now: its batch PR, or the PR it takes alone (before GitHub rebases it, so that
// push's CI run already sees the label), and takes it off once they merge or leave the queue. A repo whose runners
// are scarce runs its expensive jobs on labelled PRs only; the train knows such a repo by its workflows naming the
// label. There, a PR it merges alone never merges on a skipped check the label should have run.
//
// Merge order (`after`): a Change whose `after` PRs haven't all merged waits in line, held "waiting on" the first of
// them. A PR stacked on a writer's open PR gets that PR in its `after` by itself (`stack`); one based on a branch that
// landed goes into that branch's base (`restack`).
import type { Change, ProjectRef } from "../../shared/contracts.ts";
import { prNote } from "./events.ts";
import { type CheckRun, GhError, jobOf, NEXT_LABEL, type Pull, workflowRun } from "./github.ts";
import { WAITING_FOR_LIMIT } from "./budget.ts";
import { HEAD_STATES, parsePrUrl, QUEUED_STATES } from "./records.ts";
import { errorText } from "./records.ts";
import { BLOCKED_PREFIX, timedOut, type Train } from "./service.ts";
import {
  type BatchSkip,
  batchSkipped,
  type Gate,
  gatedName,
  jobChecks,
  LABEL_ABOUT,
  LABEL_COLOR,
  labelGated,
  type Labelled,
  loopsBackVia,
  mergeAfter,
  noRerun,
  queued,
  type Reran,
  RERUN_BACKOFF_MS,
  RERUN_TRIES,
  rerunKey,
  type Reruns,
  UPSTREAM_TTL_MS,
  type UpstreamPull,
  USES_TTL_MS,
  type Waiting,
  WAITING_FOR_RUNNERS,
  WAITING_ON,
  type Workflows,
} from "./next_rules.ts";

export {
  batchNames,
  type BatchSkip,
  batchSkipped,
  type Gate,
  gatedName,
  jobChecks,
  LABEL_HOLD_MS,
  labelGated,
  type Labelled,
  type Lone,
  loneSince,
  NextLabels,
  provenRuns,
  queued,
  type Reran,
  reran,
  type Rerun,
  RERUN_TRIES,
  type Reruns,
  RUNNER_WAIT_MS,
  unprovenBatchSkips,
  unprovenSkips,
  type UpstreamPull,
  upstreams,
  type Waiting,
  WAITING_FOR_RUNNERS,
  WAITING_ON,
  type Workflows,
} from "./next_rules.ts";


const key2 = (a: string, b: string) => `${a}\u0000${b}`;

function labelFailed(t: Train, repo: string, why: string): void {
  if (!t.nextLabels.warned.has(repo)) {
    t.nextLabels.warned.add(repo);
    console.warn(`train: the ${NEXT_LABEL} label could not be set on ${repo}: ${why}`);
  }
}

const labelWorked = (t: Train, repo: string) => t.nextLabels.warned.delete(repo);

/** Creates the repo's label and reads the PRs that carry it, once per repo. */
async function labelsKnown(t: Train, repo: string): Promise<boolean> {
  if (t.nextLabels.known.has(repo)) return true;
  try {
    await t.github.createLabel(repo, NEXT_LABEL, LABEL_COLOR, LABEL_ABOUT);
    const found = await t.github.labelledPulls(repo, NEXT_LABEL);
    const prs = t.nextLabels.prs(repo);
    for (const n of found) if (!prs.has(n)) prs.set(n, undefined);
    t.nextLabels.known.add(repo);
    labelWorked(t, repo);
    return true;
  } catch (error) {
    labelFailed(t, repo, (error as Error).message);
    return false;
  }
}

/** The checks the label runs in the repo's CI on `base`; unknown while those can't be read. */
export async function labelGate(t: Train, repo: string, base: string): Promise<Gate> {
  const w = await workflows(t, repo, base);
  return w ? { kind: "checks", names: w.label } : { kind: "unknown" };
}

/** What the repo's workflows on `base` say, read once per `USES_TTL_MS`; a failed read keeps the last answer. */
export async function workflows(t: Train, repo: string, base: string): Promise<Workflows | undefined> {
  const key = key2(repo, base);
  const now = t.nowMs();
  const known = t.nextLabels.gated.get(key);
  if (known && now - known[0] < USES_TTL_MS) return known[1];
  try {
    const files = await t.github.workflowFiles(repo, base);
    const w: Workflows = { label: labelGated(files), batch: batchSkipped(files), jobs: jobChecks(files) };
    t.nextLabels.gated.set(key, [now, w]);
    return w;
  } catch (error) {
    t.warnHourly([`train: workflows of ${repo} not read`], (error as Error).message, `train: workflows of ${repo} not read: ${(error as Error).message}`);
    if (known) return known[1];
    let last: [number, Workflows] | undefined;
    for (const [k, v] of t.nextLabels.gated) if (k.startsWith(`${repo}\u0000`) && (!last || v[0] > last[0])) last = v;
    return last?.[1];
  }
}

/** The checks of `names` that a job of `base`'s workflows reports and none of the tree at `sha` does. */
export async function undefinedAt(t: Train, repo: string, base: string, sha: string, names: string[]): Promise<string[]> {
  const onBase = await workflows(t, repo, base);
  if (!onBase) return [];
  const defined = (jobs: string[], name: string) => jobs.some((j) => gatedName(j, name));
  const wanted = names.filter((n) => defined(onBase.jobs, n));
  if (wanted.length === 0) return [];
  const key = key2(repo, sha);
  let jobs = t.nextLabels.heads.get(key)?.jobs;
  if (jobs === undefined) {
    try {
      jobs = jobChecks(await t.github.workflowFiles(repo, sha));
      const h: { reruns: Reruns; jobs?: string[] } = t.nextLabels.heads.get(key) ?? { reruns: new Map() };
      h.jobs = jobs;
      t.nextLabels.heads.set(key, h);
    } catch (error) {
      t.warnHourly([`train: the tree's workflows not read at ${repo}@${sha}`], (error as Error).message, `train: the tree's workflows not read at ${repo}@${sha}: ${(error as Error).message}`);
      return [];
    }
  }
  return wanted.filter((n) => !defined(jobs!, n));
}

/** How the label is on PR `n`, which `has` it or not, as far as the train knows, putting nothing on. */
export function labelled(t: Train, repo: string, n: number, has: boolean): Labelled {
  if (!has) return { kind: "failed" };
  const at = t.nextLabels.labelled.get(repo)?.get(n);
  return at === undefined ? { kind: "before" } : { kind: "at", at };
}

/**
 * Re-runs each job of `cancelled` on its own, `most` times at most each. GitHub refusing, it asks again after
 * `RERUN_BACKOFF_MS`, doubled each time, and after `RERUN_TRIES` refusals stops asking.
 */
export async function rerunJobs(t: Train, repo: string, cancelled: CheckRun[], runs: CheckRun[], reruns: Reruns, most: number): Promise<Reran> {
  const now = t.nowMs();
  const busy = new Set(runs.filter((r) => r.status !== "completed").map(workflowRun).filter((w): w is number => w !== undefined));
  const out = noRerun();
  for (const r of cancelled) {
    const run = workflowRun(r);
    const job = jobOf(r);
    if (run === undefined || job === undefined) {
      out.unknown = true;
      continue;
    }
    const key = rerunKey(run, r.name);
    const rerun = reruns.get(key) ?? { times: 0, seen: 0, refused: 0, at: 0 };
    reruns.set(key, rerun);
    if (rerun.times > 0 && r.id <= rerun.seen) out.pending = true;
    else if (rerun.times >= most) out.spent = true;
    else if (rerun.refused >= RERUN_TRIES) out.gaveUp = true;
    else if (now < rerun.at) out.refused = true;
    else if (busy.has(run)) out.busy = true;
    else {
      try {
        await t.github.rerunJob(repo, job);
        console.info(`train: re-ran a cancelled job: ${repo} run ${run} job ${job} (${r.name})`);
        reruns.set(key, { times: rerun.times + 1, seen: r.id, refused: 0, at: 0 });
        busy.add(run);
        out.now = true;
      } catch (error) {
        rerun.refused += 1;
        rerun.at = now + RERUN_BACKOFF_MS * 2 ** (rerun.refused - 1);
        t.warnHourly([`train: cancelled job not re-run (${repo} job ${job}, try ${rerun.refused})`], (error as Error).message, `train: cancelled job not re-run (${repo} job ${job}, try ${rerun.refused}): ${(error as Error).message}`);
        if (rerun.refused >= RERUN_TRIES) out.gaveUp = true;
        else out.refused = true;
      }
    }
  }
  return out;
}

/**
 * A cancelled check the batch skips, or a cancelled job one of them needs, on head `sha`: re-run once, and said.
 * Undefined when none is cancelled.
 */
export async function rerunCancelledSkips(t: Train, repo: string, sha: string, runs: CheckRun[], batch: BatchSkip[]): Promise<string | undefined> {
  const watched = (name: string) => batch.some((b) => gatedName(b.name, name) || b.needs.some((n) => gatedName(n, name)));
  const cancelled = runs.filter((r) => r.conclusion === "cancelled" && watched(r.name));
  if (cancelled.length === 0) return undefined;
  const key = key2(repo, sha);
  const names = cancelled.map((r) => `\`${r.name}\``).join(", ");
  const head = t.nextLabels.heads.get(key) ?? { reruns: new Map() };
  t.nextLabels.heads.set(key, head);
  const r = await rerunJobs(t, repo, cancelled, runs, head.reruns, 1);
  if (r.gaveUp) return `its own head's ${names} was cancelled, and GitHub refused to re-run it ${RERUN_TRIES} times: push again or re-run it`;
  if (r.spent) return `its own head's ${names} was cancelled again after the train re-ran it: push again or re-run it`;
  if (r.now || r.pending) return `its own head's ${names} was cancelled; the train re-ran it`;
  if (r.busy) return `its own head's ${names} was cancelled; the train re-runs it once its workflow run is done`;
  if (r.refused) return `its own head's ${names} was cancelled, and GitHub refused to re-run it: the train asks again`;
  return `its own head's ${names} was cancelled, and the train could not re-run it`;
}

/** Forgets what it knew of the heads of `repo` no longer in its line, nor in the train's hands. */
export function pruneHeads(t: Train, repo: string): void {
  const line = new Set(t.records.inTrain(repo, [...QUEUED_STATES, ...HEAD_STATES]).map((c) => c.headSha));
  for (const k of [...t.nextLabels.heads.keys()]) {
    const [r, sha] = k.split("\u0000") as [string, string];
    if (r === repo && !line.has(sha)) t.nextLabels.heads.delete(k);
  }
}

/** Puts the label on PR `n` unless it `has` it. */
export async function label(t: Train, repo: string, n: number, has: boolean): Promise<Labelled> {
  if (!(await labelsKnown(t, repo))) return { kind: "failed" };
  const prs = t.nextLabels.prs(repo);
  if (has) {
    if (!prs.has(n)) prs.set(n, undefined);
    const at = prs.get(n);
    return at === undefined ? { kind: "before" } : { kind: "at", at };
  }
  try {
    await t.github.addLabel(repo, n, NEXT_LABEL);
    labelWorked(t, repo);
    const at = t.nowMs();
    prs.set(n, at);
    return { kind: "at", at };
  } catch (error) {
    labelFailed(t, repo, (error as Error).message);
    return { kind: "failed" };
  }
}

/** The label on each of `wanted` (number, has it), in line order, and off every other PR that carries it but `kept`. */
export async function relabel(t: Train, repo: string, wanted: [number, boolean][], kept: number[]): Promise<void> {
  if (!(await labelsKnown(t, repo))) return;
  for (const [n, has] of wanted) await label(t, repo, n, has);
  const stale = [...(t.nextLabels.labelled.get(repo)?.keys() ?? [])].filter((n) => !kept.includes(n) && !wanted.some(([w]) => w === n));
  for (const n of stale) {
    try {
      await t.github.removeLabel(repo, n, NEXT_LABEL);
      labelWorked(t, repo);
      t.nextLabels.labelled.get(repo)?.delete(n);
    } catch (error) {
      labelFailed(t, repo, (error as Error).message);
    }
  }
}

/**
 * `note` (`waiting for CI runners (N queued)`, or for GitHub's rate limit to reset) on each of `changes` still in CI;
 * undefined takes it off.
 */
export function runnerNote(t: Train, changes: string[], note: string | undefined, earlier: Map<string, string | undefined>): void {
  for (const id of changes) {
    const change = t.records.get(id);
    if (!change) continue;
    const shown = change.lastError;
    const ours = (shown?.startsWith(WAITING_FOR_RUNNERS) || shown?.startsWith(WAITING_FOR_LIMIT)) ?? false;
    let next: string | undefined;
    if (note !== undefined) next = note;
    else if (ours) {
      next = earlier.get(id);
      earlier.delete(id);
    } else continue;
    if (shown === next) continue;
    if (note !== undefined && !ours) earlier.set(id, shown);
    const state = note !== undefined ? "ci" : change.state;
    t.update(id, [state], (c) => {
      const { lastError: _, ...rest } = c;
      return next === undefined ? rest : { ...rest, lastError: errorText(next) };
    });
  }
}

/** The first of the Change's `after` PRs that hasn't merged; undefined once they all have. */
export async function waitingOn(t: Train, change: Change): Promise<Waiting | undefined> {
  for (const url of change.after ?? []) {
    const w = await upstream(t, url);
    if (w) return w;
  }
  return undefined;
}

/** Where the upstream PR stands: undefined once it merged. Its Change on the train says, else GitHub. */
export async function upstream(t: Train, url: string): Promise<Waiting | undefined> {
  const p = parsePrUrl(url);
  if (!p) return undefined;
  const repo = p.repo.toLowerCase();
  const n = p.number;
  const latest = t.records.latestFor(repo, n);
  let why: string;
  let failed: boolean;
  const s = latest?.state;
  if (s === "merged") return undefined;
  if (s === "ci_failed" && timedOut(latest!)) [why, failed] = ["its CI ran past the timeout", false];
  else if (s === "ci_failed") [why, failed] = ["its CI failed", true];
  else if (s === "needs_rebase") [why, failed] = ["it conflicts with its base and is back with its writer", false];
  else if (s === "reviewing" && latest!.lastError?.startsWith(BLOCKED_PREFIX)) [why, failed] = ["its review found blocking issues", true];
  else if (s === "refused" || s === "abandoned" || s === undefined) {
    const read = await upstreamPull(t, url, repo, n);
    if (read.kind === "merged") return undefined;
    if (read.kind === "closed") [why, failed] = ["it was closed without merging", true];
    else if (read.kind === "open") {
      if (s === "refused") [why, failed] = ["the train refused it", true];
      else if (s !== undefined) [why, failed] = ["it left the train unmerged", true];
      else [why, failed] = ["it is not on the train yet", false];
    } else [why, failed] = [`it could not be read: GitHub: ${read.message}`, false];
  } else [why, failed] = ["it hasn't merged yet", false];
  return { note: `${WAITING_ON}${repo}#${n}: ${why}`, failed };
}

/** The upstream PR as GitHub has it, read at most every `UPSTREAM_TTL_MS`. */
async function upstreamPull(t: Train, url: string, repo: string, n: number): Promise<UpstreamPull> {
  const now = t.nowMs();
  const known = t.upstreamReads.get(url);
  if (known && now - known[0] < UPSTREAM_TTL_MS) return known[1];
  let read: UpstreamPull;
  try {
    const pull = await t.github.pull(repo, n);
    read = pull.merged ? { kind: "merged" } : pull.state !== "open" ? { kind: "closed" } : { kind: "open" };
  } catch (error) {
    read = { kind: "unread", message: (error as Error).message };
  }
  for (const [k, [at]] of t.upstreamReads) if (now - at >= UPSTREAM_TTL_MS) t.upstreamReads.delete(k);
  t.upstreamReads.set(url, [now, read]);
  return read;
}

/** Each pass: the lead hears once of each upstream failure that holds one of the repo's Changes in line. */
export async function afterPass(t: Train, repo: string): Promise<void> {
  for (const change of t.records.inTrain(repo, QUEUED_STATES)) {
    if ((change.after ?? []).length === 0) continue;
    const waiting = await waitingOn(t, change);
    if (!waiting?.failed) continue;
    const key = `${change.changeId}\u0000${waiting.note}`;
    if (t.afterTold.has(key)) continue;
    t.afterTold.add(key);
    const why = waiting.note.startsWith("held: ") ? waiting.note.slice(6) : waiting.note;
    const text = `held, ${why}. It merges only after that PR does: get it fixed and back on the train, or close this one.`;
    await t.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
  }
}

/**
 * The Change with the open PRs its PR `pull` is stacked on in its `after`: each PR of this repo from a writer's
 * branch (under the project's branch prefix, never the train's own) whose head is among its commits since the default
 * branch.
 */
export async function stack(t: Train, change: Change, pull: Pull): Promise<Change> {
  const repo = change.repo;
  const head = pull.head.sha.toLowerCase();
  const prefix = await t.host.branchPrefix(change.projectRef);
  if (prefix === undefined) return change;
  const scratch = `${prefix}train/`;
  const open = await t.github.openPulls(repo);
  const writers = open
    .filter((o) => o.number !== change.prNumber)
    .filter((o) => o.head.sha.toLowerCase() !== head)
    .filter((o) => o.head.repo?.full_name.toLowerCase() === repo.toLowerCase())
    .filter((o) => o.head.ref.startsWith(prefix) && !o.head.ref.startsWith(scratch));
  if (writers.length === 0) return change;
  const base = await defaultBase(t, repo);
  // GitHub lists at most 250 commits: past that none counts.
  const commits = (await t.github.range(repo, base, head))?.commits ?? [];
  const under: string[] = [];
  for (const other of writers) {
    const url = `https://github.com/${repo}/pull/${other.number}`;
    if (
      other.head.ref !== base &&
      commits.includes(other.head.sha.toLowerCase()) &&
      !(change.after ?? []).includes(url) &&
      loopsBack(t, change.prUrl, [url]) === undefined
    ) {
      console.info(`train: ${change.changeId} stacked on another open PR ${url}`);
      under.push(url);
    }
  }
  return addAfter(t, change, under);
}

/** A Change whose PR is based on a branch that already landed: its PR is pointed at that PR's base. Whether it was. */
export async function restack(t: Train, change: Change, pull: Pull): Promise<boolean> {
  const repo = change.repo;
  const base = pull.base.ref;
  if (base === (await defaultBase(t, repo))) return false;
  const closed = await t.github.pullsFor(repo, base, "closed");
  const landed = closed[0];
  if (!landed || !(landed.merged_at != null || t.records.latestFor(repo, landed.number)?.state === "merged")) return false;
  const url = `https://github.com/${repo}/pull/${landed.number}`;
  const prefix = await t.host.branchPrefix(change.projectRef);
  if (!(change.after ?? []).includes(url) && !(prefix !== undefined && landed.head.ref.startsWith(prefix))) return false;
  const tip = await t.github.branchSha(repo, base);
  if (tip.toLowerCase() !== landed.head.sha.toLowerCase()) return false;
  const onto = landed.base.ref;
  await t.github.editPull(repo, change.prNumber, [["base", onto]]);
  console.info(`train: ${change.changeId}'s PR on a landed branch ${base} pointed at its base ${onto}`);
  t.update(change.changeId, ["ready"], (c) => ({ ...c, lastError: errorText(`its base ${base} landed in #${landed.number}, so it now goes into ${onto}`) }));
  return true;
}

/** The repo's default branch, read once. */
export async function defaultBase(t: Train, repo: string): Promise<string> {
  const known = t.sync.base(repo);
  if (known !== undefined) return known;
  const base = await t.github.defaultBranch(repo);
  t.sync.setBase(repo, base);
  return base;
}

/** The PRs it waits on, now also `after`'s. */
export function addAfter(t: Train, change: Change, after: string[]): Change {
  if (after.every((u) => (change.after ?? []).includes(u))) return change;
  return t.update(change.changeId, undefined, (c) => ({ ...c, after: mergeAfter(c.after, after) })) ?? change;
}

/** The upstream PR in `after` that already waits, through its own `after`, on `prUrl`. */
export function loopsBack(t: Train, prUrl: string, after: string[]): string | undefined {
  return loopsBackVia(prUrl, after, (repo, number) => t.records.openFor(repo, number)?.after);
}

export { GhError };
