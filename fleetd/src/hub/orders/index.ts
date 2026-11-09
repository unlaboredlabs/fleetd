// The orders board: open workstreams joined with their agents (tasks and the project's lead), PRs, open requests and
// the trains of their repos, for the app's board and order view. Reads the
// existing stores; owns no table.
import type {
  AgentLane,
  AgentRole,
  Change,
  Effort,
  Lead,
  LaneStatus,
  LiveLane,
  OrderCard,
  PrChip,
  PrRef,
  ProjectRef,
  Task,
  ThreadRef,
  TrainLive,
  UsageParked,
  Workstream,
  WorkstreamId,
} from "../../shared/contracts.ts";
import { jsPrefix } from "../../shared/text.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { executors, peek } from "../executor/index.ts";
import { others } from "../navi/owner.ts";
import { profiles } from "../projects/profiles.ts";
import { isoMs } from "../store/time.ts";
import { TaskRecords } from "../tasks/records.ts";
import { leadLaneStatus, phase, role, settled, sortCards, taskLaneStatus } from "./phase.ts";
import { hasTrain, leadGet, leadProfile, openRequests, trainChanges } from "./sources.ts";
import { workstreamsList } from "./workstreams.ts";

export const BOARD_ORDERS = 60;
export const CARD_LANES = 12;
export const CARD_PRS = 6;
export const DONE_LANES = 30;
export const BOARD_TRAINS = 10;
/** Tasks read per order: far above what one order spawns. */
const ORDER_TASKS = 200;
/** Changes read per project to find its orders' PRs. */
const PROJECT_CHANGES = 200;
/** Longest order title on a card, in characters. */
export const TITLE_CHARS = 60;

/** What the join asks of the rest of the hub. */
export type Lookups = {
  /** The thread's status, model and effort as the hub last saw them. */
  thread(r: ThreadRef): { status: string; model?: string; effort?: string } | undefined;
  /** A lane's live parts (activity, tokens, spark), from the executor's activity tracker. */
  live(r: ThreadRef): Pick<LiveLane, "activity" | "tokens" | "spark"> | undefined;
  /** The profile the project's lead session started on: the default for one started before fleetd kept it. */
  leadProfile(r: ProjectRef): string | undefined;
};

/** The executor's activity (T2253's `hub.area("activity")`), once its area exists. */
type ActivityLive = { live(r: ThreadRef): ReturnType<Lookups["live"]> };

export function lookups(hub: Hub): Lookups {
  return {
    thread: (r) => {
      const s = executors(hub).tracked(r)?.summary;
      return s ? { status: s.status, ...(s.model !== undefined ? { model: s.model } : {}), ...(s.effort !== undefined ? { effort: s.effort } : {}) } : undefined;
    },
    live: (r) => peek<ActivityLive>(hub, "activity")?.live(r),
    leadProfile: (r) => {
      const name = leadProfile(hub, r);
      if (name !== undefined) return name;
      try {
        return profiles(hub).defaultProfile().name;
      } catch {
        return undefined;
      }
    },
  };
}

const text = (s: string, max: number) => jsPrefix(s, max);
const model = (s: string | undefined) => (s === undefined || s === "" ? undefined : jsPrefix(s, 80));
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const effortOf = (s: string | undefined) => (s !== undefined && EFFORTS.includes(s) ? (s as Effort) : undefined);

/**
 * A card's title: the frozen brief's goal once there is one, else the order's first line, without a leading
 * `@project` or a kind prefix such as `fix:`, cut to its first sentence and to TITLE_CHARS on a word boundary.
 */
export function shortTitle(w: Workstream): string {
  let rest = (w.brief?.goal ?? w.title).trim();
  for (;;) {
    const before = rest;
    const lower = rest.toLowerCase();
    if (rest.startsWith("@")) {
      const space = rest.search(/\s/);
      rest = space < 0 ? "" : rest.slice(space + 1).trimStart();
    }
    for (const prefix of ["fix:", "bug:", "bugfix:", "feature:", "research:", "finish:"]) {
      if (lower.startsWith(prefix)) rest = rest.slice(prefix.length).trimStart();
    }
    if (rest === before) break;
  }
  const line = rest.split("\n")[0] ?? rest;
  const first = (line.split(". ")[0] ?? line).trim().replace(/\.+$/, "");
  const chars = [...first];
  if (chars.length <= TITLE_CHARS) return first;
  const cut = chars.slice(0, TITLE_CHARS - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space >= 0 ? cut.slice(0, space) : cut).replace(/[,;:]+$/, "")}…`;
}

/** One PR for the app, with its clean reviews of the current patch against the one it needs. */
export function prRef(change: Change): PrRef {
  const done = (change.reviews ?? []).filter(
    (r) => r.blocking === 0 && (change.patchId !== undefined ? r.patchId === change.patchId : r.prHeadSha === change.headSha),
  ).length;
  return {
    changeId: change.changeId,
    repo: change.repo,
    number: change.prNumber,
    url: change.prUrl,
    state: change.state,
    ...(change.position !== undefined ? { position: change.position } : {}),
    reviewsDone: done,
    reviewsNeeded: 1,
    ...(change.taskId !== undefined ? { taskId: change.taskId } : {}),
  };
}

/** A lane's live values. An activity only while it can be true: a lane not working says no more than its status. */
export function liveLane(laneId: string, status: LaneStatus, parts: ReturnType<Lookups["live"]>): LiveLane {
  const working = status === "working" || status === "starting";
  return {
    laneId,
    status,
    ...(working && parts?.activity ? { activity: parts.activity } : {}),
    ...(parts?.tokens ? { tokens: parts.tokens } : {}),
    ...(parts?.spark ? { spark: parts.spark } : {}),
  };
}

/** "14:05" from an ISO timestamp (UTC, as the hub stores it). */
const hhmm = (iso: string) => (iso.length >= 16 ? iso.slice(11, 16) : iso);

/**
 * Why a parked task waits and until when. Only a proxy with no account waits for a person (usage_resume); a limit
 * that named no reset is tried again by fleetd itself.
 */
export function parkedReason(p: UsageParked): string {
  const what = p.proxy === true ? "rate-limited by your proxy" : "usage limit";
  if (p.resumeAt !== undefined) return `${what}: resumes ${hhmm(p.resumeAt)}`;
  if (p.class === "pool_exhausted") return "usage limit: resumes on usage_resume";
  if (p.checkAt !== undefined) return `${what}: checking again at ${hhmm(p.checkAt)}`;
  return `${what}: checking again shortly`;
}

function reasonOf(task: Task, status: LaneStatus): string | undefined {
  switch (status) {
    case "queued":
      return task.queuedReason;
    case "parked":
      return task.parked ? parkedReason(task.parked) : "usage limit";
    case "failed": {
      if (task.result?.status !== "failed") return undefined;
      const lines = task.result.tail.split(/\r?\n/).reverse();
      return lines.find((l) => l.trim() !== "" && !l.startsWith("Refs: "))?.trim();
    }
    default:
      return undefined;
  }
}

/**
 * A checker's lane names what it checks, "review #113", "QA #114"; their task titles are long and alike. Other lanes
 * keep their task's title.
 */
function laneTitle(task: Task, laneRole: AgentRole, num: number | undefined, prUrl: string | undefined): string {
  const verb = laneRole === "reviewer" ? "review" : laneRole === "qa" ? "QA" : undefined;
  if (!verb) return task.title;
  let n = num;
  if (n === undefined && prUrl !== undefined) {
    const last = prUrl.replace(/\/+$/, "").split("/").pop() ?? "";
    if (/^\+?\d+$/.test(last)) n = Number(last);
  }
  return n !== undefined ? `${verb} #${n}` : task.title;
}

/** A task as one agent lane. */
export function taskLane(task: Task, prs: [Change, PrRef][], look: Lookups): AgentLane {
  const thread = task.threadRef ? look.thread(task.threadRef) : undefined;
  const status = taskLaneStatus(task, thread?.status);
  const laneRole = role(task.kind, task.qa === true);
  const prUrl = task.result?.prUrl ?? task.pr;
  const pr =
    prs.find(([c]) => c.taskId !== undefined && c.taskId === task.taskId)?.[1] ??
    (prUrl !== undefined ? prs.find(([c]) => c.prUrl === prUrl)?.[1] : undefined);
  const parts = task.threadRef ? look.live(task.threadRef) : undefined;
  const reason = reasonOf(task, status);
  const m = model(thread?.model);
  const e = effortOf(thread?.effort);
  return {
    laneId: task.taskId,
    role: laneRole,
    taskId: task.taskId,
    ...(task.threadRef ? { threadRef: task.threadRef } : {}),
    title: text(laneTitle(task, laneRole, pr?.number, prUrl), 200),
    ...(m !== undefined ? { model: m } : {}),
    ...(e !== undefined ? { effort: e } : {}),
    profile: task.profile,
    status,
    ...(reason !== undefined ? { statusReason: text(reason, 200) } : {}),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.branch !== undefined ? { branch: task.branch } : {}),
    ...(pr ? { pr } : {}),
    ...(parts ? { live: liveLane(task.taskId, status, parts) } : {}),
  } as AgentLane;
}

/** A project's lead lane id (live.rs `lead_lane_id`). */
export const leadLaneId = (r: ProjectRef) => `lead:${r.machineId}/${r.projectId}`;

/** The project's lead as a lane. */
export function leadLane(lead: Lead, projectTitle: string, look: Lookups): AgentLane {
  const r = { machineId: lead.projectRef.machineId, threadId: lead.threadId };
  const thread = look.thread(r);
  const status = leadLaneStatus(lead.state, lead.parked !== undefined, thread?.status);
  const id = leadLaneId(lead.projectRef);
  const parts = look.live(r);
  const m = model(thread?.model);
  const e = effortOf(thread?.effort);
  const profile = look.leadProfile(lead.projectRef);
  return {
    ...(parts ? { live: liveLane(id, status, parts) } : {}),
    laneId: id,
    role: "lead",
    threadRef: r,
    title: text(`${projectTitle} lead`, 200),
    ...(m !== undefined ? { model: m } : {}),
    ...(e !== undefined ? { effort: e } : {}),
    ...(profile !== undefined ? { profile } : {}),
    status,
    startedAt: lead.startedAt,
  } as AgentLane;
}

/** Everything one card is built from. */
export type OrderParts = { workstream: Workstream; tasks: Task[]; changes: Change[]; openRequests: number; leadWorking: boolean };

export type Joined = { card: OrderCard; done: AgentLane[]; truncated: boolean };

const byDesc = (a: string | undefined, b: string | undefined) => ((b ?? "") > (a ?? "") ? 1 : (b ?? "") < (a ?? "") ? -1 : 0);

/** The card: active lanes (newest first), PRs, the phase and the agent counts. */
export function card(p: OrderParts, look: Lookups): Joined {
  const prs: [Change, PrRef][] = p.changes.map((c) => [c, prRef(c)]);
  const lanes = p.tasks.map((t) => taskLane(t, prs, look));
  // Absent sorts first, as Rust's `None < Some`.
  lanes.sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === undefined) return 1;
      if (b.startedAt === undefined) return -1;
      return byDesc(a.startedAt, b.startedAt);
    }
    return byDesc(a.laneId, b.laneId);
  });
  const w = p.workstream;
  const [orderPhase, detail] = phase({
    state: w.state,
    draft: w.brief === undefined,
    openRequests: p.openRequests,
    lanes: lanes.map((l) => [l.role, l.status, l.statusReason]),
    prs: prs.map(([c]) => ({ state: c.state, number: c.prNumber })),
    leadWorking: p.leadWorking,
  });
  const total = lanes.length;
  const done = lanes.filter((l) => settled(l.status));
  let active = lanes.filter((l) => !settled(l.status));
  const settledCount = done.length;
  const truncated = active.length > CARD_LANES || prs.length > CARD_PRS || done.length > DONE_LANES;
  active = active.slice(0, CARD_LANES);
  // Rust sorts the done lanes by `ended_at` descending: absent last.
  done.sort((a, b) => {
    if (a.endedAt === b.endedAt) return 0;
    if (a.endedAt === undefined) return 1;
    if (b.endedAt === undefined) return -1;
    return byDesc(a.endedAt, b.endedAt);
  });
  const orderCard: OrderCard = {
    workstreamId: w.workstreamId,
    projectRef: w.projectRef,
    title: shortTitle(w),
    state: w.state,
    phase: orderPhase,
    ...(detail !== undefined ? { phaseDetail: text(detail, 200) } : {}),
    ...(w.headline !== undefined ? { next: w.headline } : {}),
    needsYou: p.openRequests,
    settled: settledCount,
    total,
    lanes: active,
    prs: prs.slice(0, CARD_PRS).map(([, r]) => r),
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
  return { card: orderCard, done: done.slice(0, DONE_LANES), truncated };
}

/** The repo's train for the strip: the head, then the queue in order, then today's merges, newest first. */
export function trainLive(repo: string, changes: Change[], today: string): TrainLive {
  const chip = (c: Change, position: number | undefined): PrChip => ({
    changeId: c.changeId,
    number: c.prNumber,
    url: c.prUrl,
    workstreamId: c.workstreamId,
    state: c.state,
    ...(position !== undefined ? { position } : {}),
  });
  const head = changes.filter((c) => c.state === "rebasing" || c.state === "ci" || c.state === "merging");
  head.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
  const queue = changes.filter((c) => c.state === "queued" || c.state === "reviewing" || c.state === "ready");
  queue.sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const merged = changes.filter((c) => c.state === "merged" && c.updatedAt >= today);
  merged.sort((a, b) => byDesc(a.updatedAt, b.updatedAt));
  const chips = [...head.map((c) => chip(c, undefined)), ...queue.map((c) => chip(c, c.position)), ...merged.map((c) => chip(c, undefined))].slice(0, 12);
  return { repo, chips, mergedToday: merged.length };
}

/** The open orders the caller may read (and those done since `doneSince`), newest first. */
export function ordersInScope(hub: Hub, caller: Caller, project: ProjectRef | undefined, doneSince: string | undefined): Workstream[] {
  const out = workstreamsList(hub.db.conn, { ...(project ? { projectRef: project } : {}), state: "open", limit: 500 });
  if (doneSince !== undefined) {
    out.push(
      ...workstreamsList(hub.db.conn, { ...(project ? { projectRef: project } : {}), state: "done", limit: 100 }).filter((w) => w.updatedAt >= doneSince),
    );
  }
  // Another person's Only me project's orders are theirs alone (D310).
  const navis = others(hub.db, caller);
  return out.filter((w) => allows(caller, "read", w.projectRef.machineId) && !navis.has(w.projectRef));
}

export const orderTasks = (hub: Hub, id: WorkstreamId) => TaskRecords.list(hub.db.conn, { workstreamId: id, limit: ORDER_TASKS });

/** Every open secret or approval request, counted per workstream. */
export function openRequestsByOrder(hub: Hub): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of openRequests(hub, 500)) if (r.workstreamId !== undefined) out.set(r.workstreamId, (out.get(r.workstreamId) ?? 0) + 1);
  return out;
}

export const projectChanges = (hub: Hub, project: ProjectRef) => trainChanges(hub, { projectRef: project, limit: PROJECT_CHANGES });

const leadWorking = (hub: Hub, project: ProjectRef) => leadGet(hub, project)?.state === "working";

/** One order joined, for the board or order_get. */
export function join(hub: Hub, w: Workstream, changes: Change[], requests: number): Joined {
  return card(
    {
      workstream: w,
      tasks: orderTasks(hub, w.workstreamId),
      changes: changes.filter((c) => c.workstreamId === w.workstreamId),
      openRequests: requests,
      leadWorking: leadWorking(hub, w.projectRef),
    },
    lookups(hub),
  );
}

/** Cards for these orders, sorted for the board, and the trains of their repos. */
export function board(hub: Hub, orders: Workstream[]): { cards: OrderCard[]; trains: TrainLive[]; truncated: boolean } {
  const requests = openRequestsByOrder(hub);
  const changes = new Map<string, Change[]>();
  const keyOf = (r: ProjectRef) => `${r.machineId}\u0000${r.projectId}`;
  const cards: OrderCard[] = [];
  let truncated = orders.length > BOARD_ORDERS;
  for (const w of orders.slice(0, BOARD_ORDERS)) {
    const k = keyOf(w.projectRef);
    if (!changes.has(k)) changes.set(k, projectChanges(hub, w.projectRef));
    const joined = join(hub, w, changes.get(k) ?? [], requests.get(w.workstreamId) ?? 0);
    truncated ||= joined.truncated;
    cards.push(joined.card);
  }
  sortCards(cards);
  return { cards, trains: trains(hub, [...changes.values()].flat()), truncated };
}

function trains(hub: Hub, changes: Change[]): TrainLive[] {
  const today = `${isoMs(hub.clock.now()).slice(0, 10)}T00:00:00.000Z`;
  const repos = [...new Set(changes.map((c) => c.repo.toLowerCase()))].sort();
  const out: TrainLive[] = [];
  for (const repo of repos) {
    if (!hasTrain(hub, repo)) continue;
    const ofRepo = changes.filter((c) => c.repo.toLowerCase() === repo);
    const name = ofRepo[0]?.repo;
    if (name === undefined) continue;
    const train = trainLive(name, ofRepo, today);
    if (train.chips.length > 0) out.push(train);
    if (out.length === BOARD_TRAINS) break;
  }
  return out;
}
