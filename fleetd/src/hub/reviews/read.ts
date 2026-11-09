// `review_read` (crates/fleetd/src/hub/reviews/read.rs): an author reads every finding of its PRs' latest reviews,
// whole, and of any other PR of its project it names (one it builds on), a reviewer those of the one PR it reviews, and
// a lead its project's. Read-only; another project's PR is refused, and so is any PR but its own for a reviewer.
import type { Task } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { redact } from "../../shared/redact.ts";
import type { Hub } from "../api/hub.ts";
import type { LeadCaller } from "../lead_calls/index.ts";
import type { HubDb } from "../store/db.ts";
import { projectChanges, projectTasks } from "../prs/index.ts";
import { clip, isoMs, task as readTask } from "../train/seams.ts";
import { prKey, type ReviewVerdict } from "./verdicts.ts";

const short = (sha: string) => sha.slice(0, 12);

/** One review task's newest verdict on the newest head reviewed (contracts `ReviewFindings`). */
export type ReviewFindings = {
  taskId: string;
  prHeadSha?: string;
  blocking: number;
  nonBlocking: number;
  findings: string;
  at: string;
};

export function reviewRead(hub: Hub, caller: LeadCaller, call: { pr?: unknown }): { prs: { pr: string; reviews: ReviewFindings[] }[]; next?: string } {
  const task = caller.agent.kind === "task" ? caller.agent.taskId : undefined;
  const picked = typeof call.pr === "string" ? call.pr.trim() : undefined;
  const { prs: mine, reviewer } = callerPrs(hub, caller, task, picked !== undefined);
  let prs = mine;
  if (picked !== undefined) {
    prs = mine.filter((pr) => names(picked, pr));
    if (prs.length === 0) {
      const whose = task !== undefined && reviewer ? `${task}'s` : "this project's";
      throw new ToolError(
        "forbidden",
        `PR ${picked} is not one of ${whose} PRs; another project's reviews are not yours to read.`,
        "Leave out pr to list the PRs you can read.",
      );
    }
  }
  const out: { prs: { pr: string; reviews: ReviewFindings[] }[]; next?: string } = {
    prs: prs.map((pr) => ({ pr, reviews: latest(hub.db, pr) })),
  };
  if (prs.length === 0) {
    out.next =
      task !== undefined
        ? "You have no PR yet: open it and the train reviews it."
        : "No PR of this project is in the merge queue: pass pr to read an earlier one.";
  }
  return out;
}

/**
 * The caller's PRs, newest first, and whether it is a reviewer: a task's own, a review task's one PR, a lead's
 * project's in the merge queue. With `all`, a lead and an author get every PR the project knows too, after an author's
 * own; a reviewer still gets only the PR it reviews.
 */
function callerPrs(hub: Hub, caller: LeadCaller, task: string | undefined, all: boolean): { prs: string[]; reviewer: boolean } {
  const project = caller.projectRef;
  const changes = projectChanges(hub, project);
  const prs: string[] = [];
  if (task !== undefined) {
    const own = readTask<Task>(hub.db.conn, task);
    if (!own || own.projectRef.machineId !== project.machineId || own.projectRef.projectId !== project.projectId) {
      throw new ToolError("not_found", `No task ${task} in this project.`);
    }
    // A reviewer reads the earlier reviews of the one PR it reviews, and no other PR's.
    if (own.kind === "review") return { prs: own.pr !== undefined ? [own.pr] : [], reviewer: true };
    prs.push(...changes.filter((c) => c.taskId === task).map((c) => c.prUrl));
    if (own.pr !== undefined) prs.push(own.pr);
  } else if (!all) {
    const queued = (s: string) => s !== "merged" && s !== "refused" && s !== "abandoned";
    prs.push(...changes.filter((c) => queued(c.state)).map((c) => c.prUrl));
  }
  // A PR named, the lead and an author may read any of the project's: an author the one it is stacked on, say.
  if (all) {
    prs.push(...changes.map((c) => c.prUrl));
    for (const t of projectTasks(hub, project)) if (t.pr !== undefined) prs.push(t.pr);
  }
  const seen = new Set<string>();
  const unique = prs.filter((pr) => {
    const k = prKey(pr);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { prs: unique, reviewer: false };
}

/** Whether `wanted`, a PR's URL or its number (`#7`, `7`), names `pr`. */
function names(wanted: string, pr: string): boolean {
  const key = prKey(pr);
  const n = wanted.replace(/^#+/, "");
  return /^\d+$/.test(n) ? key.endsWith(`/pull/${BigInt(n)}`) : key === prKey(wanted);
}

/**
 * The PR's still-open blocking findings, for a message about it: each blocking verdict of its latest review, under its
 * reviewer and head. Empty when its latest review blocks nothing.
 */
export function openBlocking(db: HubDb, pr: string): string {
  const closed = (task: string) => {
    try {
      return db.conn.query("SELECT 1 FROM review_tasks WHERE task_id = ?1 AND role IN ('resolved', 'superseded')").get(task) !== null;
    } catch {
      return false;
    }
  };
  const open = latest(db, pr)
    .filter((r) => r.blocking > 0 && !closed(r.taskId))
    .map((r) => `${r.taskId} at ${short(r.prHeadSha ?? "")} (${r.blocking} blocking, ${r.nonBlocking} non-blocking):\n${r.findings}`);
  if (open.length === 0) return "";
  return (
    "Its latest review's blocking findings are still open: fix them too, unless your head already does " +
    `(\`review_read\` reads them whole).\n\n${open.join("\n\n")}`
  );
}

/** The PR's latest reviews: each review task's newest verdict on the newest head reviewed, newest first. */
export function latest(db: HubDb, pr: string): ReviewFindings[] {
  let rows: { task_id: string; sha: string; at_ms: number; data: string }[];
  try {
    rows = db.conn
      .query<{ task_id: string; sha: string; at_ms: number; data: string }, [string]>(
        "SELECT task_id, sha, at_ms, data FROM review_verdicts WHERE pr_key = ?1 ORDER BY n DESC",
      )
      .all(prKey(pr));
  } catch (error) {
    console.warn(`review_read: verdicts not read: ${error}`);
    return [];
  }
  const head = rows[0]?.sha;
  if (head === undefined) return [];
  const seen = new Set<string>();
  const out: ReviewFindings[] = [];
  for (const r of rows) {
    if (r.sha !== head || seen.has(r.task_id)) continue;
    seen.add(r.task_id);
    let v: ReviewVerdict;
    try {
      v = JSON.parse(r.data) as ReviewVerdict;
    } catch {
      continue;
    }
    out.push({
      taskId: r.task_id,
      ...(v.prHeadSha !== undefined ? { prHeadSha: v.prHeadSha } : {}),
      blocking: v.blocking,
      nonBlocking: v.nonBlocking,
      findings: clip(redact(v.summary), 4000),
      at: isoMs(r.at_ms),
    });
  }
  return out;
}
