// The agents view: every agent of the projects a key may read (`agents_list`).
// Reads the task, lead and train stores and the executor's sessions; owns no table.
import type { AgentLane, AgentRow, Change, LaneStatus, ProjectRef, Task, TaskState } from "../../shared/contracts.ts";
import { jsPrefix } from "../../shared/text.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { leadLane, lookups, prRef, projectChanges, taskLane } from "../orders/index.ts";
import { leadGet, leadsList } from "../orders/sources.ts";
import { store } from "../store/hub_store.ts";
import { TaskRecords } from "../tasks/records.ts";

/** Tasks read per state: far above what a fleet runs at once. */
const TASK_SCAN = 500;
/** Finished tasks read per end state for `endedSince`. */
const ENDED_SCAN = 100;
export const AGENTS_MAX = 100;

const keyOf = (r: ProjectRef) => `${r.machineId}\u0000${r.projectId}`;

/** The projects the key may read, with their titles, optionally one of them. */
export function readableProjects(hub: Hub, caller: Caller, only: ProjectRef | undefined): Map<string, { r: ProjectRef; title: string }> {
  const out = new Map<string, { r: ProjectRef; title: string }>();
  for (const p of store(hub).projectsList(only?.machineId)) {
    const r = { machineId: p.machineId, projectId: p.projectId };
    if (!allows(caller, "read", p.machineId)) continue;
    if (only && (only.machineId !== r.machineId || only.projectId !== r.projectId)) continue;
    out.set(keyOf(r), { r, title: p.title });
  }
  return out;
}

const tasksIn = (hub: Hub, project: ProjectRef | undefined, state: TaskState, limit: number) =>
  TaskRecords.list(hub.db.conn, { ...(project ? { projectRef: project } : {}), state, limit });

/** Whether the key may read `task`: a grant on its machine. */
const taskReadable = (caller: Caller, task: Task) => allows(caller, "read", task.projectRef.machineId);

/** Every queued, running or idle task the key may read. */
export function liveTasks(hub: Hub, caller: Caller, project: ProjectRef | undefined): Task[] {
  return (["running", "queued", "idle"] as const).flatMap((s) => tasksIn(hub, project, s, TASK_SCAN)).filter((t) => taskReadable(caller, t));
}

/** Tasks that ended at or after `since`, newest first per end state, that the key may read. */
export function endedTasks(hub: Hub, caller: Caller, project: ProjectRef | undefined, since: string, scan: number): Task[] {
  return (["done", "failed", "cancelled"] as const)
    .flatMap((s) => tasksIn(hub, project, s, scan))
    .filter((t) => t.endedAt !== undefined && t.endedAt >= since && taskReadable(caller, t));
}

/** The readable projects that have a lead. */
export const leadProjects = (hub: Hub, readable: Map<string, { r: ProjectRef }>) =>
  leadsList(hub)
    .map((l) => l.projectRef)
    .filter((r) => readable.has(keyOf(r)));

/** Where a status sits in the list: agents doing something first, then those waiting their turn, then the rest. */
function rank(status: LaneStatus): number {
  switch (status) {
    case "waiting":
      return 0;
    case "working":
    case "starting":
      return 1;
    case "stalled":
      return 2;
    case "queued":
    case "parked":
      return 3;
    case "idle":
      return 4;
    case "failed":
      return 5;
    default:
      return 6;
  }
}

/** Options compare as Rust's: absent before present. */
const cmpOpt = (a: string | undefined, b: string | undefined) =>
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;

/** Waiting on a person first, then working, then by most recent start; finished agents by most recent end. */
export function sortRows(rows: AgentRow[]): void {
  rows.sort((a, b) => rank(a.status) - rank(b.status) || cmpOpt(b.endedAt, a.endedAt) || cmpOpt(b.startedAt, a.startedAt) || (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0));
}

const row = (lane: AgentLane, project: ProjectRef, title: string, task: Task | undefined): AgentRow =>
  ({ ...lane, projectRef: project, projectTitle: jsPrefix(title, 200), ...(task ? { workstreamId: task.workstreamId } : {}) }) as AgentRow;

/** Every agent in scope as a row, sorted, and whether the list was cut to `max`. */
export function rows(hub: Hub, caller: Caller, project: ProjectRef | undefined, endedSince: string | undefined, max: number): [AgentRow[], boolean] {
  const projects = readableProjects(hub, caller, project);
  let tasks = liveTasks(hub, caller, project);
  if (endedSince !== undefined) tasks.push(...endedTasks(hub, caller, project, endedSince, ENDED_SCAN));
  tasks = tasks.filter((t) => projects.has(keyOf(t.projectRef)));
  const changes = new Map<string, Change[]>();
  const look = lookups(hub);
  const out: AgentRow[] = [];
  for (const task of tasks) {
    const k = keyOf(task.projectRef);
    if (!changes.has(k)) changes.set(k, projectChanges(hub, task.projectRef));
    const prs = (changes.get(k) ?? []).map((c): [Change, ReturnType<typeof prRef>] => [c, prRef(c)]);
    out.push(row(taskLane(task, prs, look), task.projectRef, projects.get(k)?.title ?? "", task));
  }
  for (const r of leadProjects(hub, projects)) {
    const lead = leadGet(hub, r);
    if (!lead) continue;
    const title = projects.get(keyOf(r))?.title ?? "";
    out.push(row(leadLane(lead, title, look), r, title, undefined));
  }
  sortRows(out);
  return [out.slice(0, max), out.length > max];
}
