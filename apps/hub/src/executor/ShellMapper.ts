// Pure mapping from T3 shell stream items to the hub's thread/project caches and derived events.
// The executor feeds every item through `applyShellItem`; nothing here does I/O.
import {
  type HubEvent,
  type HubEventType,
  type MachineId,
  ProjectId,
  type ProjectSummary,
  ThreadId,
  type ThreadStatus,
  type ThreadSummary,
} from "@fleetd/contracts";
import type { OrchestrationV2ShellStreamItem, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { StoredThread } from "../store/HubStore.ts";
import { limitData, limitOfSummary } from "../usage/classify.ts";

export interface TrackedThread {
  readonly summary: ThreadSummary;
  /** T3's latest run; a new one in the same phase is still a transition. Unknown after a hub restart. */
  readonly runId: string | null | undefined;
  readonly activeRunId: string | null;
  /** The active run is still being prepared or started, so a message sent now is queued behind it. */
  readonly activeRunStarting: boolean;
}

interface ProjectMeta {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
}

/** One machine's view of T3's shell. Holds shell rows only, never transcripts. */
export interface ShellState {
  cursor: number | undefined;
  /** True once an authoritative snapshot has been applied, so every active thread is in `threads`. */
  complete: boolean;
  readonly projects: Map<string, ProjectMeta>;
  readonly threads: Map<string, TrackedThread>;
}

export const emptyShellState = (): ShellState => ({
  cursor: undefined,
  complete: false,
  projects: new Map(),
  threads: new Map(),
});

export interface Transition {
  readonly type: HubEventType;
  readonly threadId: ThreadId;
  /** The run ended while the hub was down: found by diffing a snapshot against the stored row. */
  readonly late?: true;
}

export interface Applied {
  /** Changed thread summaries, to upsert. */
  readonly threads: ReadonlyArray<StoredThread>;
  /** Projects whose metadata or thread counts changed, to upsert. */
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly transitions: ReadonlyArray<Transition>;
  /** Set when the item moved the shell cursor. */
  readonly cursor: number | undefined;
}

export interface ApplyContext {
  readonly machineId: MachineId;
  readonly now: string;
  /** Stored summaries for threads not yet in memory (after a hub restart). */
  readonly stored: ReadonlyMap<string, StoredThread>;
  /** No cursor was ever stored for this machine: its first snapshot is a baseline and emits nothing. */
  readonly baseline: boolean;
}

const iso = (dt: DateTime.DateTime | null | undefined) => (dt == null ? undefined : DateTime.formatIso(dt));

/** T3 reports "waiting" for more than approvals, so only a pending runtime request counts as waiting on a human. */
export const threadStatus = (shell: OrchestrationV2ThreadShell): ThreadStatus => {
  switch (shell.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return shell.pendingRuntimeRequest !== null ? "waiting" : "running";
    case "rolled_back":
      return "cancelled";
    default:
      return shell.status;
  }
};

const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.slice(0, 280);
const tail = (text: string, max: number) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`);

/** Applies the latest visible assistant text (T3's shell rows carry none, so it comes from a thread read). */
export const withAssistantText = (summary: ThreadSummary, text: string | undefined): ThreadSummary =>
  text === undefined || text.trim() === ""
    ? summary
    : { ...summary, headline: firstLine(text), latestMessageTail: tail(text, 4096) };

export const toThreadSummary = (
  machineId: MachineId,
  shell: OrchestrationV2ThreadShell,
  prev: ThreadSummary | undefined,
  now: string,
): ThreadSummary => {
  const effort = shell.modelSelection.options?.find((o) => o.id === "effort")?.value;
  const resetAt = shell.lastErrorClass === "usage_limit" ? shell.usageLimitResetAt : undefined;
  const base: ThreadSummary = {
    machineId,
    threadId: ThreadId.make(shell.id),
    projectId: ProjectId.make(shell.projectId),
    title: shell.title,
    status: threadStatus(shell),
    headline: prev?.headline ?? "",
    latestMessageTail: prev?.latestMessageTail ?? "",
    ...(shell.lastError ? { lastError: { class: shell.lastErrorClass ?? "unknown", message: shell.lastError.slice(0, 2000) } } : {}),
    ...(resetAt ? { usageLimitResetAt: resetAt } : {}),
    lastProgressAt: iso(shell.updatedAt)!,
    model: shell.modelSelection.model,
    ...(typeof effort === "string" ? { effort } : {}),
    stale: false,
    asOf: now,
  };
  const latest = shell.latestVisibleMessage;
  return latest?.role === "assistant" ? withAssistantText(base, latest.text) : base;
};

type Phase = ThreadStatus | "usage_limited";
/** M4: a failure T3 calls usage_limit, or whose text is a 429, a usage limit or an exhausted proxy, is a usage limit. */
export const phase = (s: ThreadSummary): Phase => (limitOfSummary(s) !== undefined ? "usage_limited" : s.status);

const EVENT_FOR: Partial<Record<Phase, HubEventType>> = {
  running: "thread.started",
  waiting: "thread.waiting",
  completed: "thread.completed",
  failed: "thread.failed",
  interrupted: "thread.interrupted",
  usage_limited: "thread.usage_limited",
};

/** The event a change from `prev` to `next` produces, if any. Unchanged phase and run produce none. */
export const transition = (
  prev: { readonly summary: ThreadSummary; readonly runId: string | null | undefined } | undefined,
  next: { readonly summary: ThreadSummary; readonly runId: string | null | undefined },
): HubEventType | undefined => {
  const to = phase(next.summary);
  if (prev === undefined) return EVENT_FOR[to];
  const from = phase(prev.summary);
  const newRun = prev.runId != null && next.runId != null && prev.runId !== next.runId;
  if (from === to && !newRun) return undefined;
  // An approval being answered resumes the same run; that is not a new start.
  if (from === "waiting" && to === "running" && !newRun) return undefined;
  return EVENT_FOR[to];
};

const TERMINAL = new Set<HubEventType>(["thread.completed", "thread.failed", "thread.interrupted", "thread.usage_limited"]);

const sameSummary = (a: ThreadSummary, b: ThreadSummary) =>
  JSON.stringify({ ...a, asOf: "" }) === JSON.stringify({ ...b, asOf: "" });

const bucket = (s: ThreadStatus): keyof ProjectSummary["threads"] =>
  s === "running" ? "running" : s === "waiting" ? "waiting" : s === "failed" ? "failed" : "idle";

export const projectSummary = (state: ShellState, machineId: MachineId, projectId: string): ProjectSummary | undefined => {
  const meta = state.projects.get(projectId);
  if (meta === undefined) return undefined;
  const threads = { running: 0, waiting: 0, idle: 0, failed: 0 };
  let lastActivityAt = meta.updatedAt;
  for (const t of state.threads.values()) {
    if (t.summary.projectId !== projectId) continue;
    threads[bucket(t.summary.status)]++;
    if (t.summary.lastProgressAt > lastActivityAt) lastActivityAt = t.summary.lastProgressAt;
  }
  return { machineId, projectId: ProjectId.make(projectId), title: meta.title, workspaceRoot: meta.workspaceRoot, threads, lastActivityAt };
};

/** Mutates `state` with one shell stream item and reports what changed. */
export const applyShellItem = (state: ShellState, item: OrchestrationV2ShellStreamItem, ctx: ApplyContext): Applied => {
  const threads: StoredThread[] = [];
  const transitions: Transition[] = [];
  const touched = new Set<string>();
  let cursor: number | undefined;
  const advance = (seq: number) => {
    if (state.cursor === undefined || seq > state.cursor) state.cursor = cursor = seq;
  };

  /**
   * `quietIfNew`: a thread seen for the first time produces no event (a baseline snapshot).
   * `restart`: the first snapshot in this hub process, diffed against what an earlier one stored.
   */
  const upsertThread = (shell: OrchestrationV2ThreadShell, sequence: number | undefined, quietIfNew: boolean, restart = false) => {
    const known = state.threads.get(shell.id);
    const stored = known === undefined ? ctx.stored.get(shell.id) : undefined;
    const prev = known ?? (stored ? { summary: stored, runId: stored.lastRunId } : undefined);
    const summary = toThreadSummary(ctx.machineId, shell, prev?.summary, ctx.now);
    const next: TrackedThread = {
      summary,
      runId: shell.latestRunId,
      activeRunId: shell.activeRunId,
      activeRunStarting: ["preparing", "queued", "starting"].includes(shell.activityRunStatus ?? shell.status),
    };
    state.threads.set(shell.id, next);
    if (known && known.summary.projectId !== summary.projectId) touched.add(known.summary.projectId);
    touched.add(summary.projectId);
    const runStatus = phase(summary);
    const runChanged = stored !== undefined && (stored.lastRunId !== (next.runId ?? undefined) || stored.lastRunStatus !== runStatus);
    if (prev === undefined || runChanged || prev.runId !== next.runId || !sameSummary(prev.summary, summary)) {
      threads.push({
        ...summary,
        ...(sequence === undefined ? {} : { lastSequence: sequence }),
        ...(next.runId == null ? {} : { lastRunId: next.runId }),
        lastRunStatus: runStatus,
      });
    }
    const type = quietIfNew && prev === undefined ? undefined : transition(prev, next);
    if (type !== undefined) {
      // Anything a restart snapshot reveals happened while the hub was down.
      const late = restart && known === undefined && TERMINAL.has(type);
      transitions.push({ type, threadId: summary.threadId, ...(late ? { late: true } : {}) });
    }
  };

  const dropThread = (threadId: string) => {
    const known = state.threads.get(threadId);
    if (known === undefined) return;
    state.threads.delete(threadId);
    touched.add(known.summary.projectId);
  };

  switch (item.kind) {
    case "synchronized":
      break;
    case "snapshot": {
      const snap = item.snapshot;
      for (const p of snap.projects) {
        state.projects.set(p.id, { title: p.title, workspaceRoot: p.workspaceRoot, updatedAt: p.updatedAt });
        touched.add(p.id);
      }
      // A snapshot that names resolved repository roots is only a project metadata refresh: it lists some
      // projects and no threads, and its sequence can be ahead of a replay that follows it.
      if (item.resolvedRepositoryIdentityRoots !== undefined) break;
      const baseline = ctx.baseline && !state.complete;
      const restart = !ctx.baseline && !state.complete;
      const present = new Set<string>(snap.threads.map((t) => t.id));
      for (const id of state.threads.keys()) if (!present.has(id)) dropThread(id);
      for (const id of state.projects.keys()) if (!snap.projects.some((p) => p.id === id)) state.projects.delete(id);
      for (const shell of snap.threads) upsertThread(shell, undefined, baseline, restart);
      state.complete = true;
      advance(snap.snapshotSequence);
      break;
    }
    case "project.updated":
      state.projects.set(item.project.id, {
        title: item.project.title,
        workspaceRoot: item.project.workspaceRoot,
        updatedAt: item.project.updatedAt,
      });
      touched.add(item.project.id);
      advance(item.sequence);
      break;
    case "project.removed":
      state.projects.delete(item.projectId);
      advance(item.sequence);
      break;
    case "thread.updated":
      if (item.location === "archive" || item.thread.deletedAt !== null) dropThread(item.thread.id);
      else upsertThread(item.thread, item.sequence, false);
      advance(item.sequence);
      break;
    case "thread.removed":
      dropThread(item.threadId);
      advance(item.sequence);
      break;
  }

  const projects = [...touched].flatMap((id) => {
    const p = projectSummary(state, ctx.machineId, id);
    return p ? [p] : [];
  });
  return { threads, projects, transitions, cursor };
};

const VERB: Record<string, string> = {
  "thread.started": "started",
  "thread.completed": "completed",
  "thread.failed": "failed",
  "thread.interrupted": "was interrupted",
  "thread.waiting": "is waiting for approval or input",
  "thread.usage_limited": "hit the usage limit",
};

/** The HubEvent for a transition, in plain language. EventLog trims summary and data to their limits. */
export const transitionEvent = (
  t: Transition,
  thread: TrackedThread,
  machineId: MachineId,
): Omit<HubEvent, "seq"> => {
  const s = thread.summary;
  const limit = t.type === "thread.usage_limited" ? limitOfSummary(s) : undefined;
  const detail =
    limit !== undefined
      ? limit.class === "pool_exhausted"
        ? `: your proxy has no account available for ${limit.model ?? s.model ?? "the model"}`
        : limit.resumeAt === undefined ? "" : ` (resets ${limit.resumeAt})`
      : t.type === "thread.failed" && s.lastError
        ? `: ${s.lastError.class}: ${s.lastError.message}`
        : t.type !== "thread.started" && s.headline !== ""
          ? `: ${s.headline}`
          : "";
  return {
    at: s.lastProgressAt,
    type: t.type,
    machineId,
    projectId: s.projectId,
    threadId: s.threadId,
    summary: `"${s.title}" on ${machineId} ${VERB[t.type]}${detail}`.slice(0, 200),
    data: {
      status: s.status,
      ...(thread.runId ? { runId: thread.runId } : {}),
      ...(t.late ? { late: true } : {}),
      ...(s.lastError && t.type !== "thread.completed" ? { error: { class: s.lastError.class, message: s.lastError.message.slice(0, 500) } } : {}),
      ...(s.usageLimitResetAt ? { usageLimitResetAt: s.usageLimitResetAt } : {}),
      ...(limit === undefined ? {} : limitData(limit)),
    },
  };
};
