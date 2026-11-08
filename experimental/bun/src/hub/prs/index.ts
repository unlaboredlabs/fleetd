// The PR views (crates/fleetd/src/hub/prs/mod.rs): a project's PRs (`pr_list`) and one PR in detail (`pr_get`,
// `pr_files`, `pr_diff`). Joins the merge queue's Changes, the review gate's verdicts and the task that wrote each PR
// with what GitHub says, read through `PrsGitHub`'s short cache. Read-only; owns no table and runs no loop.
import type { Change, ChangeState, PrQueueStep, PrReviewEntry, ProjectRef, Task } from "../../shared/contracts.ts";
import { redact } from "../../shared/redact.ts";
import type { Hub } from "../api/hub.ts";
import { AppGh } from "../github_app/gh.ts";
import { githubApps } from "../github_app/index.ts";
import { prKey, type ReviewVerdict } from "../reviews/verdicts.ts";
import { ChangeRecords } from "../train/records.ts";
import { clip, isoMs, tasks } from "../train/seams.ts";
import { type GhReview, PrsGitHub } from "./github.ts";
import { agentOf, normalizeIso, roleOf, type RowCtx } from "./join.ts";

/** Tasks read per project to name PR writers and reviewers. */
const PROJECT_TASKS = 500;
/** Changes read per project. */
const PROJECT_CHANGES = 200;
/** Agent verdicts read per PR. */
const PR_VERDICTS = 30;
/** Queue moves read per PR. */
const PR_HISTORY = 30;

/** The PR views' GitHub reads, through the hub's `gh` (as the App where it reaches). */
export const prsGithub = (hub: Hub): PrsGitHub => hub.area("prs", (h) => new PrsGitHub(new AppGh(githubApps(h)), h.clock));

/** The repos a project lands PRs on: those whose merge queue it owns, and those of its Changes. */
export function projectRepos(hub: Hub, project: ProjectRef, changes: Change[]): string[] {
  const records = new ChangeRecords(hub.db);
  const seen = new Set<string>();
  const out: string[] = [];
  const owned = records
    .trains()
    .filter((t) => t.projectRef.machineId === project.machineId && t.projectRef.projectId === project.projectId)
    .map((t) => t.repo);
  for (const repo of [...owned, ...changes.map((c) => c.repo)]) {
    const k = repo.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(repo);
    }
  }
  return out;
}

/** The project a repo's PRs belong to: the one owning its merge queue, else the newest Change's. */
export function ownerOf(hub: Hub, repo: string): ProjectRef | undefined {
  const records = new ChangeRecords(hub.db);
  return records.train(repo)?.projectRef ?? records.list({ repo, limit: 1 })[0]?.projectRef;
}

export function projectTasks(hub: Hub, project: ProjectRef): Task[] {
  try {
    return tasks(hub.db.conn, { projectRef: project, limit: PROJECT_TASKS });
  } catch (error) {
    console.warn(`prs: tasks not read: ${error}`);
    return [];
  }
}

export function projectChanges(hub: Hub, project: ProjectRef): Change[] {
  const records = new ChangeRecords(hub.db);
  return records.positioned(records.list({ projectRef: project, limit: PROJECT_CHANGES }));
}

/** The hub's side of the join: each repo's queue. */
export function fillCtx(hub: Hub, ctx: RowCtx, repos: string[]): void {
  const records = new ChangeRecords(hub.db);
  for (const repo of repos) ctx.queues.set(repo.toLowerCase(), records.trainState(repo).queue.length);
}

/** Agent verdicts on the PR, newest first: task id, head sha, at, verdict. */
export function verdicts(hub: Hub, prUrl: string): { taskId: string; sha: string; at: string; verdict: ReviewVerdict }[] {
  let rows: { task_id: string; sha: string; at_ms: number; data: string }[];
  try {
    rows = hub.db.conn
      .query<{ task_id: string; sha: string; at_ms: number; data: string }, [string, number]>(
        "SELECT task_id, sha, at_ms, data FROM review_verdicts WHERE pr_key = ?1 ORDER BY n DESC LIMIT ?2",
      )
      .all(prKey(prUrl), PR_VERDICTS);
  } catch (error) {
    console.warn(`prs: verdicts not read: ${error}`);
    return [];
  }
  return rows.flatMap((r) => {
    try {
      return [{ taskId: r.task_id, sha: r.sha, at: isoMs(r.at_ms), verdict: JSON.parse(r.data) as ReviewVerdict }];
    } catch {
      return [];
    }
  });
}

/** An agent verdict as a review entry. `current`: it reviewed the PR's current change. */
export function agentReview(verdict: ReviewVerdict, at: string, reviewer: Task | undefined, current: boolean): PrReviewEntry {
  return {
    verdict: verdict.blocking > 0 ? "changes_requested" : "approved",
    ...(reviewer ? { agent: agentOf(reviewer, roleOf(reviewer)) } : {}),
    blocking: verdict.blocking,
    nonBlocking: verdict.nonBlocking,
    text: clip(redact(verdict.summary), 2000),
    current,
    at,
  };
}

/** A person's review on GitHub as a review entry; undefined for a pending (unsubmitted) one. */
export function personReview(r: GhReview, head: string): PrReviewEntry | undefined {
  const verdict = (
    { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed" } as const
  )[r.state.toUpperCase() as "APPROVED"];
  if (verdict === undefined) return undefined;
  const login = r.author ? clip(r.author.login, 100) : "";
  return {
    verdict,
    ...(login.trim() !== "" ? { login } : {}),
    text: clip(redact(r.body), 2000),
    current: r.commit?.oid === head,
    at: normalizeIso(r.submittedAt ?? ""),
  };
}

/** The PR's moves through the merge queue, newest first, from the `change.state` events of its Changes. */
export function history(hub: Hub, changeIds: string[]): PrQueueStep[] {
  const out: PrQueueStep[] = [];
  for (const id of changeIds) {
    let rows: { data: string }[] = [];
    try {
      rows = hub.db.conn
        .query<{ data: string }, [string, number]>(
          `SELECT data FROM events WHERE type = 'change.state'
             AND json_extract(data, '$.data.changeId') = ?1 ORDER BY seq DESC LIMIT ?2`,
        )
        .all(id, PR_HISTORY);
    } catch {}
    for (const row of rows) {
      try {
        const e = JSON.parse(row.data) as { at?: string; data?: { from?: ChangeState; to?: ChangeState } };
        if (typeof e.at === "string" && e.data?.from && e.data.to) out.push({ at: e.at, from: e.data.from, to: e.data.to });
      } catch {}
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, PR_HISTORY);
}

/** Changes of one PR, newest first. */
export function prChanges(hub: Hub, repo: string, number: number): Change[] {
  const records = new ChangeRecords(hub.db);
  return records.positioned(records.list({ repo, limit: PROJECT_CHANGES }).filter((c) => c.prNumber === number));
}

export const count = (n: number) => Math.max(n, 0);
