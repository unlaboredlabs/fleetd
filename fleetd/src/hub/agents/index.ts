// The agents view: every agent of the projects a key may read (`agents_list`).
// Reads the task, lead and train stores and the executor's sessions; owns no table.
import type { AgentRow, Change, ProjectRef, Task, TaskState } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { leadLane, lookups, prRef, projectChanges, taskLane } from "../orders/index.ts";
import { leadGet, leadsList } from "../orders/sources.ts";
import { store } from "../store/hub_store.ts";
import { TaskRecords } from "../tasks/records.ts";
import { ENDED_SCAN, row, sortRows, TASK_SCAN } from "./sort.ts";

export { AGENTS_MAX, sortRows } from "./sort.ts";

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
