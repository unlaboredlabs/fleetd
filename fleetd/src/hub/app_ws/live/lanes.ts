// What a live subscription's lanes are made of (`board_lanes`,
// `agent_lanes`, `machines`, `slots`, with orders' `live_lane`, phase's lane statuses and agents' task reads). Tasks come
// through hub/tasks' records, leads (their state and parked) through hub/leads.
import type {
  LaneStatus,
  LeadState,
  LiveLane,
  MachineLive,
  ProjectRef,
  SlotState,
  Task,
  ThreadRef,
  WorkstreamId,
} from "../../../shared/contracts.ts";
import type { Hub } from "../../api/hub.ts";
import type { Caller } from "../../api/registry.ts";
import { allows, isoMs } from "../../auth/index.ts";
import { activity, jsTake, type LiveParts } from "../../executor/activity.ts";
import { executors } from "../../executor/index.ts";
import { leads } from "../../leads/index.ts";
import { link } from "../../link/server.ts";
import { workstreamGet } from "../../orders/workstreams.ts";
import { state as slotState } from "../../slots/index.ts";
import { store } from "../../store/hub_store.ts";
import { type TaskFilter, TaskRecords } from "../../tasks/records.ts";
import type { LaneNow } from "./pump.ts";

/** A focused order's lanes stay in scope this long after they end, so the app sees them settle. */
const ENDED_GRACE_MS = 60_000;
/** A board's lanes stay this long after they end: a few board ticks, so the app sees how each one settled. */
const BOARD_ENDED_GRACE_MS = 15_000;
/** The newest finished tasks per state the board looks through for ones that ended within the grace. */
const BOARD_ENDED_SCAN = 50;
/** agents/mod.rs `TASK_SCAN`, orders/mod.rs `ORDER_TASKS`. */
const TASK_SCAN = 500;
const ORDER_TASKS = 200;

const tasksList = (hub: Hub, filter: TaskFilter): Task[] => TaskRecords.list(hub.db.conn, filter);
const taskGet = (hub: Hub, taskId: string): Task | undefined =>
  /^T[1-9][0-9]*$/.test(taskId) ? TaskRecords.get(hub.db.conn, taskId)?.task : undefined;

/** phase.rs `task_lane_status`. */
export function taskLaneStatus(task: Task, threadStatus: string | undefined): LaneStatus {
  switch (task.state) {
    case "queued":
      return "queued";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "idle":
      return task.parked ? "parked" : "idle";
    default:
      if (task.parked) return "parked";
      if (!task.threadRef) return "starting";
      switch (threadStatus) {
        case "waiting":
          return "waiting";
        case "running":
          return "working";
        case "idle":
        case "completed":
          return "idle";
        case "failed":
        case "interrupted":
          return "stalled";
        default:
          return "starting";
      }
  }
}

/** phase.rs `lead_lane_status`. */
export function leadLaneStatus(state: LeadState, parked: boolean, threadStatus: string | undefined): LaneStatus {
  if (parked) return "parked";
  switch (state) {
    case "starting":
      return "starting";
    case "stalled":
      return "stalled";
    case "stopped":
      return "cancelled";
    default:
      if (threadStatus === "waiting") return "waiting";
      if (threadStatus === "running" || state === "working") return "working";
      return "idle";
  }
}

/** orders/mod.rs `live_lane`: what is doing comes only with a working lane. */
export function liveLane(laneId: string, status: LaneStatus, parts: LiveParts | undefined): LiveLane {
  const working = status === "working" || status === "starting";
  return {
    laneId,
    status,
    ...(working && parts?.activity ? { activity: parts.activity } : {}),
    ...(parts?.tokens ? { tokens: parts.tokens } : {}),
    ...(parts ? { spark: parts.spark } : {}),
  };
}

/** contracts live.rs `lead_lane_id`: `lead:<machine>/<project>`, cut to 80 UTF-16 units. */
export const leadLaneId = (r: ProjectRef) => jsTake(`lead:${r.machineId}/${r.projectId}`, 80);

/** The thread's status as last seen: the machine stream's, else the stored row's. */
function threadStatus(hub: Hub, r: ThreadRef): string | undefined {
  return executors(hub).tracked(r)?.summary.status ?? store(hub).threadGet(r)?.thread.status;
}

function taskLane(hub: Hub, task: Task, focus: boolean): LaneNow {
  const status = taskLaneStatus(task, task.threadRef ? threadStatus(hub, task.threadRef) : undefined);
  const parts = task.threadRef ? activity(hub).live(task.threadRef) : undefined;
  return { lane: liveLane(task.taskId, status, parts), ...(focus && parts?.text ? { text: parts.text } : {}) };
}

function leadLanes(hub: Hub, projects: ProjectRef[], focus: boolean): LaneNow[] {
  const out: LaneNow[] = [];
  for (const r of projects) {
    // The lead with its state as hub/leads derives it, parked by the usage layer included.
    const lead = leads(hub).get(r);
    if (!lead) continue;
    const thread = { machineId: r.machineId, threadId: lead.threadId };
    const status = leadLaneStatus(lead.state, lead.parked !== undefined, executors(hub).tracked(thread)?.summary.status);
    const parts = activity(hub).live(thread);
    out.push({ lane: liveLane(leadLaneId(r), status, parts), ...(focus && parts?.text ? { text: parts.text } : {}) });
  }
  return out;
}

/** The focused order's lanes: its live tasks, those that ended in the last minute, and its project's lead. */
export function focusLanes(hub: Hub, caller: Caller, id: WorkstreamId): LaneNow[] {
  const w = workstreamGet(hub.db.conn, id);
  if (!w) return [];
  const project = w.projectRef;
  if (!allows(caller, "read", project.machineId)) return [];
  const cutoff = isoMs(hub.clock.now() - ENDED_GRACE_MS);
  const lanes = tasksList(hub, { workstreamId: id, limit: ORDER_TASKS })
    .filter((t) => t.state === "queued" || t.state === "running" || t.state === "idle" || (t.endedAt !== undefined && t.endedAt >= cutoff))
    .map((t) => taskLane(hub, t, true));
  lanes.push(...leadLanes(hub, [project], true));
  return lanes;
}

const refKey = (r: ProjectRef) => `${r.machineId}\u0000${r.projectId}`;

/** agents/mod.rs `readable_projects`: every project the key reads. */
function readableProjects(hub: Hub, caller: Caller): ProjectRef[] {
  return store(hub)
    .projectsList()
    .filter((p) => allows(caller, "read", p.machineId))
    .map((p) => ({ machineId: p.machineId, projectId: p.projectId }));
}

function readableTasks(hub: Hub, caller: Caller, tasks: Task[]): Task[] {
  return tasks.filter((t) => allows(caller, "read", t.projectRef.machineId));
}

/**
 * Every agent the agents view lists: each queued, running or idle task the key may read, those that ended in the
 * last few seconds, and each readable lead that is working.
 */
export function boardLanes(hub: Hub, caller: Caller): LaneNow[] {
  const live = (["running", "queued", "idle"] as const).flatMap((state) => tasksList(hub, { state, limit: TASK_SCAN }));
  const lanes = readableTasks(hub, caller, live).map((t) => taskLane(hub, t, false));
  const cutoff = isoMs(hub.clock.now() - BOARD_ENDED_GRACE_MS);
  const ended = (["done", "failed", "cancelled"] as const)
    .flatMap((state) => tasksList(hub, { state, limit: BOARD_ENDED_SCAN }))
    .filter((t) => t.endedAt !== undefined && t.endedAt >= cutoff);
  lanes.push(...readableTasks(hub, caller, ended).map((t) => taskLane(hub, t, false)));
  const readable = new Set(readableProjects(hub, caller).map(refKey));
  // chat/flow.rs `lead_working`: the lead's own state says it works.
  const working = leads(hub)
    .list()
    .filter((l) => readable.has(refKey(l.projectRef)) && l.state === "working")
    .map((l) => l.projectRef);
  lanes.push(...leadLanes(hub, working, false));
  return lanes;
}

/** One agent by its lane id ("T7", or a project's "lead:<machine>/<project>"), with its streamed text. */
export function agentLanes(hub: Hub, caller: Caller, laneId: string): LaneNow[] {
  if (laneId.startsWith("lead:")) {
    const rest = laneId.slice(5);
    const slash = rest.indexOf("/");
    if (slash < 0) return [];
    const project = { machineId: rest.slice(0, slash), projectId: rest.slice(slash + 1) };
    if (!/^[a-z0-9-]{1,32}$/.test(project.machineId) || project.projectId === "") return [];
    if (!allows(caller, "read", project.machineId)) return [];
    return leadLanes(hub, [project], true);
  }
  const task = taskGet(hub, laneId);
  if (!task || !allows(caller, "read", task.projectRef.machineId)) return [];
  return [taskLane(hub, task, true)];
}

/** Every machine the key may read, with its load, its running threads and when its link came up. */
export function machines(hub: Hub, caller: Caller): MachineLive[] {
  const running = new Map<string, number>();
  for (const t of executors(hub).running()) running.set(t.thread.machineId, (running.get(t.thread.machineId) ?? 0) + 1);
  return store(hub)
    .machinesList()
    .filter((m) => allows(caller, "read", m.machineId))
    .map((m) => {
      const load = m.status !== "offline" ? link(hub).load(m.machineId) : undefined;
      const since = executors(hub).liveSince(m.machineId);
      const out: MachineLive = {
        asOf: m.lastSeenAt,
        ...(since !== undefined ? { linkedSince: isoMs(since) } : {}),
        ...(load ? { load: load as MachineLive["load"] } : {}),
        machineId: m.machineId,
        name: jsTake(m.name, 200),
        running: running.get(m.machineId) ?? 0,
        ...(m.lastSlept ? { slept: m.lastSlept } : {}),
        status: m.status,
      };
      return out;
    })
    .sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
}

/**
 * The slot board, its per-project and per-machine rows cut to the machines the key may read.
 */
export function slots(hub: Hub, caller: Caller): SlotState | undefined {
  const board = slotState(hub);
  return {
    ...board,
    perProject: board.perProject.filter((p) => allows(caller, "read", p.projectRef.machineId)),
    ...(board.perMachine ? { perMachine: board.perMachine.filter((m) => allows(caller, "read", m.machineId)) } : {}),
  };
}
