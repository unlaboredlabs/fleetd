// The in-flight view, as a pure function of what the hub holds: write tasks,
// Changes and claims become one list of `WorkItem`s. A writer appears once: its Change takes over when its PR is enqueued.
import type { Change, ChangeState, Claim, Task, TaskId, TaskState, WorkItem, WorkKey } from "../../shared/contracts.ts";

/** Task states that are work in flight. */
export const LIVE_TASK_STATES: readonly TaskState[] = ["queued", "running", "idle"];
/** Change states no longer in flight: merged work is a landing, abandoned work is gone. A refused Change stays. */
export const ENDED_CHANGE_STATES: readonly ChangeState[] = ["merged", "abandoned"];

/** What the view is built from, already narrowed to one scope. */
export type Sources = {
  /** The scope's projects' tasks; only live write tasks become items. */
  tasks: Task[];
  /** The scope's projects' Changes on the scope's repo. */
  changes: Change[];
  /** The tasks the Changes were opened by, when they are not in `tasks`. */
  changeTasks: Task[];
  claims: Claim[];
  /** What each writer has changed so far, by task. */
  observed: Map<TaskId, string[]>;
};

export const emptySources = (): Sources => ({ tasks: [], changes: [], changeTasks: [], claims: [], observed: new Map() });

/** A `WorkPath`: one line of 1 to 500 UTF-16 units. */
export const isWorkPath = (p: string) => p.length >= 1 && p.length <= 500 && !/[\r\n]/.test(p);
/** A `Line<1, N>`. */
export const isLine = (s: string, max: number) => s.length >= 1 && s.length <= max && !/[\r\n]/.test(s);

function pathsOf(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (isWorkPath(p)) out.push(p);
  }
  return out;
}

export const keyEquals = (a: WorkKey, b: WorkKey) =>
  ("issue" in a && "issue" in b && a.issue === b.issue) ||
  ("pr" in a && "pr" in b && a.pr === b.pr) ||
  ("branch" in a && "branch" in b && a.branch === b.branch);

function pushKey(keys: WorkKey[], key: WorkKey): void {
  if (!keys.some((k) => keyEquals(k, key))) keys.push(key);
}

const branchKey = (branch: string | undefined): WorkKey | undefined => (branch !== undefined && isLine(branch, 250) ? { branch } : undefined);

function taskKeys(task: Task): WorkKey[] {
  const keys: WorkKey[] = [];
  const branch = branchKey(task.branch);
  if (branch) pushKey(keys, branch);
  // A writer spawned for a PR (to finish or fix it) holds that PR as much as one that opened it.
  if (task.pr !== undefined) pushKey(keys, { pr: task.pr });
  if (task.result?.prUrl !== undefined) pushKey(keys, { pr: task.result.prUrl });
  return keys;
}

function taskItem(task: Task, observed: Map<TaskId, string[]>): WorkItem {
  return {
    id: task.taskId,
    kind: "task",
    projectRef: task.projectRef,
    title: task.title,
    state: task.state,
    keys: taskKeys(task),
    paths: pathsOf([...(task.paths ?? []), ...(observed.get(task.taskId) ?? [])]),
    taskId: task.taskId,
    since: task.createdAt,
  };
}

function changeItem(change: Change, task: Task | undefined, observed: Map<TaskId, string[]>): WorkItem {
  const keys: WorkKey[] = [{ pr: change.prUrl }];
  const branch = branchKey(change.branch);
  if (branch) pushKey(keys, branch);
  const title = task ? task.title : `#${change.prNumber} ${change.branch}`;
  return {
    id: change.changeId,
    kind: "change",
    projectRef: change.projectRef,
    title: isLine(title, 120) ? title : change.changeId,
    state: change.state,
    keys,
    paths: pathsOf(change.taskId !== undefined ? (observed.get(change.taskId) ?? []) : []),
    ...(change.taskId !== undefined ? { taskId: change.taskId } : {}),
    changeId: change.changeId,
    since: change.createdAt,
  };
}

export function claimItem(claim: Claim): WorkItem {
  const keys = [...claim.keys];
  if (claim.branch !== undefined) pushKey(keys, { branch: claim.branch });
  return {
    id: claim.claimId,
    kind: "claim",
    ...(claim.projectRef ? { projectRef: claim.projectRef } : {}),
    owner: claim.owner,
    title: claim.title,
    state: claim.state,
    keys,
    paths: pathsOf([...claim.paths, ...(claim.observed?.paths ?? [])]),
    claimId: claim.claimId,
    since: claim.renewedAt,
    expiresAt: claim.expiresAt,
  };
}

const expired = (i: WorkItem) => i.kind === "claim" && i.state === "expired";

/** Every live item, newest first; expired claims (still shown, as weak) come last. */
export function items(sources: Sources): WorkItem[] {
  const liveChanges = sources.changes.filter((c) => !ENDED_CHANGE_STATES.includes(c.state));
  const takenOver = new Set(liveChanges.flatMap((c) => (c.taskId !== undefined ? [c.taskId] : [])));
  const taskOf = new Map<TaskId, Task>();
  for (const t of [...sources.tasks, ...sources.changeTasks]) taskOf.set(t.taskId, t);
  const out: WorkItem[] = sources.tasks
    .filter((t) => t.kind === "write" && LIVE_TASK_STATES.includes(t.state) && !takenOver.has(t.taskId))
    .map((t) => taskItem(t, sources.observed));
  out.push(...liveChanges.map((c) => changeItem(c, c.taskId !== undefined ? taskOf.get(c.taskId) : undefined, sources.observed)));
  out.push(...sources.claims.filter((c) => c.state === "active" || c.state === "expired").map(claimItem));
  // Timestamps are all the hub's own ISO form, so they sort as text. The sort is stable, as Rust's sort_by.
  return out.sort((a, b) => Number(expired(a)) - Number(expired(b)) || (b.since < a.since ? -1 : b.since > a.since ? 1 : 0));
}
