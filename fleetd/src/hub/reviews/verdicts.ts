// Review verdicts (crates/fleetd/src/hub/reviews/verdicts.rs, checks/tools.rs): `fleetd review verdict` (the lead
// call `review_verdict`) records one per review task and head SHA, keyed by its PR too. The train's review gate reads
// them by task and head, the PR view by PR.
import type { ProjectRef, Task } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { emit, task as readTask } from "../train/seams.ts";

/** A review task's verdict (contracts `verification::ReviewVerdict`, Rust-only). */
export type ReviewVerdict = {
  taskId?: string;
  prHeadSha?: string;
  blocking: number;
  nonBlocking: number;
  summary: string;
};

/** Who is recording: the lead's project and its `by`, and the task when the call comes from a task's session. */
export type VerdictCaller = { projectRef: ProjectRef; by: string; task?: string };

/** The head a review task reviewed when it didn't say (checks/hub_ports.rs `reviewed_head`). */
export type ReviewedHead = (task: Task) => Promise<string | undefined>;

/** Set by the reviews area: its round's head, else the PR's head now. */
export const reviewedHeads = (hub: Hub) => hub.area<{ of?: ReviewedHead }>("reviewed_head", () => ({}));

/** One key per PR however its URL is written: host and path, lowercased, `/pulls/` as `/pull/`, no trailing slash. */
export function prKey(url: string): string {
  const trimmed = url.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  if (u.host === "") return trimmed.toLowerCase();
  return `${u.host}${u.pathname}`.toLowerCase().replace("/pulls/", "/pull/").replace(/\/+$/, "");
}

const SHA = /^[0-9a-f]{40}$/;

/** The verdict's fields as the contract checks them; refused as `invalid` otherwise. */
export function readVerdict(raw: Record<string, unknown>): ReviewVerdict {
  const count = (k: string) => {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ToolError("invalid", `${k}: expected a count`);
    return v;
  };
  const summary = raw.summary;
  if (typeof summary !== "string" || [...summary].length < 1 || [...summary].length > 4000) {
    throw new ToolError("invalid", "summary: expected text of 1 to 4000 characters");
  }
  const out: ReviewVerdict = { blocking: count("blocking"), nonBlocking: count("nonBlocking"), summary };
  if (raw.taskId != null) {
    if (typeof raw.taskId !== "string" || !/^T[1-9]\d*$/.test(raw.taskId)) throw new ToolError("invalid", "taskId: expected a task id");
    out.taskId = raw.taskId;
  }
  if (raw.prHeadSha != null) {
    if (typeof raw.prHeadSha !== "string" || !SHA.test(raw.prHeadSha)) {
      throw new ToolError("invalid", "prHeadSha: expected a full lowercase commit SHA");
    }
    out.prHeadSha = raw.prHeadSha;
  }
  return out;
}

/** In the Rust struct's field order, its absent fields left out. */
const encode = (v: ReviewVerdict) =>
  JSON.stringify({
    ...(v.taskId !== undefined ? { taskId: v.taskId } : {}),
    ...(v.prHeadSha !== undefined ? { prHeadSha: v.prHeadSha } : {}),
    blocking: v.blocking,
    nonBlocking: v.nonBlocking,
    summary: v.summary,
  });

/** Stores the verdict against its task and head and emits `review.verdict`. */
export async function record(hub: Hub, caller: VerdictCaller, input: ReviewVerdict): Promise<ReviewVerdict> {
  const verdict = { ...input };
  const named = verdict.taskId;
  delete verdict.taskId;
  let taskId: string;
  if (caller.task !== undefined && named !== undefined && caller.task !== named) {
    throw new ToolError("invalid", `You are ${caller.task}, so you record only your own verdict, not ${named}'s.`, "Leave out taskId.");
  } else if (caller.task !== undefined) {
    taskId = caller.task;
  } else if (named !== undefined) {
    taskId = named;
  } else {
    throw new ToolError("invalid", "Name the review task whose verdict this is.", "Pass taskId.");
  }
  const task = readTask(hub.db.conn, taskId);
  if (!task || task.projectRef.machineId !== caller.projectRef.machineId || task.projectRef.projectId !== caller.projectRef.projectId) {
    throw new ToolError("not_found", `No task ${taskId} in this project.`, "Pass taskId with a review task of your project.");
  }
  const recorded: ReviewVerdict = { taskId, ...verdict };
  if (task.kind !== "review") throw new ToolError("invalid", `${task.taskId} is a ${task.kind} task; only review tasks record verdicts.`);
  if (recorded.prHeadSha === undefined) {
    const head = await reviewedHeads(hub).of?.(task);
    if (head !== undefined) recorded.prHeadSha = head;
  }
  const sha = recorded.prHeadSha ?? "";
  const now = hub.clock.now();
  hub.db.conn
    .query("INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(task.taskId, task.pr === undefined ? null : prKey(task.pr), sha, recorded.blocking, now, encode(recorded));
  const data: Record<string, unknown> = {
    taskId: task.taskId,
    workstreamId: task.workstreamId,
    prHeadSha: recorded.prHeadSha ?? null,
    blocking: recorded.blocking,
    nonBlocking: recorded.nonBlocking,
  };
  if (task.pr !== undefined) data.pr = task.pr;
  const at = sha.length >= 12 ? ` at ${sha.slice(0, 12)}` : "";
  emit(
    hub,
    task.projectRef,
    "review.verdict",
    `${task.taskId} review verdict${at}: ${recorded.blocking} blocking, ${recorded.nonBlocking} non-blocking`,
    data,
    task.threadRef?.threadId,
  );
  return recorded;
}

/** Lead call `review_verdict`: records it and says how the reviewer ends. */
export async function leadReviewVerdict(hub: Hub, caller: VerdictCaller, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const verdict = await record(hub, caller, readVerdict(raw));
  const next =
    verdict.blocking === 0
      ? "end with your one-paragraph result and stop; this commit will not be reviewed again."
      : "end with your one-paragraph result listing each blocking finding, then stop; the lead gets it.";
  return { verdict, next };
}
