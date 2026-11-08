// A project's work in groups (crates/fleetd/src/hub/status/groups.rs): its agents by what they do, then their PR, then
// how they ended; PRs no agent covers; requests and screens waiting on the person. Counted in full, listed at most
// STATUS_ITEMS_PER_GROUP per group, newest first. Idle and done items stop being news after 7 days.
import type {
  AgentLane,
  Change,
  ChangeState,
  HumanRequest,
  LaneStatus,
  PrRef,
  ProjectRef,
  StatusCounts,
  StatusGroup,
  StatusItem,
  StatusPr,
  Task,
  TaskState,
} from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { TaskRecords } from "../tasks/records.ts";
import { isoMs, parseMs } from "../store/time.ts";

export const WINDOW_MS = 7 * 24 * 3_600_000;
export const STATUS_ITEMS_PER_GROUP = 8;
const TASK_SCAN = 500;
const ENDED_SCAN = 100;

/** The orders area's lane and PR reads (T2246's `status_groups`, made when its tasks area starts). */
export type StatusGroupsSeam = {
  taskLane(task: Task, changes: [Change, PrRef][]): Pick<AgentLane, "status" | "pr" | "statusReason">;
  projectChanges(r: ProjectRef): Change[];
  prRef(change: Change): PrRef;
};

/** Until the orders area makes it: a task's lane from its own state, and no PRs. */
const LANE_OF: Record<TaskState, LaneStatus> = {
  queued: "queued",
  running: "working",
  idle: "idle",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const WITHOUT_ORDERS: StatusGroupsSeam = {
  taskLane: (task) => ({ status: LANE_OF[task.state] ?? "idle" }),
  projectChanges: () => [],
  prRef: (c) => ({ changeId: c.changeId, number: c.prNumber, repo: c.repo, reviewsDone: 0, reviewsNeeded: 1, state: c.state }) as PrRef,
};

/** The orders area's `status_groups`, read without making it (D354). */
export const statusGroups = (hub: Hub): StatusGroupsSeam => hub.peek<StatusGroupsSeam>("status_groups") ?? WITHOUT_ORDERS;

/** One line of at most `max` UTF-16 units, with "…" when cut (rows.rs `clip`). */
export function clip(s: string, max: number): string {
  const oneLine = s.replace(/[\r\n]/g, " ");
  if (oneLine.length <= max) return oneLine;
  let out = "";
  for (const ch of oneLine) {
    if (out.length + ch.length + 1 > max) break;
    out += ch;
  }
  return `${out}…`;
}

/** A Line: never empty. */
export const line = (s: string, max: number) => {
  const c = clip(s, max);
  return c === "" ? "—" : c;
};

export function prGroup(state: ChangeState): StatusGroup {
  switch (state) {
    case "queued":
    case "reviewing":
      return "in_review";
    case "ready":
    case "rebasing":
    case "ci":
    case "merging":
      return "landing";
    case "merged":
      return "done";
    default:
      return "idle";
  }
}

function prWhy(state: ChangeState): string | undefined {
  return (
    { needs_rebase: "needs a rebase", ci_failed: "CI failed", refused: "refused by the train", abandoned: "abandoned" } as Record<string, string>
  )[state];
}

export function agentGroup(status: LaneStatus, pr: ChangeState | undefined, orderOpen: boolean): StatusGroup {
  if (status === "waiting") return "waiting_on_you";
  if (status === "queued" || status === "starting" || status === "working" || status === "stalled") return "working";
  if (pr !== undefined) return prGroup(pr);
  if (status === "done" && !orderOpen) return "done";
  return "idle";
}

const prOf = (c: Change): StatusPr => ({ number: c.prNumber, repo: c.repo, url: clip(c.prUrl, 300) });

const ms = (t: string | undefined) => (t === undefined ? 0 : (parseMs(t) ?? 0));

function tasksOf(hub: Hub, r: ProjectRef, sinceMs: number): Task[] {
  const list = (state: TaskState, limit: number) => {
    try {
      return TaskRecords.list(hub.db.conn, { projectRef: r, state, limit });
    } catch (error) {
      console.warn("status: tasks not read:", error);
      return [];
    }
  };
  const out: Task[] = [];
  for (const state of ["running", "queued", "idle"] as const) out.push(...list(state, TASK_SCAN));
  for (const state of ["done", "failed", "cancelled"] as const) {
    out.push(...list(state, ENDED_SCAN).filter((t) => t.endedAt !== undefined && ms(t.endedAt) >= sinceMs));
  }
  return out;
}

function openOrders(hub: Hub, r: ProjectRef): Set<string> {
  try {
    return new Set(
      hub.db
        .all<{ id: string }>(
          `SELECT 'W' || n AS id FROM workstreams
           WHERE machine_id = ?1 AND project_id = ?2 AND state NOT IN ('done', 'stopped', 'failed')`,
          [r.machineId, r.projectId],
        )
        .map((x) => x.id),
    );
  } catch (error) {
    console.warn("status: orders not read:", error);
    return new Set();
  }
}

/** The project's open requests, newest first (the leads' `open_requests`), read-only. */
function openRequests(hub: Hub, r: ProjectRef, limit: number): HumanRequest[] {
  try {
    return hub.db
      .all<{ data: string }>("SELECT data FROM requests WHERE project_key = ? AND state = 'open' ORDER BY n DESC LIMIT ?", [
        `${r.machineId}/${r.projectId}`,
        limit,
      ])
      .map((x) => JSON.parse(x.data) as HumanRequest);
  } catch (error) {
    console.warn("status: requests not read:", error);
    return [];
  }
}

/** Live screens whose agent asks the person to take over (browser `waiting`). */
function waitingScreens(hub: Hub, r: ProjectRef): { takeoverReason?: string; taskId?: string }[] {
  try {
    return hub.db
      .all<{ data: string }>("SELECT data FROM browser_sessions WHERE machine_id = ?1 AND project_id = ?2 AND state = 'live'", [
        r.machineId,
        r.projectId,
      ])
      .map((x) => JSON.parse(x.data) as { takeoverReason?: string; taskId?: string })
      .filter((s) => s.takeoverReason !== undefined && s.takeoverReason !== null);
  } catch (error) {
    console.warn("status: browser sessions not read:", error);
    return [];
  }
}

function requestItem(req: HumanRequest): StatusItem {
  const kind = req.secret ? "secret" : req.permission ? "tool prompt" : "approval";
  return { at: req.createdAt, group: "waiting_on_you", title: line(req.text, TITLE), why: line(kind, WHY) };
}

const ORDER: StatusGroup[] = ["waiting_on_you", "in_review", "working", "landing", "idle", "done"];
const rank = (g: StatusGroup) => {
  const i = ORDER.indexOf(g);
  return i < 0 ? ORDER.length : i;
};

/** Counted in full; listed group by group, newest first, at most STATUS_ITEMS_PER_GROUP each. */
export function grouped(items: StatusItem[]): [StatusCounts, StatusItem[]] {
  const counts: StatusCounts = { done: 0, idle: 0, inReview: 0, landing: 0, waitingOnYou: 0, working: 0 };
  const key: Record<string, keyof StatusCounts> = {
    waiting_on_you: "waitingOnYou",
    in_review: "inReview",
    working: "working",
    landing: "landing",
    idle: "idle",
    done: "done",
  };
  for (const i of items) counts[key[i.group] ?? "idle"]++;
  const sorted = [...items].sort((a, b) => rank(a.group) - rank(b.group) || ms(b.at) - ms(a.at));
  const out: StatusItem[] = [];
  for (const i of sorted) if (out.filter((o) => o.group === i.group).length < STATUS_ITEMS_PER_GROUP) out.push(i);
  return [counts, out];
}

/** `StatusItem`: a title of at most 120 UTF-16 units, a why of at most 160. */
const TITLE = 120;
const WHY = 160;

export function read(hub: Hub, r: ProjectRef, needsYou: boolean, now: number): [StatusCounts, StatusItem[]] {
  const since = now - WINDOW_MS;
  const seam = statusGroups(hub);
  const tasks = tasksOf(hub, r, since);
  const changes = seam.projectChanges(r);
  const prs: [Change, PrRef][] = changes.map((c) => [c, seam.prRef(c)]);
  const open = openOrders(hub, r);
  const requests = openRequests(hub, r, 50);
  const items: StatusItem[] = [];
  const covered = new Set<string>();
  const threads = new Set<string>();
  const listed = new Set(tasks.map((t) => t.taskId));
  for (const task of tasks) {
    const lane = seam.taskLane(task, prs);
    const reviewer = task.kind === "review";
    if (reviewer && lane.status !== "waiting") continue;
    if (task.threadRef) threads.add(task.threadRef.threadId);
    const change = reviewer ? undefined : changes.find((c) => lane.pr !== undefined && lane.pr.changeId === c.changeId);
    if (change) covered.add(change.changeId);
    const group = agentGroup(lane.status, change?.state, open.has(task.workstreamId));
    const why = lane.statusReason ?? (change ? prWhy(change.state) : undefined);
    const at = [task.createdAt, task.startedAt, task.endedAt, change?.updatedAt]
      .filter((t): t is string => t !== undefined)
      .reduce((best, t) => (ms(t) > ms(best) ? t : best), task.createdAt);
    items.push({
      at,
      group,
      ...(change ? { pr: prOf(change) } : {}),
      taskId: task.taskId,
      title: line(task.title, TITLE),
      ...(why === undefined ? {} : { why: line(why, WHY) }),
    });
  }
  for (const c of changes) {
    if (covered.has(c.changeId) || (c.taskId !== undefined && listed.has(c.taskId))) continue;
    const why = prWhy(c.state);
    items.push({ at: c.updatedAt, group: prGroup(c.state), pr: prOf(c), title: line(c.branch, TITLE), ...(why ? { why: line(why, WHY) } : {}) });
  }
  let asks = 0;
  for (const req of requests) {
    if (req.permission && threads.has(req.permission.threadId)) continue;
    asks++;
    items.push(requestItem(req));
  }
  for (const s of waitingScreens(hub, r)) {
    items.push({
      at: isoMs(now),
      group: "waiting_on_you",
      ...(s.taskId === undefined ? {} : { taskId: s.taskId }),
      title: line(`Take over the screen: ${s.takeoverReason ?? ""}`, TITLE),
      why: line("screen", WHY),
    });
  }
  if (needsYou && asks === 0) items.push({ at: isoMs(now), group: "waiting_on_you", title: line("The lead's question in chat", TITLE) });
  return grouped(items.filter((i) => (i.group !== "idle" && i.group !== "done") || ms(i.at) >= since));
}
