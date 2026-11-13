// Pure mapping from the node's machine stream (MachineEvent) to the hub's thread and project caches and the events
// they derive. The executor feeds every event through
// `applyMachineEvent`; nothing here does I/O.
import type { ThreadSummary } from "../../shared/contracts.ts";
import type {
  FailureClass,
  MachineEvent,
  PendingPermission,
  ProjectInfo,
  RunEnd,
  SessionSummary,
  WorktreeSource,
} from "../../shared/sessions.ts";
import { runActive } from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";
import type { NewEvent } from "../store/new_event.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { resultText } from "../tasks/render.ts";
import { classifyLimit, type Limit, limitData } from "../usage/classify.ts";

/** A timestamp as fleetd formats it (`Date#toISOString`); left as is when it doesn't parse. */
export function normalizeIso(text: string): string {
  const ms = parseMs(text);
  return ms === undefined ? text : isoMs(ms);
}

export type LastError = { class: string; message: string; model?: string };

/** The hub's ThreadSummary, field for field, in the Rust struct's order. */
export type Summary = {
  machineId: string;
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  headline: string;
  latestMessageTail: string;
  lastError?: LastError;
  usageLimitResetAt?: string;
  endCause?: RunEnd;
  lastProgressAt: string;
  model?: string;
  effort?: string;
  /** Until when a Monitor its agent armed may still wake it (the node's `watchingUntil`). */
  watchingUntil?: string;
  stale: boolean;
  asOf: string;
};

/** A summary with its fields in the Rust struct's order, the absent ones left out. */
function ordered(s: Summary): Summary {
  const out: Record<string, unknown> = {
    machineId: s.machineId,
    threadId: s.threadId,
    projectId: s.projectId,
    title: s.title,
    status: s.status,
    headline: s.headline,
    latestMessageTail: s.latestMessageTail,
  };
  if (s.lastError) {
    out.lastError = { class: s.lastError.class, message: s.lastError.message, ...(s.lastError.model !== undefined ? { model: s.lastError.model } : {}) };
  }
  if (s.usageLimitResetAt !== undefined) out.usageLimitResetAt = s.usageLimitResetAt;
  if (s.endCause !== undefined) out.endCause = s.endCause;
  out.lastProgressAt = s.lastProgressAt;
  if (s.model !== undefined) out.model = s.model;
  if (s.effort !== undefined) out.effort = s.effort;
  if (s.watchingUntil !== undefined) out.watchingUntil = s.watchingUntil;
  out.stale = s.stale;
  out.asOf = s.asOf;
  return out as Summary;
}

/** A stored ThreadSummary as the mapper's Summary. */
export const fromThread = (t: ThreadSummary): Summary => ordered(t as unknown as Summary);
export const toThread = (s: Summary): ThreadSummary => ordered(s) as unknown as ThreadSummary;

/** A failed thread's limit, read off its summary. */
export function limitOfSummary(s: Summary): Limit | undefined {
  if (s.status !== "failed" || !s.lastError) return undefined;
  return classifyLimit({
    errorClass: s.lastError.class,
    at: s.lastProgressAt,
    ...(s.usageLimitResetAt !== undefined ? { resetAt: s.usageLimitResetAt } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.lastError.model !== undefined ? { failureModel: s.lastError.model } : {}),
  });
}

/** A thread row as stored: its summary plus the shell bookkeeping columns. */
export type StoredThread = {
  summary: Summary;
  lastSequence?: number;
  /** The session's latest run id when this row was written. */
  lastRunId?: string;
  /** That run's phase: a ThreadStatus, or "usage_limited". */
  lastRunStatus?: string;
};

export type ThreadCounts = { running: number; waiting: number; idle: number; failed: number };

/** The hub's ProjectSummary as a node reports it, field for field. */
export type ProjectRow = {
  machineId: string;
  projectId: string;
  title: string;
  workspaceRoot: string;
  threads: ThreadCounts;
  lastActivityAt: string;
};

export type TrackedThread = {
  summary: Summary;
  /** The session's latest run: undefined is unknown (after a hub restart), null is the node saying it has none. */
  runId: string | null | undefined;
  activeRunId?: string;
  /** The active run is still queued or starting, so a message sent now is queued behind it. */
  activeRunStarting: boolean;
  /** The permission prompt the run waits on. */
  pending?: PendingPermission;
  /** What the node rebuilt the worktree from the last time it was gone, and when. */
  recreatedFrom?: [WorktreeSource, string | undefined];
  /** The steer's run that cut the latest run, if one did. */
  supersededBy?: string;
};

export const knownRun = (t: TrackedThread) => t.runId ?? undefined;

export type ProjectMeta = { title: string; workspaceRoot: string; updatedAt: string };

/** One machine's view of the node's sessions. Holds summary rows only, never transcripts. */
export type ShellState = {
  cursor?: number;
  /** True once an authoritative snapshot has been applied, so every active thread is in `threads`. */
  complete: boolean;
  projects: Map<string, ProjectMeta>;
  threads: Map<string, TrackedThread>;
};

export const newShellState = (): ShellState => ({ complete: false, projects: new Map(), threads: new Map() });

export type EventType = "started" | "waiting" | "completed" | "failed" | "interrupted" | "usage_limited";

const EVENT_TYPE: Record<EventType, string> = {
  started: "thread.started",
  waiting: "thread.waiting",
  completed: "thread.completed",
  failed: "thread.failed",
  interrupted: "thread.interrupted",
  usage_limited: "thread.usage_limited",
};

const VERB: Record<EventType, string> = {
  started: "started",
  completed: "completed",
  failed: "failed",
  interrupted: "was interrupted",
  waiting: "is waiting for approval or input",
  usage_limited: "hit the usage limit",
};

const terminal = (t: EventType) => t === "completed" || t === "failed" || t === "interrupted" || t === "usage_limited";

export type Transition = {
  kind: EventType;
  threadId: string;
  /** The run ended while the hub was down: found by diffing a snapshot against the stored row. */
  late: boolean;
};

export type Applied = {
  /** Changed thread summaries, to upsert. */
  threads: StoredThread[];
  /** Projects whose metadata or thread counts changed, to upsert. */
  projects: ProjectRow[];
  transitions: Transition[];
  /** Set when the event moved the machine stream's cursor. */
  cursor?: number;
  /** After a full snapshot: every session the node has. Stored rows of this machine outside it are stale. */
  present?: Set<string>;
};

export type ApplyContext = {
  machineId: string;
  now: string;
  /** Stored summaries for threads not yet in memory (after a hub restart). */
  stored: Map<string, StoredThread>;
  /** No cursor was ever stored for this machine: its first snapshot is a baseline and emits nothing. */
  baseline: boolean;
};

/**
 * A session's row as the hub's ThreadStatus: an active run is running, or waiting while a permission prompt is open;
 * otherwise the latest run's outcome.
 */
export function threadStatus(s: SessionSummary): string {
  const active = s.activeRunId !== undefined || s.status === "running" || s.status === "waiting";
  if (active) return s.pendingPermission ? "waiting" : "running";
  switch (s.latestRun?.status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return s.status === "failed" ? "failed" : s.status === "interrupted" ? "interrupted" : "idle";
  }
}

/** The failure class as the hub's events and usage area name it. */
export const failureClass = (c: FailureClass) => c;

const firstLine = (text: string) => jsPrefix(text.trim().split("\n")[0] ?? "", 280);

/** `latestMessageTail`'s length. */
export const MESSAGE_KEPT = 4096;

/** Applies the latest visible assistant text: its first line is the headline, its head and tail the message. */
export function withAssistantText(summary: Summary, text: string | undefined): Summary {
  if (text === undefined || text.trim() === "") return { ...summary };
  return { ...summary, headline: firstLine(text), latestMessageTail: resultText(text, MESSAGE_KEPT) };
}

export function toThreadSummary(machineId: string, s: SessionSummary, prev: Summary | undefined, now: string): Summary {
  const failure = s.latestRun?.failure;
  const resetAt =
    failure && (failure.class === "usage_limit" || failure.class === "rate_limit") && failure.resetAt !== undefined
      ? normalizeIso(failure.resetAt)
      : undefined;
  const base: Summary = {
    machineId,
    threadId: s.sessionId,
    projectId: s.projectId,
    title: s.title,
    status: threadStatus(s),
    headline: prev?.headline ?? "",
    latestMessageTail: prev?.latestMessageTail ?? "",
    ...(failure
      ? {
          lastError: {
            class: failureClass(failure.class),
            message: jsPrefix(failure.message, 2000),
            ...(failure.model !== undefined ? { model: failure.model } : {}),
          },
        }
      : {}),
    ...(resetAt !== undefined ? { usageLimitResetAt: resetAt } : {}),
    ...(s.latestRun && !runActive(s.latestRun.status) && s.latestRun.end !== undefined ? { endCause: s.latestRun.end } : {}),
    lastProgressAt: normalizeIso(s.updatedAt),
    model: s.model,
    effort: s.effort,
    ...(s.watchingUntil !== undefined ? { watchingUntil: normalizeIso(s.watchingUntil) } : {}),
    stale: false,
    asOf: now,
  };
  return ordered(withAssistantText(base, s.latestAssistantTail));
}

/** M4: a failure the node classed as a usage, rate or pool limit is a usage limit. */
export const phase = (s: Summary) => (limitOfSummary(s) ? "usage_limited" : s.status);

function eventFor(p: string): EventType | undefined {
  switch (p) {
    case "running":
      return "started";
    case "waiting":
    case "completed":
    case "failed":
    case "interrupted":
    case "usage_limited":
      return p;
    default:
      return undefined;
  }
}

/**
 * The event a change from `prev` to `next` produces, if any. Unchanged phase and run produce none. Run ids:
 * undefined is unknown, null is no run.
 */
export function transition(
  prev: [Summary, string | null | undefined] | undefined,
  next: [Summary, string | undefined],
): EventType | undefined {
  const to = phase(next[0]);
  if (!prev) return eventFor(to);
  const from = phase(prev[0]);
  const [, prevRun] = prev;
  const newRun = typeof prevRun === "string" && next[1] !== undefined && prevRun !== next[1];
  if (from === to && !newRun) return undefined;
  // An approval being answered resumes the same run; that is not a new start.
  if (from === "waiting" && to === "running" && !newRun) return undefined;
  return eventFor(to);
}

const sameSummary = (a: Summary, b: Summary) => JSON.stringify(ordered({ ...a, asOf: "" })) === JSON.stringify(ordered({ ...b, asOf: "" }));

export function projectSummary(state: ShellState, machineId: string, projectId: string): ProjectRow | undefined {
  const meta = state.projects.get(projectId);
  if (!meta) return undefined;
  const threads: ThreadCounts = { running: 0, waiting: 0, idle: 0, failed: 0 };
  let lastActivityAt = meta.updatedAt;
  for (const t of state.threads.values()) {
    if (t.summary.projectId !== projectId) continue;
    if (t.summary.status === "running") threads.running++;
    else if (t.summary.status === "waiting") threads.waiting++;
    else if (t.summary.status === "failed") threads.failed++;
    else threads.idle++;
    if (t.summary.lastProgressAt > lastActivityAt) lastActivityAt = t.summary.lastProgressAt;
  }
  return { machineId, projectId, title: meta.title, workspaceRoot: meta.workspaceRoot, threads, lastActivityAt };
}

class Applier {
  threads: StoredThread[] = [];
  transitions: Transition[] = [];
  /** Insertion-ordered. */
  touched: string[] = [];
  cursor: number | undefined;

  constructor(
    readonly state: ShellState,
    readonly ctx: ApplyContext,
  ) {}

  touch(projectId: string): void {
    if (!this.touched.includes(projectId)) this.touched.push(projectId);
  }

  advance(seq: number): void {
    if (this.state.cursor === undefined || seq > this.state.cursor) {
      this.state.cursor = seq;
      this.cursor = seq;
    }
  }

  /**
   * `quietIfNew`: a thread seen for the first time produces no event (a baseline snapshot). `restart`: the first
   * snapshot in this hub process, diffed against what an earlier one stored.
   */
  upsertThread(session: SessionSummary, sequence: number | undefined, quietIfNew: boolean, restart: boolean): void {
    const id = session.sessionId;
    const known = this.state.threads.get(id);
    const stored = known ? undefined : this.ctx.stored.get(id);
    // A stored row without a run id has an unknown run.
    const prev: [Summary, string | null | undefined] | undefined = known
      ? [known.summary, known.runId]
      : stored
        ? [stored.summary, stored.lastRunId]
        : undefined;
    const summary = toThreadSummary(this.ctx.machineId, session, prev?.[0], this.ctx.now);
    const latestRun = session.latestRun?.id;
    const activeRunId = session.activeRunId;
    const starting =
      session.latestRun !== undefined &&
      session.latestRun.id === activeRunId &&
      (session.latestRun.status === "queued" || session.latestRun.status === "starting");
    const next: TrackedThread = {
      summary,
      runId: latestRun ?? null,
      ...(activeRunId !== undefined ? { activeRunId } : {}),
      activeRunStarting: starting,
      ...(session.pendingPermission ? { pending: session.pendingPermission } : {}),
      ...(session.recreatedFrom !== undefined ? { recreatedFrom: [session.recreatedFrom, session.recreatedAt] as [WorktreeSource, string | undefined] } : {}),
      ...(session.latestRun?.supersededBy !== undefined ? { supersededBy: session.latestRun.supersededBy } : {}),
    };
    this.state.threads.set(id, next);
    if (known && known.summary.projectId !== summary.projectId) this.touch(known.summary.projectId);
    this.touch(summary.projectId);
    const runStatus = phase(summary);
    const runChanged = stored !== undefined && (stored.lastRunId !== latestRun || stored.lastRunStatus !== runStatus);
    // An unknown run always differs, even from a known absent one.
    const prevRunDiffers = !prev || prev[1] === undefined || (prev[1] ?? undefined) !== latestRun;
    if (!prev || runChanged || prevRunDiffers || !sameSummary(prev[0], summary)) {
      this.threads.push({
        summary,
        ...(sequence !== undefined ? { lastSequence: sequence } : {}),
        ...(latestRun !== undefined ? { lastRunId: latestRun } : {}),
        lastRunStatus: runStatus,
      });
    }
    let kind: EventType | undefined;
    if (!(quietIfNew && !prev)) {
      kind = transition(prev ? [prev[0], prev[1] === undefined ? undefined : prev[1]] : undefined, [summary, latestRun]);
      // A second prompt in the same run, raised before the hub saw it run again, is a new wait.
      if (kind === undefined && summary.status === "waiting" && known && next.pending?.requestId !== known.pending?.requestId) {
        kind = "waiting";
      }
    }
    if (kind !== undefined) {
      // Anything a restart snapshot reveals happened while the hub was down.
      this.transitions.push({ kind, threadId: summary.threadId, late: restart && !known && terminal(kind) });
    }
  }

  dropThread(threadId: string): void {
    const known = this.state.threads.get(threadId);
    if (!known) return;
    this.state.threads.delete(threadId);
    this.touch(known.summary.projectId);
  }
}

const projectMeta = (p: ProjectInfo): ProjectMeta => ({
  title: p.title,
  workspaceRoot: p.workspaceRoot,
  updatedAt: normalizeIso(p.updatedAt),
});

/**
 * Mutates `state` with one machine stream event and reports what changed. `seq` is the frame's; undefined for a
 * change the hub applies itself before the stream confirms it.
 */
export function applyMachineEvent(state: ShellState, seq: number | undefined, event: MachineEvent, ctx: ApplyContext): Applied {
  const a = new Applier(state, ctx);
  let present: Set<string> | undefined;
  switch (event.type) {
    case "snapshot": {
      const baseline = ctx.baseline && !state.complete;
      const restart = !ctx.baseline && !state.complete;
      const ids = new Set(event.sessions.map((s) => s.sessionId));
      for (const id of [...state.threads.keys()].filter((id) => !ids.has(id))) a.dropThread(id);
      state.projects.clear();
      for (const p of event.projects) {
        state.projects.set(p.projectId, projectMeta(p));
        a.touch(p.projectId);
      }
      for (const s of event.sessions) a.upsertThread(s, undefined, baseline, restart);
      state.complete = true;
      present = ids;
      break;
    }
    case "project_upserted":
      state.projects.set(event.projectId, projectMeta(event));
      a.touch(event.projectId);
      break;
    case "project_removed":
      state.projects.delete(event.projectId);
      break;
    case "session_updated": {
      const { type: _type, ...session } = event;
      a.upsertThread(session, seq, false, false);
      break;
    }
    // The executor caches runner_info for the link's status; it changes no thread or project. It takes caught_up
    // before it gets here.
    default:
      break;
  }
  if (seq !== undefined) a.advance(seq);
  const projects = a.touched.flatMap((id) => {
    const row = projectSummary(state, ctx.machineId, id);
    return row ? [row] : [];
  });
  return {
    threads: a.threads,
    projects,
    transitions: a.transitions,
    ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
    ...(present ? { present } : {}),
  };
}

/**
 * Cached projects the node no longer has, given the state after `event`: the one a `project_removed` names, or after
 * a snapshot every cached one it left out.
 */
export function removedProjects(state: ShellState, event: MachineEvent, cached: string[]): string[] {
  if (event.type === "project_removed") return cached.filter((id) => id === event.projectId);
  if (event.type === "snapshot") return cached.filter((id) => !state.projects.has(id));
  return [];
}

/** The hub event for a transition, in plain language. The event log trims summary and data to their limits. */
export function transitionEvent(t: Transition, thread: TrackedThread, machineId: string): NewEvent {
  const s = thread.summary;
  const limit = t.kind === "usage_limited" ? limitOfSummary(s) : undefined;
  let detail = "";
  if (limit) {
    if (limit.class === "pool_exhausted") {
      detail = `: your proxy has no account available for ${limit.model ?? s.model ?? "the model"}`;
    } else if (limit.resumeAt !== undefined) detail = ` (resets ${limit.resumeAt})`;
    else detail = limit.proxy ? " (rate-limited by your proxy, checking again shortly)" : " (checking again shortly)";
  } else if (t.kind === "failed" && s.lastError) {
    detail = `: ${s.lastError.class}: ${s.lastError.message}`;
  } else if (t.kind !== "started" && s.headline !== "") {
    detail = `: ${s.headline}`;
  }
  const data: Record<string, unknown> = { status: s.status };
  const run = knownRun(thread);
  if (run) data.runId = run;
  if (t.late) data.late = true;
  if (s.lastError && t.kind !== "completed") data.error = { class: s.lastError.class, message: jsPrefix(s.lastError.message, 500) };
  if (s.usageLimitResetAt !== undefined) data.usageLimitResetAt = s.usageLimitResetAt;
  // Why the run ended: what tells a node going away from a person stopping it.
  if (s.endCause !== undefined && t.kind !== "started" && t.kind !== "waiting") {
    data.endCause = s.endCause;
    // Which steer's run took over: the tasks area sends that steer again if it never ran.
    if (s.endCause === "superseded" && thread.supersededBy !== undefined) data.supersededBy = thread.supersededBy;
  }
  // What the approvals area opens an approval request from.
  if (t.kind === "waiting" && thread.pending) {
    data.permission = { requestId: thread.pending.requestId, toolName: thread.pending.toolName, summary: thread.pending.summary };
  }
  if (limit) Object.assign(data, limitData(limit));
  return {
    at: s.lastProgressAt,
    type: EVENT_TYPE[t.kind],
    machineId,
    projectId: s.projectId,
    threadId: s.threadId,
    summary: jsPrefix(`"${s.title}" on ${machineId} ${VERB[t.kind]}${detail}`, 200),
    data,
  };
}
