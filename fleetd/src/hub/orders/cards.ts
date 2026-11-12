// An order's card on the board, and a train's live line, without the hub (index.ts reads the parts and joins them):
// the board's limits, an order's short title, its lanes and PR chips, and what the join asks of the rest of the hub.
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
} from "../../shared/contracts.ts";
import { jsPrefix } from "../../shared/text.ts";
import { leadLaneStatus, phase, role, settled, taskLaneStatus } from "./phase.ts";

export const BOARD_ORDERS = 60;
export const CARD_LANES = 12;
export const CARD_PRS = 6;
export const DONE_LANES = 30;
export const BOARD_TRAINS = 10;
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

export const text = (s: string, max: number) => jsPrefix(s, max);
export const model = (s: string | undefined) => (s === undefined || s === "" ? undefined : jsPrefix(s, 80));
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const effortOf = (s: string | undefined) => (s !== undefined && EFFORTS.includes(s) ? (s as Effort) : undefined);

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
export const hhmm = (iso: string) => (iso.length >= 16 ? iso.slice(11, 16) : iso);

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

export function reasonOf(task: Task, status: LaneStatus): string | undefined {
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
export function laneTitle(task: Task, laneRole: AgentRole, num: number | undefined, prUrl: string | undefined): string {
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

export const byDesc = (a: string | undefined, b: string | undefined) => ((b ?? "") > (a ?? "") ? 1 : (b ?? "") < (a ?? "") ? -1 : 0);

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
