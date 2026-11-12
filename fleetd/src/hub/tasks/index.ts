// The tasks area (sweep.rs, cap.rs): a lead's agents, from spawn to their end.
// Every state change goes through one lock, so a release, a completion and a lead call never interleave. A start lets
// it go while the node launches or continues its task (`go`), and its task is `starting` until that is recorded.
//
// The seam: `tasks(hub)` is `hub.area("tasks")`; the train spawns its reviewers through `spawn`, `message` and
// `cancel`, with a caller `{ projectRef, by }`.
import type {
  HubEvent,
  HubEventType,
  MachineId,
  ProjectRef,
  ProjectRepo,
  RepoId,
  Task,
  TaskId,
  TaskRecovery,
  TaskResult,
  TaskResultStatus,
  TaskState,
  ThreadRef,
  Workstream,
  WorkstreamId,
  WorkScope,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { RESUME_REFUSED, type WorktreeBase } from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";
import type { Hub } from "../api/hub.ts";
import { sendRunId } from "../executor/sessions.ts";
import { checkFanOut } from "../lead_calls/policy.ts";
import { Memory, youForTask } from "../memory/index.ts";
import { archived } from "../navi/store.ts";
import { prompts } from "../prompts/store.ts";
import * as repos from "../repos/store.ts";
import { type Grant, priorityOf, type SlotRequest, slots } from "../slots/index.ts";
import { events, type NewEvent } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, parseMs } from "../store/time.ts";
import * as baseOf from "./base.ts";
import { Breakers, type Opened, type Paused, QUIET_MS, WINDOW_MS } from "./breaker.ts";
import * as duplicates from "./duplicates.ts";
import { Lock, Notify } from "./lock.ts";
import { type BranchPrError, holdsPr, shortRemote, taskPrUrl } from "./pr.ts";
import { openCiWaits } from "./ci_wait.ts";
import {
  hubTaskPorts,
  type HeldSteer,
  type Observed,
  portError,
  type Rebuilt,
  type TaskPorts,
} from "./ports.ts";
import { type StoredTask, type TaskFilter, TaskRecords } from "./records.ts";
import * as recovery from "./recovery.ts";
import {
  branchFor,
  fullResultText,
  briefText,
  GITHUB_BACK,
  GITHUB_DOWN,
  oneLine,
  renderTaskPrompt,
  resultText,
  runsOn as runsOnLine,
  TAIL_MAX,
  tailOf,
  taskDigestLines,
  taskMessageNotSentLines,
  taskPrLines,
  taskPrSkippedLines,
  taskRecoveredLines,
  taskResultLines,
  taskUnreachableLines,
  taskWaitingLines,
} from "./render.ts";
import { resolveProfile } from "./resolve.ts";
import { clockTime, END_EVENTS, list, ORPHAN_MS, pausedLines, renderSummary, storedEvent, syntheticEnd, type Unowned } from "./sweep.ts";
import { requestId, StartError, withPending } from "./launch.ts";

/** Who asks: the project's lead, as the lead-call handler attributes it. */
export type TaskCaller = { projectRef: ProjectRef; by: string };

/** `TaskSpawnCall` without its `op`. */
export type SpawnInput = {
  workstreamId: WorkstreamId;
  title: string;
  kind: Task["kind"];
  prompt: string;
  profile?: string;
  qa?: boolean;
  pr?: string;
  paths?: string[];
  repo?: string;
  notDuplicateOf?: string[];
  notDuplicateWhy?: string;
};

/** A spawn's task, with what its duplicate check says and the writers' changed paths it gathered. */
export type Spawned = { task: Task; note?: string; observed: Observed };

const THREAD_EVENTS: HubEventType[] = [
  "thread.started",
  "thread.waiting",
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
  "thread.usage_limited",
  // M4 usage: a lifted pause lets queued tasks start.
  "usage.resumed",
  // The disk guard: the same, for a machine with room again.
  "machine.guard",
  // A merged writer's worktree goes.
  "pr.merged",
  // PR lookups the machine's absence held up run again.
  "machine.online",
];

/** What a task whose context is full is sent first: claude's own compaction of its conversation. */
const COMPACT = "/compact";
/** How much of the earlier thread's last words a fresh thread's handoff carries. */
const HANDOFF_TAIL = 1500;
/** The most each node read for a handoff may take. */
const HANDOFF_STEP_TIMEOUT_MS = 20_000;
/** How long a run a task was continued in may take to show up before the ends of other runs count again. */
const CONTINUED_RUN_WAIT_MS = 2 * 60 * 1000;
const ALSO_WRITING_MAX = 10;
/** How long a spawn waits to read an unrecorded project's repo and base before it goes on without the check. */
const BIND_WAIT_MS = 3_000;
/** How long a spawn waits for a node to say what its writers changed. */
const OBSERVE_TIMEOUT_MS = 3_000;
const ALSO_WRITING_PATHS = 5;
const LIVE_TASKS: TaskState[] = ["queued", "running", "idle"];
const SCAN_LIMIT = 10_000;
/** Each step of a finished task's PR lookup: reading its report, its `origin`, the host. */
const PR_LOOKUP_TIMEOUT_MS = 60_000;
/** How often pending PR lookups run again, and when one with no answer yet is given up on. */
export const PR_LOOKUP_RETRY_MS = 5 * 60_000;
const PR_LOOKUP_GIVE_UP_MS = 24 * 3600_000;

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;
const projectKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;
const threadKey = (r: ThreadRef) => `${r.machineId}/${r.threadId}`;
const sameThread = (a: ThreadRef | undefined, b: ThreadRef) => a !== undefined && a.machineId === b.machineId && a.threadId === b.threadId;


const leadError = (code: ConstructorParameters<typeof ToolError>[0], message: string, fix?: string) => new ToolError(code, message, fix);

/** Store failures refuse the call plainly and are logged. */
function storeError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  console.error("tasks: store failed:", error);
  return leadError("failed", "The hub failed to answer that request.", "Retry; if it keeps failing, check the hub's log.");
}

/** The node's answer to a start, as `go` records it. */
type Launched = { thread: ThreadRef; branch?: string; base?: WorktreeBase };

/** A start `reserve` took the slot for, which `go` sends to the node off the lock. */
type Start = {
  stored: StoredTask;
  fromQueue: boolean;
  /** A fresh restart's handoff. */
  handoff?: string;
  recovering: boolean;
  fresh: boolean;
  compact: boolean;
  /** It goes on in its thread, with the pending message or the recovery's note. */
  continuing: boolean;
};

/** What `reserve` decided: the task as it stays now, or a start for `go`. */
type Reserved = { now: Task } | { go: Start };

type Sent = { started: Launched | StartError; doing: string; rebuiltBefore?: Rebuilt };

/** A writer's settled PR lookup: its PR, or why the host refused it. */
type Lookup = { pr?: string; skipped?: string };

/** Where a writer's spawn checks for duplicates. */
type SpawnScope = { kind: "bound"; scope: WorkScope } | { kind: "no_repo" } | { kind: "binding" };

const queuedReasonText = (reason: string) => jsPrefix(reason, 200);

/** Resolves with `p`, or undefined once `ms` passed. */
function within<T>(ms: number, p: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const spawnInBackground = (what: string, p: Promise<unknown>) => {
  p.catch((error) => console.warn(`tasks: ${what} failed:`, error));
};

export class Tasks {
  private readonly lock = new Lock();
  /** Tasks whose start is with the node, off the lock: nothing else changes them until it is recorded. */
  private readonly starting = new Set<TaskId>();
  /** Told each time a start is recorded. */
  private readonly started = new Notify();
  /** Thread events held back for starts in flight, in the order they came. */
  private held: HubEvent[] = [];
  /** Machines a queued task waits on; one waiter each. */
  private readonly awaiting = new Set<MachineId>();
  /** Tasks whose `ask_lead` question their lead hasn't answered yet. */
  private readonly asking = new Set<TaskId>();
  /** Tasks whose `ask_lead` question no message has answered yet, with when they asked. Unlike `asking` it outlives the
   * run's end: a finished agent that waits on an answer is the one another agent's message may continue. */
  private readonly asked = new Map<TaskId, number>();
  /** Tasks continued in their thread whose new run the hub hasn't seen yet: that run's id and when it was sent. */
  private readonly continuing = new Map<TaskId, [string, number]>();
  /** Tasks a run's end ended whose claude the node is still stopping. */
  private readonly stopping = new Set<TaskId>();
  /** Projects whose repo and base a spawn is reading from their root. */
  private readonly binding = new Set<string>();
  /** Running tasks whose lead was told their machine is away: the machine and the start of that spell. */
  private readonly unreachableTold = new Map<TaskId, [MachineId, string]>();
  /** Tasks fleetd resumed whose new run hasn't started yet: what the dead run was doing, and its last rebuild. */
  private readonly resumed = new Map<TaskId, [string, Rebuilt | undefined]>();
  /** Fresh restarts' handoffs by task, for the attempt they were gathered for: undefined while it runs. */
  private readonly handoffs = new Map<TaskId, [number, string | undefined]>();
  /** Per machine: whether its agents keep dying, so their resumes wait. */
  private readonly breakers = new Breakers();
  /** Sessions the sweep found that no task or lead owns: when it first did, whether it reported them. */
  private readonly unowned = new Map<string, [ThreadRef, number, boolean]>();
  /** Tasks whose PR lookup runs now. */
  private readonly lookingUp = new Set<TaskId>();
  private readonly cursor: number;
  /** The last thread event applied, by the follower or by a retry catching up. */
  private applied: number;

  constructor(
    readonly hub: Hub,
    readonly ports: TaskPorts = hubTaskPorts(hub),
  ) {
    // Read here, not in `run`, so nothing appended before `run` first waits is missed.
    this.cursor = events(hub).head();
    this.applied = this.cursor;
  }

  private get db() {
    return this.hub.db.conn;
  }

  private now(): number {
    return this.hub.clock.now();
  }

  nowIso(): string {
    return isoMs(this.now());
  }

  /**
   * Registers the slot release listener (which also runs once now, picking up tasks queued before a restart), then
   * follows thread events and runs the pending PR lookups again every PR_LOOKUP_RETRY_MS, until the hub stops.
   */
  async run(): Promise<void> {
    const signal = this.hub.shutdown.signal;
    try {
      const off = slots(this.hub).onRelease(() => this.retryLater());
      signal.addEventListener("abort", off, { once: true });
    } catch (error) {
      console.error("tasks: slot listener not registered:", error);
    }
    // Recoveries a restart cut short still go at their time, unless their machine's breaker holds them.
    this.restoreBreakers();
    for (const stored of this.tryDb(() => TaskRecords.queued(this.db)) ?? []) this.resumeAt(stored.task.recovery);
    const retry = async () => {
      while (!signal.aborted) {
        this.resumePrLookups(undefined);
        await sleep(PR_LOOKUP_RETRY_MS, signal);
      }
    };
    await Promise.race([this.follow(this.cursor, signal), retry()]);
  }

  private tryDb<T>(f: () => T): T | undefined {
    try {
      return f();
    } catch (error) {
      console.warn("tasks: store read failed:", error);
      return undefined;
    }
  }

  private put(stored: StoredTask): void {
    TaskRecords.put(this.db, stored);
  }

  private emit(task: Task, type: HubEventType, summary: string, extra: Record<string, unknown> = {}): void {
    const data: Record<string, unknown> = { taskId: task.taskId, workstreamId: task.workstreamId, createdAt: task.createdAt };
    if (task.branch !== undefined) data.branch = task.branch;
    Object.assign(data, extra);
    events(this.hub).append({
      at: this.nowIso(),
      type,
      machineId: task.projectRef.machineId,
      projectId: task.projectRef.projectId,
      ...(task.threadRef ? { threadId: task.threadRef.threadId } : {}),
      summary,
      data,
    } as NewEvent);
  }

  private releaseAll(task: Task): void {
    this.asking.delete(task.taskId);
    this.handoffs.delete(task.taskId);
    this.continuing.delete(task.taskId);
    this.resumed.delete(task.taskId);
    slots(this.hub).release(task.taskId);
    this.breakers.release(task.taskId);
  }

  /** `escalated`: its run died and was not resumed. */
  private wakeResult(task: Task, result: TaskResult, escalated: boolean): void {
    this.ports.wake(task.projectRef, "task_result", taskResultLines(task.taskId, task.title, result, escalated));
  }

  private workstream(id: WorkstreamId): Workstream | undefined {
    return this.ports.workstream(id);
  }

  /** `kind` says what it waits for (`offline`, `usage`, `slot`) for the time inspector's queue spans. */
  private queue(stored: StoredTask, kind: string, reason: string): Task {
    const task = stored.task;
    if (task.state === "queued" && task.queuedReason === queuedReasonText(reason)) return { ...task };
    const next: Task = { ...task, state: "queued", queuedReason: queuedReasonText(reason) };
    this.put({ task: next, ...(stored.pendingMessage !== undefined ? { pendingMessage: stored.pendingMessage } : {}) });
    this.emit(next, "task.queued", `${task.taskId} queued: ${reason}`, { queuedReason: reason, queuedKind: kind });
    return next;
  }

  /**
   * The task's new thread, its branch, and where the branch started. `handoff`: a fresh restart, which takes over the
   * task's thread and its worktree, and whose agent gets the handoff after its brief.
   */
  private async launch(task: Task, handoff: string | undefined): Promise<Launched> {
    const r = task.projectRef;
    // Its worktree, branch and setup are its repo's: the work runs in the repo's checkout (W79).
    const repo = this.repoOf(task);
    const checkout = repo?.checkout ?? r;
    const gone = (p: ProjectRef) => new StartError(false, `No project ${p.projectId} on machine ${p.machineId}.`);
    const project = store(this.hub).projectGet(r);
    if (!project) throw gone(r);
    let workspaceRoot = project.workspaceRoot;
    if (!sameProject(checkout, r)) {
      const p = store(this.hub).projectGet(checkout);
      if (!p) throw gone(checkout);
      workspaceRoot = p.workspaceRoot;
    }
    // Its rules are its checkout's.
    const policy = await this.ports.policy(checkout);
    const brief = this.workstream(task.workstreamId)?.brief;
    const write = task.kind === "write";
    // Every task gets a worktree of its own from the default branch, a writer's on its branch and a reader's
    // detached. A reader still runs in the checkout on a node too old for a detached workspace.
    const detached = this.ports.detachedWorktrees(checkout.machineId);
    const baseBranch = write || detached ? await this.ports.defaultBranch(checkout.machineId, workspaceRoot) : undefined;
    // In another repo it needs a worktree of its own.
    if (repo && baseBranch === undefined) {
      throw new StartError(
        false,
        write || detached ? `repo ${repo.name} has no commits yet` : `update ${checkout.machineId} to run agents in other repos`,
      );
    }
    if (write && baseBranch === undefined) throw new StartError(false, `no branch with a commit at ${workspaceRoot}`);
    const branch = write ? branchFor(policy.branchPrefix, task.taskId, task.title) : undefined;
    const elsewhere = write ? this.elsewhereFor(task) : [];
    const set = prompts(this.hub.db).current(r);
    // A writer gets the memory of whoever started its order (a Navi's owner); a reader none.
    let memory = "";
    if (write) {
      try {
        memory = Memory.of(this.hub).injected(r, false, youForTask(this.hub.db, r, task.workstreamId));
      } catch (error) {
        console.warn("tasks: memory not read for the brief:", error);
      }
    }
    const decisions = brief ? this.ports.decisionsCited(r, briefText(brief)) : [];
    const rendered = renderTaskPrompt(set, {
      task,
      projectTitle: project.title,
      ...(brief ? { brief, doneWhen: this.ports.doneWhenText(brief) } : {}),
      decisions,
      ...(branch !== undefined ? { branch } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      elsewhere,
      memory,
    });
    let prompt = rendered.first;
    if (handoff !== undefined) prompt = `${prompt}\n\n${handoff}`;
    const from = handoff !== undefined ? task.threadRef?.threadId : undefined;
    const { threadId, base } = await this.ports.launch(checkout.machineId, {
      projectId: checkout.projectId,
      projectRef: r,
      ...(task.repoId !== undefined ? { repoId: task.repoId } : {}),
      prompt,
      ...(rendered.system !== "" ? { systemPrompt: rendered.system } : {}),
      profile: task.profile ?? "high",
      title: jsPrefix(`${task.taskId}: ${task.title}`, 80),
      // The node's launch is idempotent on the request id, so a retried launch returns the same thread.
      clientRequestId: requestId(task, [String(task.attempt)]),
      kind: task.kind,
      ...(baseBranch !== undefined
        ? {
            worktree: {
              baseRef: baseBranch,
              ...(branch !== undefined ? { branch } : {}),
              ...(task.pr !== undefined ? { pr: task.pr } : {}),
              ...(from !== undefined ? { from } : {}),
            },
          }
        : {}),
      orderId: task.workstreamId,
    });
    // Every later message to this thread renders from the texts it starts with. The thread runs either way.
    try {
      prompts(this.hub.db).pin(set, "task", r, threadId, this.nowIso(), [rendered.system, prompt].filter((t) => t !== "").join("\n\n"));
    } catch (error) {
      console.warn(`task prompts not pinned (${task.taskId}):`, error);
    }
    return { thread: { machineId: checkout.machineId, threadId }, ...(branch !== undefined ? { branch } : {}), ...(base ? { base } : {}) };
  }

  private failToStart(stored: StoredTask, message: string, fromQueue: boolean): Task {
    const task = stored.task;
    const at = this.nowIso();
    const result: TaskResult = {
      status: "failed",
      tail: tailOf(`fleetd could not start the task: ${message}`, TAIL_MAX),
      ...(task.branch !== undefined ? { branch: task.branch } : {}),
      endCause: "failed",
      at,
    };
    const { queuedReason: _q, ...rest } = task;
    const next: Task = { ...rest, state: "failed", result, endedAt: at };
    this.put({ task: next });
    this.releaseAll(task);
    // A direct call gets this in its reply; a task started from the queue has nobody waiting on it.
    if (fromQueue) this.wakeResult(next, result, false);
    this.emit(next, "task.failed", `${task.taskId} failed to start: ${message}`);
    return next;
  }

  private retryWhenLive(machineId: MachineId): void {
    if (this.awaiting.has(machineId)) return;
    this.awaiting.add(machineId);
    spawnInBackground(
      "a queue retry once a machine is back",
      (async () => {
        await this.ports.awaitLive(machineId, this.hub.shutdown.signal);
        this.awaiting.delete(machineId);
        if (this.hub.shutdown.signal.aborted) return;
        await this.lock.with(async () => {
          // A node back from a stop reports the runs it cut off: apply those first, while their tasks still wait.
          await this.catchUp();
          await this.retryQueue();
        });
      })(),
    );
  }

  /** Runs the queue again soon, off the caller: a machine's node caught up. */
  retrySoon(): void {
    this.retryLater();
  }

  private retryLater(): void {
    spawnInBackground(
      "a queue retry",
      this.lock.with(async () => {
        // The slot board follows thread events on its own: apply those first, so `task.completed` precedes the
        // next start.
        await this.catchUp();
        await this.retryQueue();
      }),
    );
  }

  /** Applies every thread event appended since the last one applied. Call with the lock held. */
  private async catchUp(): Promise<void> {
    for (;;) {
      let page: Awaited<ReturnType<ReturnType<typeof events>["wait"]>>;
      try {
        page = await events(this.hub).wait({ cursor: this.applied, types: THREAD_EVENTS, timeoutSec: 0 });
      } catch {
        return;
      }
      for (const event of page.events) await this.apply(event);
      this.applied = Math.max(this.applied, page.cursor);
      if (!page.more) return;
    }
  }

  /** One thread event, once: the follower and `catchUp` both pass every event here. Call with the lock held. */
  private async apply(event: HubEvent): Promise<void> {
    if (event.seq <= this.applied) return;
    if (this.heldBack(event)) this.held.push(event);
    else {
      try {
        await this.onThreadEvent(event);
      } catch (error) {
        console.warn(`task event not handled (seq ${event.seq}):`, error);
      }
    }
    this.applied = event.seq;
  }

  /** Whether a thread event waits for a start in flight: of a starting task's thread, or of a thread no task has yet. */
  private heldBack(event: HubEvent): boolean {
    if (
      this.starting.size === 0 ||
      event.type === "usage.resumed" ||
      event.type === "machine.guard" ||
      event.type === "pr.merged" ||
      event.type === "machine.online"
    ) {
      return false;
    }
    if (event.machineId === undefined || event.threadId === undefined) return false;
    try {
      const stored = TaskRecords.byThread(this.db, { machineId: event.machineId, threadId: event.threadId });
      return stored ? this.starting.has(stored.task.taskId) : true;
    } catch {
      return false;
    }
  }

  /** Applies the events held back that no start in flight holds any more. Call with the lock held. */
  private async replay(): Promise<void> {
    const held = this.held;
    this.held = [];
    for (const event of held) {
      if (this.heldBack(event)) this.held.push(event);
      else {
        try {
          await this.onThreadEvent(event);
        } catch (error) {
          console.warn(`task event not handled (seq ${event.seq}):`, error);
        }
      }
    }
  }

  /** The lock, once `taskId`'s start in flight, if any, is recorded. */
  private lockTask(taskId: TaskId): Promise<() => void> {
    return this.lockWhen((starting) => !starting.has(taskId));
  }

  /** The lock, with no start in flight. */
  lockSettled(): Promise<() => void> {
    return this.lockWhen((starting) => starting.size === 0);
  }

  private async lockWhen(ready: (starting: Set<TaskId>) => boolean): Promise<() => void> {
    for (;;) {
      const release = await this.lock.acquire();
      // Taken under the lock, so the next record, which tells under it, isn't missed.
      const started = this.started.notified();
      if (ready(this.starting)) return release;
      release();
      await started;
    }
  }

  /** A slot, then the launch or the pending message; queues with the first reason it cannot go. Call with the lock. */
  private tryStart(stored: StoredTask, fromQueue: boolean): Task {
    try {
      const reserved = this.reserve(stored, fromQueue);
      if ("now" in reserved) return reserved.now;
      spawnInBackground(`${stored.task.taskId}'s start`, this.go(reserved.go));
      return stored.task;
    } catch (error) {
      console.warn(`task start failed (${stored.task.taskId}):`, error);
      return stored.task;
    }
  }

  /** `tryStart` for a lead's call, which waits for the start: `release` lets the lock go while the node works. */
  private async startNow(release: () => void, stored: StoredTask, fromQueue: boolean): Promise<Task> {
    let reserved: Reserved;
    try {
      reserved = this.reserve(stored, fromQueue);
    } catch (error) {
      release();
      console.warn(`task start failed (${stored.task.taskId}):`, error);
      return stored.task;
    }
    release();
    if ("now" in reserved) return reserved.now;
    try {
      return await this.go(reserved.go);
    } catch (error) {
      console.warn(`task start failed (${stored.task.taskId}):`, error);
      return stored.task;
    }
  }

  /** Waits until no start is in flight (tests). */
  async startsRecorded(): Promise<void> {
    (await this.lockSettled())();
  }

  /** A start's first part, under the lock: every check, then the slot. */
  private reserve(stored: StoredTask, fromQueue: boolean): Reserved {
    // Its start in flight goes on; another adds nothing to it.
    if (this.starting.has(stored.task.taskId)) return { now: stored.task };
    const task = stored.task;
    const r = task.projectRef;
    const machine = this.runsOn(task);
    // Checked before the slot: taking and releasing one would run the queue again at once.
    if (!this.ports.isConnected(machine)) {
      this.retryWhenLive(machine);
      return { now: this.queue(stored, "offline", `machine ${machine} is offline`) };
    }
    // M4 usage: a paused login takes no new turns; usage.resumed runs the queue again.
    const account = this.ports.claudeAccountKey(r, task.workstreamId, machine);
    const usagePaused = this.ports.usageGate(machine, account);
    if (usagePaused !== undefined) return { now: this.queue(stored, "usage", usagePaused) };
    // A recovery due now goes on as its mode says: in its thread, `/compact` first, or in a fresh thread.
    const recovering = task.threadRef !== undefined && task.recovery?.nextAt !== undefined;
    const mode = recovering ? (task.recovery?.mode ?? "resume") : undefined;
    const fresh = mode === "fresh";
    const compact = mode === "compact";
    const continuing = task.threadRef !== undefined && !fresh && (stored.pendingMessage !== undefined || recovering);
    // The claude its last run's end ended is still being stopped: it goes on in its thread once that is done.
    if (continuing && this.stopping.has(task.taskId)) {
      return { now: this.queue(stored, "stopping", "its last run's claude is still stopping") };
    }
    // The disk guard holds new agents only; one with a thread continues in the worktree it has.
    if (!continuing && !fresh) {
      const paused = this.ports.paused(machine);
      if (paused !== undefined) return { now: this.queue(stored, "guard", paused) };
    }
    // A fresh restart's handoff reads the node off the lock: it waits queued until that is in.
    let handoff: string | undefined;
    if (fresh) {
      handoff = this.handoffReady(task);
      if (handoff === undefined) return { now: task };
    }
    const request: SlotRequest = { holder: task.taskId, projectRef: r, priority: priorityOf(task.kind) };
    // A machine at its agent limit queues the task until a slot frees.
    let next: StoredTask = { ...stored, task: { ...task } };
    const grant: Grant = slots(this.hub).acquire(request);
    if (!grant.granted) return { now: this.queue(next, "slot", grant.reason) };
    // A paused agent's thread is still pushing its work: it continues once that turn ended.
    if ((continuing || fresh) && this.asking.has(task.taskId)) return { now: next.task };
    if ((continuing || fresh) && task.threadRef && store(this.hub).threadGet(task.threadRef)?.thread.status === "running") {
      return { now: next.task };
    }
    this.starting.add(task.taskId);
    next = { ...next };
    return { go: { stored: next, fromQueue, ...(handoff !== undefined ? { handoff } : {}), recovering, fresh, compact, continuing } };
  }

  /** The machine the task runs on: its repo checkout's. */
  private runsOn(task: Task): MachineId {
    try {
      return this.checkoutOf(task).machineId;
    } catch {
      return task.projectRef.machineId;
    }
  }

  /** A reserved start's node call, off the lock, then its record under the lock; held events apply after it. */
  private async go(start: Start): Promise<Task> {
    const taskId = start.stored.task.taskId;
    let release: (() => void) | undefined;
    try {
      const sent = await this.sendStart(start);
      release = await this.lock.acquire();
      let task: Task;
      try {
        task = await this.recordStart(start, sent);
      } catch (error) {
        console.warn(`task start failed (${taskId}):`, error);
        task = start.stored.task;
      }
      this.starting.delete(taskId);
      this.started.notifyWaiters();
      await this.replay();
      return task;
    } finally {
      // However its start ends, it is no longer starting, and whoever waits on it is told.
      if (this.starting.delete(taskId)) this.started.notifyWaiters();
      release?.();
    }
  }

  /** What a reserved start has the node do, off the lock: launch the task, or continue its thread with the message. */
  private async sendStart(start: Start): Promise<Sent> {
    const { stored } = start;
    const task = stored.task;
    // What the dead run did last and what its worktree was last rebuilt from: read before the resume adds to them.
    let doing = "";
    let rebuiltBefore: Rebuilt | undefined;
    if (task.threadRef && start.recovering) {
      doing = await this.lastDoing(task.threadRef);
      rebuiltBefore = this.ports.recreatedFrom(task.threadRef);
    }
    // What the recovery says goes first, then anything sent into the gap.
    const pending = (text: string | undefined) => withPending(text, stored.pendingMessage);
    let started: Launched | StartError;
    try {
      if (start.handoff !== undefined) started = await this.launch(task, pending(start.handoff));
      else if (start.continuing) {
        const thread = task.threadRef as ThreadRef;
        // A full context compacts first; the note and anything sent meanwhile follow once that run completed.
        const message = start.compact
          ? COMPACT
          : pending(start.recovering && task.recovery ? this.recoverNote(thread, task.recovery, doing) : undefined);
        const id = requestId(task, [String(task.attempt)]);
        const steer = this.ports.takeHeld(task.taskId, thread, id);
        try {
          if (steer) await this.ports.sendSteer(thread, message, id, steer);
          else await this.ports.send(thread, message, id);
        } catch (error) {
          if (steer) this.ports.rehold(steer.id);
          throw error;
        }
        // The node runs a send under the run id its request id gives.
        this.continuing.set(task.taskId, [sendRunId(thread, id), this.now()]);
        started = { thread };
      } else started = await this.launch(task, undefined);
    } catch (error) {
      started = StartError.of(error);
    }
    return { started, doing, ...(rebuiltBefore ? { rebuiltBefore } : {}) };
  }

  /** A start's last part, under the lock: the task as the node's answer leaves it. */
  private async recordStart(start: Start, sent: Sent): Promise<Task> {
    const { stored, fromQueue, recovering, fresh, compact, continuing } = start;
    const task = stored.task;
    const r = task.projectRef;
    const machine = this.runsOn(task);
    const started = sent.started;
    if (started instanceof StartError) {
      if (started.offline) {
        slots(this.hub).release(task.taskId);
        this.retryWhenLive(machine);
        return this.queue(stored, "offline", `machine ${machine} is offline`);
      }
      // Its thread can't go on (claude's conversation is gone, or its config dir changed): a new one takes over.
      if (continuing && started.message.includes(RESUME_REFUSED)) return this.refused(stored, started.message, fromQueue);
      return this.failToStart(stored, started.message, fromQueue);
    }
    const { thread: threadRef, branch, base } = started;
    const at = this.nowIso();
    const { queuedReason: _q, endedAt: _e, parked: _p, ...rest } = task;
    const next: Task = { ...rest };
    if (fresh && task.threadRef) {
      next.previousThreads = [...(task.previousThreads ?? []), task.threadRef];
      this.handoffs.delete(task.taskId);
    }
    next.threadRef = threadRef;
    if (branch !== undefined) next.branch = branch;
    // Raised once per project while git can't fetch its remote: not again while the last base failed the same way.
    const kind = base ? baseOf.alert(base) : undefined;
    const latest = kind !== undefined ? TaskRecords.latestBase(this.db, r) : undefined;
    const fetchFailed = kind !== undefined && (latest ? baseOf.alert(latest) : undefined) !== kind ? base : undefined;
    // A fresh restart that took over the worktree keeps the base it has: the node reports none for a takeover.
    if (!continuing && (!fresh || base !== undefined)) {
      if (base) next.base = base;
      else delete next.base;
    }
    next.state = "running";
    if (recovering && next.recovery) {
      const { nextAt: _n, ...kept } = next.recovery;
      next.recovery = { ...kept, resumedAt: at };
    }
    next.startedAt = task.startedAt ?? at;
    // From here the board holds the slot while the thread runs and frees it whenever it stops.
    slots(this.hub).bind(task.taskId, threadRef);
    this.put({
      task: next,
      // Held back until the compaction completed.
      ...(compact && stored.pendingMessage !== undefined ? { pendingMessage: stored.pendingMessage } : {}),
    });
    const now = this.nowIso();
    let summary: string;
    if (recovering && next.recovery) {
      const how =
        (next.recovery.mode ?? "resume") === "resume"
          ? "resumed automatically"
          : next.recovery.mode === "compact"
            ? "compacting its full context to resume"
            : "restarted in a fresh thread";
      summary = `${task.taskId} ${how} (attempt ${task.attempt}, ${recovery.used(next.recovery)}): ${task.title}`;
    } else if (continuing) summary = `${task.taskId} continued (attempt ${task.attempt}): ${task.title}`;
    else {
      const based = base ? `; ${baseOf.line(base, now)}` : "";
      summary = `${task.taskId} started (${task.profile ?? "high"}): ${task.title}${based}`;
    }
    this.emit(next, "task.started", summary, base ? { base } : {});
    if (fetchFailed) this.fetchFailed(next, fetchFailed, now);
    // A compaction's lead line goes with the note that follows it.
    if (recovering && !compact) this.resumed.set(task.taskId, [sent.doing, sent.rebuiltBefore]);
    return next;
  }

  /** `project.fetch_failed`: the attention item for a start whose base git couldn't fetch, with the fix. */
  private fetchFailed(task: Task, base: WorktreeBase, now: string): void {
    const r = task.projectRef;
    const project = store(this.hub).projectGet(r)?.title ?? r.projectId;
    const [message, fix] = baseOf.fetchFailedText(project, base, now);
    events(this.hub).append({
      at: now,
      type: "project.fetch_failed",
      machineId: r.machineId,
      projectId: r.projectId,
      ...(task.threadRef ? { threadId: task.threadRef.threadId } : {}),
      summary: message,
      data: { projectRef: r, taskId: task.taskId, base, message, ...(fix !== undefined ? { fix } : {}) },
      attention: "loud",
    } as NewEvent);
  }

  /** The thread's last action, else its headline: what a dead run was doing. */
  private async lastDoing(thread: ThreadRef): Promise<string> {
    return this.doing(thread, await this.lastAction(thread));
  }

  private async lastAction(thread: ThreadRef): Promise<string | undefined> {
    const actions = await this.bounded(this.ports.actionTexts(thread, 1));
    return actions?.[0]?.[0];
  }

  /** `last`, the thread's last action, else its headline. */
  private doing(thread: ThreadRef, last: string | undefined): string {
    let d = last;
    if (d === undefined) {
      const headline = this.tryDb(() => store(this.hub).threadGet(thread))?.thread.headline.trim();
      if (headline) d = headline;
    }
    return d === undefined ? "nothing it said" : oneLine(d, 200);
  }

  /** FIFO over every project's queue; each task is tried once. Call with the lock held. */
  private async retryQueue(): Promise<void> {
    let queued: StoredTask[];
    try {
      queued = TaskRecords.queued(this.db);
    } catch (error) {
      console.warn("tasks: queue not read:", error);
      return;
    }
    const now = this.now();
    this.closeQuietBreakers(now);
    for (let stored of queued) {
      // Its start is with the node already.
      if (this.starting.has(stored.task.taskId)) continue;
      try {
        stored = this.settle(stored);
      } catch (error) {
        console.warn(`tasks: recovery not settled (${stored.task.taskId}):`, error);
      }
      // A recovering task waits out its delay; one its machine's breaker holds waits for that to close.
      if (recovery.waiting(stored.task.recovery, now) || this.held_(stored.task)) continue;
      // One whose order closed or stopped meanwhile takes no slot: the close cancels it.
      const w = this.workstream(stored.task.workstreamId);
      if (w && w.state !== "open") continue;
      // Its work may have ended while it waited: then it isn't resumed, and ends with its run's plain result.
      const recovering = stored.task.recovery?.nextAt !== undefined;
      let over = false;
      if (recovering) {
        try {
          over = this.stopped(stored.task, this.cutOffAt(stored.task));
        } catch {
          over = false;
        }
      }
      if (over) {
        console.info(`recovering task not resumed: its work is over (${stored.task.taskId})`);
        const cause = stored.task.recovery?.lastCause;
        // No resume goes out, so a later continue by the lead is neither labelled one nor counted as one.
        if (stored.task.recovery) {
          const { nextAt: _n, resumedAt: _r, ...kept } = stored.task.recovery;
          stored = { ...stored, task: { ...stored.task, recovery: kept as TaskRecovery } };
        }
        try {
          await this.end(stored, "failed", undefined, cause, undefined);
        } catch (error) {
          console.warn(`tasks: recovering task not ended (${stored.task.taskId}):`, error);
        }
        continue;
      }
      this.tryStart(stored, true);
    }
  }

  /**
   * A task its node's going away cut off resumes once the node is back and has said it reported every run it cut off;
   * from a node too old to say, 30-40 s after it is back. It moves its time to then, and the timer with it.
   */
  private settle(stored: StoredTask): StoredTask {
    const task = stored.task;
    const rec = task.recovery;
    if (!rec) return stored;
    const machineId = this.runsOn(task);
    const back = this.ports.liveSince(machineId);
    // Offline: its start queues it until the node is back, and this runs again then.
    if (back === undefined) return stored;
    const c = this.ports.caughtUp(machineId);
    const caughtUp = c && recovery.cutByNode(rec) && this.cutOffAt(task) <= c.head ? c.atMs : undefined;
    const at = recovery.settled(rec, back, caughtUp, task.taskId);
    if (at === undefined) return stored;
    const next: StoredTask = { ...stored, task: { ...task, recovery: { ...rec, nextAt: at } } };
    this.resumeAt(next.task.recovery);
    this.put(next);
    return next;
  }

  /** The checkout's `origin` remote, shortened: `null` when it has none, undefined when the node couldn't say. */
  private async origin(r: ProjectRef): Promise<string | null | undefined> {
    let project: ReturnType<ReturnType<typeof store>["projectGet"]>;
    try {
      project = store(this.hub).projectGet(r);
    } catch {
      return undefined;
    }
    if (!project) return null;
    const out = await this.ports.runCommand(r.machineId, project.workspaceRoot, ["git", "remote", "get-url", "origin"], 15);
    if (!out) return undefined;
    const url = out.outputTail.trim();
    return out.exitCode === 0 && url !== "" ? shortRemote(url) : null;
  }

  /** `end`, then the queue: a slot may have freed. */
  private async finish(stored: StoredTask, status: TaskResultStatus, why: string | undefined, endCause: string | undefined, escalated: string | undefined) {
    await this.end(stored, status, why, endCause, escalated);
    await this.retryQueue();
  }

  /**
   * `why` stands in for the thread's own error: the watchdog's stall, which the thread row does not hold yet.
   * `escalated`: why a dead run was not resumed, which its lead decides on.
   */
  private async end(stored: StoredTask, status: TaskResultStatus, why: string | undefined, endCause: string | undefined, escalated: string | undefined): Promise<void> {
    const task = stored.task;
    const threadRef = task.threadRef as ThreadRef;
    const thread = store(this.hub).threadGet(threadRef);
    let text = thread?.thread.latestMessageTail ?? "";
    // The summary keeps only the ends of a long reply: the lead reads it whole with `agents` and its taskId.
    if (fullResultText(text) !== undefined) {
      const whole = await this.ports.latestText?.(threadRef);
      if (whole !== undefined && whole.trim().length > text.trim().length) text = whole;
    }
    const error =
      why ?? (thread && status === "failed" && thread.thread.lastError ? `[${thread.thread.lastError.class}] ${thread.thread.lastError.message}` : "");
    const write = task.kind === "write";
    const changes = write ? await this.ports.changes(threadRef) : undefined;
    const branch = changes?.branch ?? task.branch;
    // A reader or a review has the PR it was given, never one its report links (D130). A writer's is looked up after.
    const prUrl = task.kind !== "write" ? task.pr : undefined;
    const at = this.nowIso();
    const escalation =
      escalated !== undefined
        ? `Not resumed automatically: ${escalated}. Decide: continue it with instructions (message_agent), split the work, or cancel it.`
        : "";
    const tail = [text.trim(), error, escalation].filter((s) => s !== "").join("\n\n");
    const fullResult = fullResultText(tail);
    const result: TaskResult = {
      status,
      tail: resultText(tail, TAIL_MAX),
      ...(branch !== undefined ? { branch } : {}),
      ...(prUrl !== undefined ? { prUrl } : {}),
      ...(endCause !== undefined ? { endCause } : {}),
      at,
    };
    const next: Task = { ...task, state: status === "done" ? "done" : "failed", result, endedAt: at };
    if (branch !== undefined) next.branch = branch;
    if (changes?.worktreePath !== undefined) next.worktreePath = changes.worktreePath;
    // The PR lookup is marked pending in the same write, so no crash between them loses it.
    TaskRecords.putEnded(this.db, { task: next }, write, fullResult);
    this.releaseAll(task);
    this.wakeResult(next, result, escalated !== undefined);
    // Last, so whoever waits on it sees the slot and the wake already settled.
    const [type, verb]: [HubEventType, string] = status === "done" ? ["task.completed", "completed"] : ["task.failed", "failed"];
    this.emit(next, type, `${task.taskId} ${verb}: ${task.title}`, escalated !== undefined ? { escalated } : {});
    // A review's worktree holds no work, so it goes now. A reader's stays for the lead's next message; a writer's waits
    // for its PR to merge.
    if (task.kind === "review") this.removeWorktree(next);
    if (write) this.resolvePr(next.taskId);
  }

  /** A run of a live task ended without completing: resumed, escalated or failed plainly (`recovery.decide`). */
  private async died(stored: StoredTask, thread: ThreadRef, event: HubEvent): Promise<void> {
    const task = stored.task;
    const data = event.data as Record<string, unknown> | undefined;
    // Only the run the thread is on dies mid-run: one that names no run ends the task plainly.
    const runId = typeof data?.runId === "string" ? data.runId : undefined;
    const startedRun = this.ports.startedRun(thread);
    const ran = runId !== undefined && (startedRun === undefined || startedRun === runId);
    const last = await this.lastAction(thread);
    const death = recovery.death(event.type, data, thread.machineId, last);
    const opened = ran ? this.countDeath(task, death.kind) : undefined;
    // A node going away says nothing of the work: a merge it ran on past ends nothing.
    const mergedAfter = death.kind === "NodeLost" ? event.seq : this.runStartedAt(thread, event);
    const action = recovery.decide(death, task.recovery, !ran || this.stopped(task, mergedAfter), this.now(), Math.random(), recovery.RECOVERY_MAX);
    // The watchdog's stall, which the thread row does not hold yet.
    const message = (data?.error as { message?: unknown } | undefined)?.message;
    const stalled = death.kind === "Stalled" && typeof message === "string" ? `[stalled] ${message}` : undefined;
    if (action.kind !== "resume") this.stopEnded(task, thread);
    switch (action.kind) {
      case "finish":
        // A run stopped for a steer is never a failure: one whose work is over ends done.
        if (death.kind === "Cut") await this.finish(stored, "done", undefined, death.reported, undefined);
        else await this.finish(stored, "failed", stalled, death.reported, undefined);
        break;
      case "escalate":
        console.info(`dead task not resumed (${task.taskId}): ${action.why}`);
        await this.finish(stored, "failed", stalled, death.reported, action.why);
        break;
      case "resume": {
        const withSteers = this.withUnrunSteers(stored, event, death.kind);
        this.recover(withSteers, action.recovery);
        this.holdIfPaused(task.taskId, thread.machineId);
        break;
      }
    }
    if (opened) this.recoveryPaused(thread.machineId, opened);
  }

  /** A task its run's end ends is over on the node too: the stop runs off the lock, and until it is done it is `stopping`. */
  private stopEnded(task: Task, thread: ThreadRef): void {
    this.stopping.add(task.taskId);
    spawnInBackground(
      "an ended task's stop",
      (async () => {
        try {
          await this.ports.stop(thread);
        } catch (error) {
          console.warn(`ended task: its process not stopped (${task.taskId}):`, error);
        }
        this.stopping.delete(task.taskId);
        this.retryLater();
      })(),
    );
  }

  /** A run cut for a steer whose own run never began: that steer's message goes with the resumed run. */
  private withUnrunSteers(stored: StoredTask, event: HubEvent, kind: recovery.Kind): StoredTask {
    const by = (event.data as Record<string, unknown> | undefined)?.supersededBy;
    const unrun = kind === "Cut" && typeof by === "string" ? this.ports.holdUnrun(stored.task.taskId, by) : [];
    const pending = [...(stored.pendingMessage !== undefined ? [stored.pendingMessage] : []), ...unrun];
    return { task: stored.task, ...(pending.length > 0 ? { pendingMessage: pending.join("\n\n") } : {}) };
  }

  /** Queues a dead task to go on at `recovery.nextAt`, as `recovery.mode` says. The lead isn't woken. */
  private recover(stored: StoredTask, rec: TaskRecovery): Task {
    const task = stored.task;
    const reason = recovery.queuedReason(rec);
    console.info(`dead task recovers (${task.taskId}): ${reason}`);
    // A question it asked before it died no longer holds it back: it goes on, and the answer reaches it then.
    this.asking.delete(task.taskId);
    this.resumeAt(rec);
    const next: Task = { ...task, attempt: task.attempt + 1, recovery: rec };
    slots(this.hub).release(task.taskId);
    return this.queue({ task: next, ...(stored.pendingMessage !== undefined ? { pendingMessage: stored.pendingMessage } : {}) }, "recover", reason);
  }

  /** The node would not resume the task's thread (`message`, its words): a fresh thread takes over, once. */
  private refused(stored: StoredTask, message: string, fromQueue: boolean): Task {
    const task = stored.task;
    const action = recovery.decide(
      recovery.refused(message),
      task.recovery,
      this.stopped(task, this.cutOffAt(task)),
      this.now(),
      Math.random(),
      recovery.RECOVERY_MAX,
    );
    if (action.kind === "resume") return this.recover(stored, action.recovery);
    if (action.kind === "escalate") {
      return this.failToStart(
        stored,
        `${message}. Not restarted automatically: ${action.why}. Decide: continue it with instructions (message_agent), split the work, or cancel it.`,
        fromQueue,
      );
    }
    return this.failToStart(stored, message, fromQueue);
  }

  /** The handoff gathered for the task's fresh restart at this attempt; else starts gathering it, off the lock. */
  private handoffReady(task: Task): string | undefined {
    const attempt = task.attempt;
    const known = this.handoffs.get(task.taskId);
    if (known && known[0] === attempt) return known[1];
    this.handoffs.set(task.taskId, [attempt, undefined]);
    if (!task.threadRef || !task.recovery) return undefined;
    const [thread, rec] = [task.threadRef, task.recovery];
    spawnInBackground(
      "a fresh restart's handoff",
      (async () => {
        const handoff = await this.handoff(task, thread, rec);
        // Unless the task ended, or moved on to another attempt, meanwhile.
        if (this.handoffs.get(task.taskId)?.[0] === attempt) {
          this.handoffs.set(task.taskId, [attempt, handoff]);
          this.retryLater();
        }
      })(),
    );
    return undefined;
  }

  /** `step`, or undefined once it took HANDOFF_STEP_TIMEOUT_MS: a node that doesn't answer delays a fresh restart. */
  private bounded<T>(step: Promise<T | undefined>): Promise<T | undefined> {
    return within(HANDOFF_STEP_TIMEOUT_MS, step);
  }

  /** `task.handoff` from the earlier thread: its last words, its branch's commits, what is uncommitted and its PR. */
  private async handoff(task: Task, thread: ThreadRef, rec: TaskRecovery): Promise<string> {
    const latest = this.tryDb(() => store(this.hub).threadGet(thread))?.thread.latestMessageTail.trim();
    const tail = latest ? tailOf(latest, HANDOFF_TAIL) : "(none)";
    const changes = task.kind === "write" ? await this.bounded(this.ports.changes(thread)) : undefined;
    const path = changes?.worktreePath ?? task.worktreePath;
    const branch = changes?.branch ?? task.branch;
    const git = async (argv: string[]) => {
      if (path === undefined) return undefined;
      const out = await this.bounded(this.ports.runCommand(thread.machineId, path, argv, 30));
      if (!out || out.exitCode !== 0) return undefined;
      const text = out.outputTail.trim();
      return text === "" ? "none" : text;
    };
    const unknown = "(fleetd could not read them)";
    let commits = "none";
    let uncommitted = "none";
    let workspace = "It changed no files.";
    if (path !== undefined && branch !== undefined) {
      // The branch's own commits: not on any remote's copy of another branch, so pushed ones count too.
      commits = (await git(["git", "log", "--oneline", "-n", "20", "HEAD", "--not", `--exclude=*/${branch}`, "--remotes"])) ?? unknown;
      uncommitted = (await git(["git", "status", "--short"])) ?? unknown;
      workspace = `You work in its worktree ${path}, on its branch ${branch}.`;
    }
    // The branch's PR as a finished task's result links it (D67), never the last URL in the thread's words.
    const pr = (task.kind === "write" ? (await this.bounded(this.lookUpPr(task)))?.pr : undefined) ?? "none";
    const why = rec.lastCause === "context_full" ? "its context filled up again after `/compact`" : rec.lastCauseText;
    return prompts(this.hub.db).forThread(thread.machineId, thread.threadId).render("task.handoff", { why, workspace, tail, commits, uncommitted, pr });
  }

  /** The `task.recover` note a resume starts with: why the run ended and what it was doing. */
  private recoverNote(thread: ThreadRef, rec: TaskRecovery, doing: string): string {
    return prompts(this.hub.db)
      .forThread(thread.machineId, thread.threadId)
      .render("task.recover", { cause: rec.lastCauseText, doing, used: recovery.used(rec) });
  }

  /** Runs the queue once a recovery's delay is over. */
  private resumeAt(rec: TaskRecovery | undefined): void {
    const at = rec?.nextAt !== undefined ? parseMs(rec.nextAt) : undefined;
    if (at !== undefined) this.retryAt(at);
  }

  /** Runs the queue at `atMs`. */
  private retryAt(atMs: number): void {
    const signal = this.hub.shutdown.signal;
    spawnInBackground(
      "a timed queue retry",
      (async () => {
        await sleep(Math.max(atMs - this.now(), 0), signal);
        if (!signal.aborted) this.retryLater();
      })(),
    );
  }

  /** Sends a message held for the task into the run a person started in its thread; its lead is told when it can't. */
  private async deliver(task: Task, thread: ThreadRef, text: string): Promise<void> {
    const id = requestId(task, ["msg", crypto.randomUUID()]);
    const steer: HeldSteer | undefined = this.ports.takeHeld(task.taskId, thread, id);
    try {
      if (steer) await this.ports.sendSteer(thread, text, id, steer);
      else await this.ports.send(thread, text, id);
    } catch (error) {
      if (steer) this.ports.rehold(steer.id);
      const e = portError(error);
      const why = e.offline ? `${thread.machineId} is offline` : e.message;
      console.warn(`held message not delivered (${task.taskId}): ${why}`);
      this.ports.wake(task.projectRef, "task_result", taskMessageNotSentLines(task, why, text));
    }
  }

  /** Whether the task's work is over: cancelled, its workstream closed, or its PR merged after event `mergedAfter`. */
  private stopped(task: Task, mergedAfter: number): boolean {
    const w = this.workstream(task.workstreamId);
    if (task.state === "cancelled" || !w || w.state !== "open") return true;
    const row = this.db
      .query<{ merged: number }, [string, number]>(
        `SELECT EXISTS (SELECT 1 FROM events WHERE type = 'pr.merged' AND seq > ?2
           AND json_extract(data, '$.data.taskId') = ?1) AS merged`,
      )
      .get(task.taskId, mergedAfter);
    return Boolean(row?.merged);
  }

  /** The event that started the run a death `event` ended; 0 when the hub saw none start. */
  private runStartedAt(thread: ThreadRef, event: HubEvent): number {
    const run = (event.data as Record<string, unknown> | undefined)?.runId;
    if (typeof run !== "string") return 0;
    const row = this.db
      .query<{ seq: number }, [string, string, string]>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE type = 'thread.started' AND machine_id = ?1
           AND json_extract(data, '$.threadId') = ?2 AND json_extract(data, '$.data.runId') = ?3`,
      )
      .get(thread.machineId, thread.threadId, run);
    return row?.seq ?? 0;
  }

  /** The death that cut the task's thread off last; 0 when none did. */
  private cutOffAt(task: Task): number {
    const thread = task.threadRef;
    if (!thread) return 0;
    const row = this.db
      .query<{ seq: number }, [string, string]>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE type IN ('thread.failed', 'thread.interrupted')
           AND machine_id = ?1 AND json_extract(data, '$.threadId') = ?2`,
      )
      .get(thread.machineId, thread.threadId);
    return row?.seq ?? 0;
  }

  /** Runs again the pending PR lookups (of the machine's tasks, or all). */
  private resumePrLookups(machineId: MachineId | undefined): void {
    let pending: Task[];
    try {
      pending = TaskRecords.prLookups(this.db);
    } catch (error) {
      console.warn("tasks: pending PR lookups not read:", error);
      return;
    }
    for (const t of pending) if (machineId === undefined || t.projectRef.machineId === machineId) this.resolvePr(t.taskId);
  }

  /**
   * D67: a finished writer's PR is the host's PR for its branch; unread, a URL in its report on the project's own
   * remote. Resolved off the lock, then set with a short re-lock on the result the task ended with.
   */
  private resolvePr(taskId: TaskId): void {
    if (this.lookingUp.has(taskId)) return;
    this.lookingUp.add(taskId);
    spawnInBackground(
      "a PR lookup",
      (async () => {
        try {
          if (await this.resolvePrOnce(taskId)) this.ports.prFound(taskId);
        } finally {
          this.lookingUp.delete(taskId);
        }
      })(),
    );
  }

  private async resolvePrOnce(taskId: TaskId): Promise<boolean> {
    const task = this.tryDb(() => TaskRecords.get(this.db, taskId))?.task;
    if (!task) return false;
    const at = task.result?.at;
    let answer = await this.lookUpPr(task);
    if (!answer) {
      const ended = task.endedAt !== undefined ? parseMs(task.endedAt) : undefined;
      if (ended !== undefined && this.now() - ended >= PR_LOOKUP_GIVE_UP_MS) answer = {};
    }
    if (!answer) return false;
    const release = await this.lockTask(taskId);
    try {
      return this.settlePr(taskId, at, answer);
    } catch (error) {
      console.warn("tasks: PR not set:", error);
      return false;
    } finally {
      release();
    }
  }

  /** A writer's PR, or undefined when the node or the host couldn't say yet. */
  private async lookUpPr(task: Task): Promise<Lookup | undefined> {
    const texts: string[] = [];
    if (task.threadRef) {
      const actions = (await within(PR_LOOKUP_TIMEOUT_MS, this.ports.actionTexts(task.threadRef, 30))) ?? [];
      for (const [summary, outputTail] of [...actions].reverse()) {
        texts.push(summary);
        if (outputTail !== undefined) texts.push(outputTail);
      }
    }
    if (task.result) texts.push(task.result.tail);
    // A repo removed since has no remote to read: no PR is looked up.
    let remote: string | null | undefined;
    try {
      remote = await within(PR_LOOKUP_TIMEOUT_MS, this.origin(this.checkoutOf(task)));
    } catch {
      remote = null;
    }
    if (remote === undefined) return undefined;
    if (remote === null) return {};
    const unread = new Error("the host was not read");
    if (task.branch === undefined) {
      const pr = taskPrUrl(unread, remote, texts);
      return pr !== undefined ? { pr } : {};
    }
    let host: string | undefined | Error;
    let retry = false;
    let skipped: string | undefined;
    try {
      const found = await within(PR_LOOKUP_TIMEOUT_MS, this.ports.branchPr(remote, task.branch).then((pr) => ({ pr })));
      if (found === undefined) throw { kind: "unread", why: "the host did not answer" } satisfies BranchPrError;
      host = found.pr;
    } catch (error) {
      const e = error as BranchPrError;
      host = unread;
      if (e.kind === "refused") skipped = e.why;
      else if (e.kind !== "no_reader") retry = true;
    }
    const pr = taskPrUrl(host, remote, texts);
    // An unread host with nothing on the remote in the report: try again.
    if (pr === undefined && retry) return undefined;
    return { ...(pr !== undefined ? { pr } : {}), ...(pr === undefined && skipped !== undefined ? { skipped } : {}) };
  }

  /** Clears the pending mark and sets the PR on the result the task ended with (`at`); whether it was set. */
  private settlePr(taskId: TaskId, at: string | undefined, lookup: Lookup): boolean {
    const stored = TaskRecords.get(this.db, taskId);
    // Continued and ended again since: that end's own lookup settles it.
    if (!stored?.task.result || stored.task.result.at !== at) return false;
    if (!TaskRecords.prLookupPending(this.db, taskId)) return false;
    TaskRecords.setPrLookup(this.db, taskId, false);
    if (lookup.pr === undefined) {
      if (lookup.skipped !== undefined) this.ports.wake(stored.task.projectRef, "quiet", taskPrSkippedLines(taskId, lookup.skipped));
      return false;
    }
    stored.task.result.prUrl = lookup.pr;
    this.put(stored);
    this.ports.wake(stored.task.projectRef, "quiet", taskPrLines(taskId, lookup.pr));
    return true;
  }

  private async onThreadEvent(event: HubEvent): Promise<void> {
    switch (event.type) {
      case "usage.resumed":
      case "machine.guard":
        await this.retryQueue();
        return;
      case "pr.merged":
        this.merged(event);
        return;
      case "machine.online":
        this.resumePrLookups(event.machineId);
        return;
    }
    if (event.machineId === undefined || event.threadId === undefined) return;
    const threadRef: ThreadRef = { machineId: event.machineId, threadId: event.threadId };
    const stored = TaskRecords.byThread(this.db, threadRef);
    if (!stored) return;
    const task = stored.task;
    // A thread the task was restarted fresh from: whatever it reports, the task has moved on.
    if (!sameThread(task.threadRef, threadRef)) {
      console.info(`task event for an earlier thread ignored (${task.taskId}, seq ${event.seq})`);
      return;
    }
    // An earlier run's end is not this run's: the task goes on.
    const live = (task.state === "running" || task.state === "idle") && !this.earlierRun(task, event);
    const machineId = event.machineId;
    if (event.type === "thread.started" && live && task.state === "running") {
      // The run fleetd resumed it in: its lead reads of it in its next wake.
      const resumed = this.resumed.get(task.taskId);
      if (!resumed) return;
      this.resumed.delete(task.taskId);
      if (!task.recovery) return;
      const [doing, before] = resumed;
      const now = this.ports.recreatedFrom(threadRef);
      const rebuilt = now && !(before && before[0] === now[0] && before[1] === now[1]) ? now[0] : undefined;
      this.ports.wake(task.projectRef, "recovery", taskRecoveredLines(task, task.recovery, doing, rebuilt));
      return;
    }
    switch (event.type) {
      case "thread.started": {
        // Continued outside `task message`: the usage layer's continue, or a human writing to the thread.
        const recovering = task.state === "queued" && task.recovery?.nextAt !== undefined;
        if (!recovering && !(task.state === "done" || task.state === "failed" || task.state === "idle")) return;
        const board = slots(this.hub);
        board.acquire({ holder: task.taskId, projectRef: task.projectRef, priority: priorityOf(task.kind) });
        board.bind(task.taskId, threadRef);
        const { endedAt: _e, parked: _p, ...rest } = task;
        const next: Task = { ...rest, state: "running" };
        if (recovering) {
          console.info(`recovering task continued in its thread; its note is not sent (${task.taskId})`);
          delete next.queuedReason;
        }
        // Or what other agents sent it while it was ended: a Monitor of its own woke it, and this run carries it.
        const peers =
          !recovering &&
          this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM steers WHERE task_id = ? AND held = 1 AND stage = 'queued'").get(task.taskId)!.n > 0;
        const held = recovering || peers ? stored.pendingMessage : undefined;
        // A person continued it, not fleetd: the digest no longer says it was resumed automatically.
        if ((recovering || task.parked === undefined) && next.recovery) {
          const { nextAt: _n, resumedAt: _r, ...kept } = next.recovery;
          next.recovery = kept as TaskRecovery;
        }
        this.put({ task: next });
        // What was sent to it while it waited goes to the run that continued it, never dropped.
        if (held !== undefined) await this.deliver(next, threadRef, held);
        return;
      }
      case "thread.waiting": {
        // The board frees the slot itself and takes it again if the run resumes.
        if (task.state !== "running") return;
        this.put({ task: { ...task, state: "idle" } });
        // Nobody else answers a task's question, so its lead is woken with it.
        const asked = await this.ports.pendingQuestion(threadRef);
        const latest = store(this.hub).threadGet(threadRef)?.thread.latestMessageTail.trim();
        const question =
          asked ??
          (latest ? tailOf(latest, 1500) : undefined) ??
          `(the node did not say what it waits for; read it with thread_tail on ${threadRef.machineId}/${threadRef.threadId})`;
        this.ports.wake(task.projectRef, "task_waiting", taskWaitingLines(task.taskId, task.title, question));
        return;
      }
      case "thread.completed":
        if (!live) return;
        // Its `/compact` completed: the note to continue goes now, as the recovery it is.
        if (task.recovery && task.recovery.mode === "compact" && task.recovery.nextAt === undefined) {
          const next: Task = {
            ...task,
            attempt: task.attempt + 1,
            recovery: { ...task.recovery, mode: "resume", lastCauseText: "its context was full; fleetd compacted it", nextAt: this.nowIso() },
          };
          console.info(`compacted task resumes (${task.taskId})`);
          this.tryStart({ task: next, ...(stored.pendingMessage !== undefined ? { pendingMessage: stored.pendingMessage } : {}) }, true);
          return;
        }
        // An agent there got its work done: the machine is fine again.
        this.closeBreaker(machineId, task);
        await this.finish(stored, "done", undefined, endCauseOf(event) ?? "completed", undefined);
        return;
      case "thread.usage_limited": {
        // M4 usage: parked, not failed. The usage layer sends "continue" at the reset.
        const parked = live ? this.ports.parkedOf(event) : undefined;
        if (parked) {
          this.put({
            task: { ...task, state: "idle", parked },
            ...(stored.pendingMessage !== undefined ? { pendingMessage: stored.pendingMessage } : {}),
          });
        }
        return;
      }
      // A cancel interrupts the thread itself and has already ended the task.
      case "thread.failed":
      case "thread.interrupted":
        if (live) await this.died(stored, threadRef, event);
        return;
    }
  }

  /**
   * Whether a thread event's run is older than the one the task is on: the task was continued and that run hasn't
   * shown up yet, or a newer run has started on the thread since. One that never shows up is given up on after a while.
   */
  private earlierRun(task: Task, event: HubEvent): boolean {
    const run = (event.data as Record<string, unknown> | undefined)?.runId;
    if (typeof run !== "string") return false;
    const now = this.now();
    let awaited = false;
    const sent = this.continuing.get(task.taskId);
    if (sent) {
      // Any run that starts now is the continued one or a later one.
      if (sent[0] !== run && event.type !== "thread.started" && now - sent[1] < CONTINUED_RUN_WAIT_MS) awaited = true;
      else this.continuing.delete(task.taskId);
    }
    const ends = event.type === "thread.completed" || event.type === "thread.failed" || event.type === "thread.interrupted" || event.type === "thread.usage_limited";
    const started = ends && task.threadRef ? this.ports.startedRun(task.threadRef) : undefined;
    const earlier = awaited || (started !== undefined && started !== run);
    if (earlier) console.info(`task event for an earlier run ignored (${task.taskId}, seq ${event.seq}, run ${run})`);
    return earlier;
  }

  private async follow(from: number, signal: AbortSignal): Promise<void> {
    let cursor = from;
    while (!signal.aborted) {
      let page: Awaited<ReturnType<ReturnType<typeof events>["wait"]>>;
      try {
        page = await events(this.hub).wait({ cursor, types: THREAD_EVENTS, timeoutSec: 300 }, signal);
      } catch (error) {
        console.warn("tasks: event wait failed:", error);
        await sleep(1000, signal);
        continue;
      }
      cursor = page.cursor;
      for (const event of page.events) await this.lock.with(() => this.apply(event));
    }
  }

  private owned(caller: TaskCaller, taskId: TaskId): StoredTask {
    let stored: StoredTask | undefined;
    try {
      stored = TaskRecords.get(this.db, taskId);
    } catch (error) {
      throw storeError(error);
    }
    if (stored && sameProject(stored.task.projectRef, caller.projectRef)) return stored;
    throw leadError("not_found", `No task ${taskId} in this project.`, "Call `agents`.");
  }

  /** The task as stored: running, queued with its reason, or failed if the node refused the launch. */
  async spawn(caller: TaskCaller, input: SpawnInput): Promise<Task> {
    return (await this.spawnNoted(caller, input)).task;
  }

  /**
   * `spawn`, with what a writer's duplicate check has to say, and the writers' changed paths it gathered. A writer that
   * repeats work in flight is refused.
   */
  async spawnNoted(caller: TaskCaller, input: SpawnInput): Promise<Spawned> {
    const r = caller.projectRef;
    // An archived project (W79) starts nothing: its directory is another project's repo now.
    let holder: { project: ProjectRef; repo: ProjectRepo } | undefined;
    let isArchived: boolean;
    try {
      holder = repos.holders(this.db, r)[0];
      isArchived = archived(this.db, r);
    } catch (error) {
      throw storeError(error);
    }
    if (holder) {
      throw leadError(
        "invalid",
        `This project is archived: its directory is repo ${holder.repo.name} of project ${holder.project.projectId} on ${holder.project.machineId}.`,
        "Write to that project's lead instead; project_repo_remove takes the repo out of it and brings this project back.",
      );
    }
    // Nor does one archived in the app: its lead takes no turn, even one that outlived its stop.
    if (isArchived) throw leadError("invalid", "This project is archived: it starts no agents.", "Ask the person to bring it back in the app first.");
    // Binding may ask the node, and so does each writer's changed paths: both happen before the lock.
    const repo = this.spawnRepo(r, input);
    const other = repo && !sameProject(repo.checkout, r) ? repo : undefined;
    let checked: [SpawnScope, Observed] | undefined;
    if (input.kind === "write") {
      const scope = await this.spawnScope(r, other);
      let observed: Observed = { paths: new Map(), unknown: new Set() };
      if (scope.kind === "bound") {
        try {
          observed = (await this.ports.work()?.observe(scope.scope, OBSERVE_TIMEOUT_MS)) ?? observed;
        } catch (error) {
          throw storeError(error);
        }
      }
      checked = [scope, observed];
    }
    const release = await this.lock.acquire();
    let stored: StoredTask;
    let note: string | undefined;
    try {
      const ws = this.workstream(input.workstreamId);
      if (!ws || !sameProject(ws.projectRef, r)) {
        throw leadError("not_found", `No workstream ${input.workstreamId} in this project.`, "Use a workstream id from your digest.");
      }
      if (ws.state !== "open") {
        throw leadError("invalid", `Workstream ${input.workstreamId} is ${ws.state}; tasks run only for open workstreams.`);
      }
      // Its starter has no Claude to run it on: refused now, in plain words, before any agent waits.
      const claude = this.ports.claudeRefusal(r, input.workstreamId);
      if (claude) throw leadError("invalid", claude[0], claude[1]);
      // A writer whose PRs would open as a person who hasn't connected GitHub (D187).
      const github = this.ports.githubRefusal(r, input.workstreamId, input.kind, repo?.repoId);
      if (github) throw leadError("invalid", github[0], github[1]);
      let allowed: string[];
      try {
        allowed = this.ports.allowedProfiles(r);
      } catch (error) {
        throw leadError("failed", `The project's profiles were not read: ${(error as Error).message}.`, "Retry.");
      }
      let profile: string;
      try {
        profile = resolveProfile(input.profile, input.kind, allowed);
      } catch (error) {
        throw leadError("invalid", `Not spawned: ${(error as Error).message}.`, "Leave `profile` out for the default, or name one of those.");
      }
      let counts: ReturnType<typeof TaskRecords.counts>;
      try {
        counts = TaskRecords.counts(this.db, r);
      } catch (error) {
        throw storeError(error);
      }
      checkFanOut(counts.queued + counts.running + counts.idle, slots(this.hub).agents(r).maxAgents);
      let overridden: string[] = [];
      if (checked) [note, overridden] = this.checkDuplicates(r, checked[0], checked[1], input);
      // A broken policy file refuses the spawn now, not at its launch. An offline machine's file can't be read.
      const checkout = other?.checkout ?? r;
      try {
        await this.ports.policy(checkout);
      } catch (error) {
        if (!(error instanceof ToolError) || error.code !== "machine_offline") throw error;
      }
      const draft: Task = {
        taskId: "T0",
        projectRef: r,
        ...(repo ? { repoId: repo.repoId } : {}),
        workstreamId: input.workstreamId,
        title: input.title,
        kind: input.kind,
        prompt: input.prompt,
        profile,
        ...(input.qa !== undefined ? { qa: input.qa } : {}),
        ...(input.pr !== undefined ? { pr: input.pr } : {}),
        ...(input.paths !== undefined ? { paths: input.paths } : {}),
        state: "queued",
        attempt: 1,
        createdAt: this.nowIso(),
      };
      let task: Task;
      try {
        task = TaskRecords.create(this.db, draft);
      } catch (error) {
        throw storeError(error);
      }
      if (overridden.length > 0) {
        console.info(
          `tasks: spawned over a possible duplicate (${task.taskId} in ${r.projectId} over ${overridden.join(", ")}: ${input.notDuplicateWhy ?? ""})`,
        );
      }
      stored = { task };
    } catch (error) {
      release();
      throw error;
    }
    // The launch goes on off the lock: other calls and starts don't wait for this one's node.
    const task = await this.startNow(release, stored, false);
    return { task, ...(note !== undefined ? { note } : {}), observed: checked?.[1] ?? { paths: new Map(), unknown: new Set() } };
  }

  /**
   * The repo and base for a writer's duplicate check: `other`'s as recorded, else the project's. The project's
   * unrecorded are read from its root, waiting at most BIND_WAIT_MS; a slow remote finishes in the background.
   */
  private async spawnScope(r: ProjectRef, other: ProjectRepo | undefined): Promise<SpawnScope> {
    const work = this.ports.work();
    let scope: WorkScope | undefined;
    try {
      scope = this.scopeFor(r, other);
    } catch (error) {
      throw storeError(error);
    }
    if (scope) return { kind: "bound", scope };
    if (other || !work) return { kind: "no_repo" };
    const key = projectKey(r);
    if (this.binding.has(key)) return { kind: "binding" };
    this.binding.add(key);
    // However the read ends, the project is free to be read again.
    const bound = work.bindFromRoot(r).then(
      (s) => ({ ok: s }) as const,
      (error) => {
        console.warn(`tasks: repo and base not read (${r.projectId}):`, error);
        return { error } as const;
      },
    );
    void bound.finally(() => this.binding.delete(key));
    const done = await within(BIND_WAIT_MS, bound);
    if (done === undefined) return { kind: "binding" };
    if ("error" in done) throw storeError(done.error);
    return done.ok ? { kind: "bound", scope: done.ok } : { kind: "no_repo" };
  }

  /** The work in flight a writer may overlap, read again from the store as it starts, for its prompt. */
  private elsewhereFor(task: Task): string[] {
    const work = this.ports.work();
    if (!work) return [];
    try {
      const r = task.projectRef;
      const scope = this.scopeFor(r, this.otherRepo(r, task.repoId));
      if (!scope) return [];
      const intent = work.matcher.intent(r, scope, task.title, task.prompt, task.pr, task.paths ?? []);
      return duplicates.forWriter(work.checkObserved(scope, intent, new Map()), task.taskId);
    } catch (error) {
      console.warn(`tasks: work elsewhere not read (${task.taskId}):`, error);
      return [];
    }
  }

  /** The repo a new task works in (W79): `repo` by name, else the project's repo `pr` is in, else its own repo. */
  private spawnRepo(r: ProjectRef, input: SpawnInput): ProjectRepo | undefined {
    let all: ProjectRepo[];
    try {
      all = this.hub.db.transaction((c) => {
        repos.ensureOwn(c, r);
        return repos.of(c, r);
      });
    } catch (error) {
      throw storeError(error);
    }
    if (input.repo !== undefined) {
      const named = all.find((repo) => repo.name === input.repo);
      if (named) return named;
      if (all.length === 0) {
        throw leadError("not_found", `No repo ${input.repo} in this project: it has none.`, "Leave repo out: the agent works in the project's directory.");
      }
      throw leadError("not_found", `No repo ${input.repo} in this project.`, `Use one of its repos: ${all.map((x) => x.name).join(", ")}.`);
    }
    const ofPr = input.pr !== undefined ? all.find((repo) => holdsPr(repo, input.pr as string)) : undefined;
    return ofPr ?? all.find((repo) => sameProject(repo.checkout, r));
  }

  /** The project's repos, oldest first; none when they can't be read. */
  reposOf(r: ProjectRef): ProjectRepo[] {
    try {
      return repos.of(this.db, r);
    } catch (error) {
      console.warn("tasks: repos not read:", error);
      return [];
    }
  }

  /** One of the project's other repos, the task's `repoId`: its files are in another checkout (W79). */
  private otherRepo(r: ProjectRef, repoId: RepoId | undefined): ProjectRepo | undefined {
    if (repoId === undefined) return undefined;
    try {
      const found = repos.get(this.db, repoId);
      return found && sameProject(found.project, r) && !sameProject(found.repo.checkout, r) ? found.repo : undefined;
    } catch (error) {
      console.warn(`tasks: repo not read (${repoId}):`, error);
      return undefined;
    }
  }

  /** The repo a task works in when it is one of the project's other repos; a repo the project no longer has fails it. */
  private repoOf(task: Task): ProjectRepo | undefined {
    if (task.repoId === undefined) return undefined;
    const found = repos.get(this.db, task.repoId);
    if (found && sameProject(found.project, task.projectRef)) {
      return sameProject(found.repo.checkout, task.projectRef) ? undefined : found.repo;
    }
    throw new StartError(false, `its repo ${task.repoId} was removed from the project`);
  }

  /** The node checkout a task works in: its repo's, else the project's own directory. */
  private checkoutOf(task: Task): ProjectRef {
    return this.repoOf(task)?.checkout ?? task.projectRef;
  }

  /** The repo and base work lands on: `other`'s as recorded, else the project's. */
  private scopeFor(r: ProjectRef, other: ProjectRepo | undefined): WorkScope | undefined {
    const work = this.ports.work();
    if (!work) return undefined;
    return other ? work.scopeOfRepo(other.repoId) : work.scopeOf(r);
  }

  /** A writer against the work in flight: refused when it repeats some, else its note and what it overrode. */
  private checkDuplicates(r: ProjectRef, scope: SpawnScope, observed: Observed, input: SpawnInput): [string | undefined, string[]] {
    if (scope.kind === "no_repo") return [duplicates.UNBOUND, []];
    if (scope.kind === "binding") return [duplicates.BINDING, []];
    const work = this.ports.work();
    if (!work) return [duplicates.UNBOUND, []];
    let matches: ReturnType<typeof work.checkObserved>;
    try {
      const intent = work.matcher.intent(r, scope.scope, input.title, input.prompt, input.pr, input.paths ?? []);
      matches = work.checkObserved(scope.scope, intent, observed.paths);
    } catch (error) {
      throw storeError(error);
    }
    const passed = duplicates.judge(matches, input.notDuplicateOf, observed.unknown);
    return [passed.elsewhere.length > 0 ? `elsewhere: ${passed.elsewhere.join("; ")}` : undefined, passed.overridden];
  }

  /** Steers a running task; continues an ended one in the same thread, which re-takes its slot. */
  async message(caller: TaskCaller, taskId: TaskId, text: string): Promise<Task> {
    const release = await this.lockTask(taskId);
    let handedOver = false;
    try {
      const stored = this.owned(caller, taskId);
      const task = stored.task;
      // Any message answers its question.
      this.asked.delete(taskId);
      switch (task.state) {
        case "cancelled":
          throw leadError("invalid", `${taskId} was cancelled.`, "Spawn a new task for the remaining work.");
        case "queued": {
          if (!task.threadRef) {
            throw leadError(
              "invalid",
              `${taskId} has not started yet (${task.queuedReason ?? "queued"}).`,
              "Wait for it to start, or stop it with `stop_agent` and spawn it again with the new prompt.",
            );
          }
          const pending = stored.pendingMessage === undefined ? text : `${stored.pendingMessage}\n\n${text}`;
          // A recovering task resumes now (once a node just back has settled), with the note and this.
          const next: Task = { ...task };
          const recovering = recovery.waiting(next.recovery, this.now());
          if (recovering && next.recovery) next.recovery = { ...next.recovery, nextAt: this.nowIso() };
          // Over the machine's breaker too.
          const held = this.held_(task);
          this.breakers.release(taskId);
          try {
            this.put({ task: next, pendingMessage: pending });
          } catch (error) {
            throw storeError(error);
          }
          if (recovering || held) {
            // An answer to its question goes with the resume.
            this.asking.delete(taskId);
            this.retryLater();
            return next;
          }
          // A paused agent held back for this answer can continue now, if a slot is free.
          if (this.asking.delete(taskId)) this.retryLater();
          return task;
        }
        case "running": {
          this.asking.delete(taskId);
          const thread = task.threadRef as ThreadRef;
          // A busy node may take a while to take it (the executor's `callPatient`): other tasks' calls go on.
          handedOver = true;
          release();
          try {
            await this.ports.send(thread, text, requestId(task, ["msg", crypto.randomUUID()]));
          } catch (error) {
            throw portError(error).toToolError(thread.machineId);
          }
          return task;
        }
        default: {
          this.asking.delete(taskId);
          const next: Task = { ...task, attempt: task.attempt + 1 };
          // The lead continued it: a death like the last one is resumed again, within the same cap.
          if (next.recovery) {
            const { signature: _s, resumedAt: _r, ...kept } = next.recovery;
            next.recovery = kept as TaskRecovery;
          }
          handedOver = true;
          // What other agents sent while it was ended goes first, in the order it came.
          const pending = stored.pendingMessage === undefined ? text : `${stored.pendingMessage}\n\n${text}`;
          return await this.startNow(release, { task: next, pendingMessage: pending }, false);
        }
      }
    } finally {
      if (!handedOver) release();
    }
  }

  /** When the task asked the `ask_lead` question no message has answered yet, if one hasn't been. */
  askedAt(taskId: TaskId): number | undefined {
    return this.asked.get(taskId);
  }

  /** Its lead or a person wrote to it (a steer, whatever its state): that answers its question. */
  answered(taskId: TaskId): void {
    this.asked.delete(taskId);
  }

  /** Keeps another agent's message for a task that isn't running, without starting it: its next run carries it,
   * whatever starts that run (a Monitor of its own, its wait_ci, its lead). One running again by now takes it at once. */
  async holdMessage(taskId: TaskId, text: string): Promise<void> {
    const release = await this.lockTask(taskId);
    let released = false;
    try {
      const stored = TaskRecords.get(this.db, taskId);
      if (!stored) return;
      if (stored.task.state === "running" && stored.task.threadRef) {
        released = true;
        release();
        await this.deliver(stored.task, stored.task.threadRef, text);
        return;
      }
      this.put({ task: stored.task, pendingMessage: stored.pendingMessage === undefined ? text : `${stored.pendingMessage}\n\n${text}` });
    } finally {
      if (!released) release();
    }
  }

  /** A writer's files changed so far, as its node reads its worktree, for `agents` on one task. */
  async changing(task: Task): Promise<string | undefined> {
    const SHOWN = 30;
    if (task.kind !== "write" || !task.threadRef) return undefined;
    const paths = (await within(OBSERVE_TIMEOUT_MS, this.ports.changes(task.threadRef)))?.paths;
    if (paths === undefined) return undefined;
    const id = task.taskId;
    if (paths.length === 0) return `${id} has changed no files yet.`;
    if (paths.length > SHOWN) return `${id} changes: ${paths.slice(0, SHOWN).join(", ")}, +${paths.length - SHOWN} more.`;
    return `${id} changes: ${paths.join(", ")}.`;
  }

  /** Removes `text` from a task's pending message (a withdrawn steer); false once that run went out. */
  async takeBack(taskId: TaskId, text: string): Promise<boolean> {
    const release = await this.lockTask(taskId);
    try {
      const stored = TaskRecords.get(this.db, taskId);
      if (stored?.pendingMessage === undefined) return false;
      const parts = stored.pendingMessage.split("\n\n");
      const ours = text.split("\n\n");
      let at = -1;
      for (let i = 0; i + ours.length <= parts.length; i++) {
        if (ours.every((p, j) => parts[i + j] === p)) {
          at = i;
          break;
        }
      }
      if (at < 0) return false;
      const rest = [...parts.slice(0, at), ...parts.slice(at + ours.length)];
      this.put({ task: stored.task, ...(rest.length > 0 ? { pendingMessage: rest.join("\n\n") } : {}) });
      return true;
    } catch (error) {
      throw storeError(error);
    } finally {
      release();
    }
  }

  /** Interrupts a running task and releases its slot. */
  async cancel(caller: TaskCaller, taskId: TaskId, reason?: string): Promise<Task> {
    const release = await this.lockTask(taskId);
    let task: Task;
    let next: Task;
    try {
      task = this.owned(caller, taskId).task;
      this.asked.delete(taskId);
      if (task.state === "cancelled") return task;
      if (task.state === "done" || task.state === "failed") {
        throw leadError("invalid", `${taskId} already ended (${task.state}); there is nothing to cancel.`);
      }
      // The slot goes only once the agent's claude has exited: a cancel the node could not carry out leaves the task
      // as it was, still holding it, and says so.
      if ((task.state === "running" || task.state === "idle") && task.threadRef) {
        try {
          await this.ports.stop(task.threadRef);
        } catch (error) {
          const e = portError(error);
          console.warn(`task cancel: stop failed (${taskId}):`, e.message);
          const why = e.offline ? `machine ${task.threadRef.machineId} has no live node link` : e.message;
          throw leadError("failed", `${taskId} could not be stopped (${why}); it keeps running and keeps its slot.`, "Call stop_agent again shortly.");
        }
      }
      const at = this.nowIso();
      const result: TaskResult = {
        status: "cancelled",
        tail: tailOf(reason ?? `Cancelled by ${caller.by}.`, TAIL_MAX),
        ...(task.branch !== undefined ? { branch: task.branch } : {}),
        endCause: "requested",
        at,
      };
      const { queuedReason: _q, ...rest } = task;
      next = { ...rest, state: "cancelled", result, endedAt: at };
      try {
        this.put({ task: next });
        this.releaseAll(task);
        this.emit(next, "task.cancelled", `${taskId} cancelled: ${task.title}`);
      } catch (error) {
        throw storeError(error);
      }
      if (task.kind !== "write") this.removeWorktree(next);
      await this.retryQueue();
    } finally {
      release();
    }
    return next;
  }

  /** A writer's PR merged: its worktree goes, unless its agent is still at work. */
  private merged(event: HubEvent): void {
    const taskId = (event.data as Record<string, unknown> | undefined)?.taskId;
    if (typeof taskId !== "string" || !/^T[1-9][0-9]*$/.test(taskId)) return;
    const task = this.get(taskId);
    if (task && task.kind === "write" && (task.state === "done" || task.state === "failed")) this.removeWorktree(task);
  }

  /** Has the node stop a task's agent and delete its worktree, off the lock; one it can't is left for the nightly sweep. */
  private removeWorktree(task: Task): void {
    const thread = task.threadRef;
    if (!thread) return;
    spawnInBackground(
      "a worktree removal",
      (async () => {
        try {
          await this.ports.removeWorktree(thread);
        } catch (error) {
          console.warn(`worktree not removed (${task.taskId}):`, error);
          return;
        }
        // The nightly sweep has nothing left to do for it.
        try {
          TaskRecords.setWorktree(this.db, task.taskId, "removed");
        } catch (error) {
          console.warn(`worktree removal not recorded (${task.taskId}):`, error);
        }
      })(),
    );
  }

  get(taskId: TaskId): Task | undefined {
    return TaskRecords.get(this.db, taskId)?.task;
  }

  /** The task's whole final result, when its `result.tail` cuts it. */
  fullResult(taskId: TaskId): string | undefined {
    return TaskRecords.fullResult(this.db, taskId);
  }

  /** The task whose agent runs in `thread`, if one does. */
  taskOfThread(thread: ThreadRef): Task | undefined {
    return TaskRecords.byThread(this.db, thread)?.task;
  }

  /** A task's agent asks its lead (`ask_lead`): the lead is woken with the question; `message_agent` answers. */
  askLead(taskId: TaskId, question: string): Task {
    let task: Task | undefined;
    try {
      task = this.get(taskId);
    } catch (error) {
      throw storeError(error);
    }
    if (!task) throw leadError("not_found", `No task ${taskId}.`);
    this.asking.add(taskId);
    this.asked.set(taskId, this.now());
    this.ports.wake(task.projectRef, "task_waiting", taskWaitingLines(taskId, task.title, question));
    return task;
  }

  /** A task's agent reads its workstream's brief (`brief_read`), whole. */
  briefRead(taskId: TaskId): Record<string, unknown> {
    let task: Task | undefined;
    try {
      task = this.get(taskId);
    } catch (error) {
      throw storeError(error);
    }
    if (!task) throw leadError("not_found", `No task ${taskId}.`);
    const w = this.workstream(task.workstreamId);
    if (!w) throw leadError("not_found", `No workstream ${task.workstreamId}.`);
    return {
      workstreamId: w.workstreamId,
      title: w.title,
      ...(w.brief ? { brief: w.brief } : { next: "Your workstream has no brief yet: your task message is all there is." }),
    };
  }

  /** Newest first. */
  list(filter: TaskFilter): Task[] {
    return TaskRecords.list(this.db, filter);
  }

  // --- what leads read from tasks (leads' TasksHook) ---

  /** Where each of the machine's projects last started a worktree, for the doctor. */
  latestBases(machineId: string): [ProjectRef, WorktreeBase][] {
    return this.tryDb(() => TaskRecords.latestBases(this.db, machineId)) ?? [];
  }

  /** A line per task; the agents line is `agents`, at the top of the state block. */
  digestLines(r: ProjectRef, since: string | undefined, limit: number): string[] {
    const offline = this.offlineSince();
    const openWaits = openCiWaits(this.db);
    const tasks = this.tryDb(() => TaskRecords.forDigest(this.db, r, since, limit));
    if (!tasks) return [];
    return taskDigestLines(tasks, since, this.nowIso(), (m) => offline.get(m), (t) => openWaits.get(t) ?? []);
  }

  /** Every offline machine, with when its offline spell started. */
  private offlineMachines(): [MachineId, string][] {
    try {
      return store(this.hub)
        .machinesList()
        .filter((m) => m.status === "offline")
        .map((m) => [m.machineId, m.lastSeenAt]);
    } catch (error) {
      console.warn("tasks: machines not read:", error);
      return [];
    }
  }

  /** Offline machines by id, with the `HH:MM` their spell started at. */
  private offlineSince(): Map<string, string> {
    return new Map(this.offlineMachines().map(([m, since]) => [m, since.length >= 16 ? since.slice(11, 16) : since]));
  }

  /**
   * The sweep's check: a running task whose machine has been offline for `recovery.UNREACHABLE_MS` gets one quiet line
   * to its lead per offline spell. It keeps its slot and resumes when the machine is back.
   */
  unreachable(): void {
    const now = this.now();
    const offline = this.offlineMachines();
    // A spell that ended is forgotten, so the next one is told again.
    for (const [taskId, [machine, since]] of this.unreachableTold) {
      if (!offline.some(([m, s]) => m === machine && s === since)) this.unreachableTold.delete(taskId);
    }
    for (const [machine, since] of offline) {
      const at = parseMs(since);
      if (at === undefined) continue;
      const away = now - at;
      if (away < recovery.UNREACHABLE_MS) continue;
      for (const task of TaskRecords.runningOn(this.db, machine)) {
        if (this.unreachableTold.has(task.taskId)) continue;
        this.unreachableTold.set(task.taskId, [machine, since]);
        this.ports.wake(task.projectRef, "recovery", taskUnreachableLines(task, Math.trunc(away / 60_000)));
      }
    }
  }

  /** Tells each agent running on `machine` that git there can't reach GitHub now, or (`reached`) that it can again. */
  async githubReach(machine: MachineId, reached: boolean): Promise<void> {
    const [text, part] = reached ? [GITHUB_BACK, "github-back"] : [GITHUB_DOWN, "github-down"];
    const at = String(this.now());
    // All at once, each waiting at most 15 s: a notice is best-effort, and the landing pass awaits them.
    await Promise.all(
      TaskRecords.runningOn(this.db, machine).map(async (task) => {
        const thread = task.threadRef;
        if (!thread || thread.machineId !== machine) return;
        try {
          await this.ports.sendBrief(thread, text, requestId(task, [part, at]));
        } catch (error) {
          console.warn(`the GitHub notice not delivered (${task.taskId}):`, error);
        }
      }),
    );
  }

  /** A task waiting for a slot, as its spawn answers. */
  queuedNext(task: Task): string | undefined {
    if (task.state !== "queued") return undefined;
    const position = slots(this.hub).position(task.taskId);
    if (position === undefined || task.queuedReason === undefined) return undefined;
    return `queued: ${task.queuedReason}, starts when a slot frees, position ${position}. fleetd starts it by itself; don't spawn it again.`;
  }

  /** The project's other writers that have started, with the first files each changed so far, for a writer's spawn. */
  async alsoWriting(task: Task, observed: Observed): Promise<string | undefined> {
    if (task.kind !== "write") return undefined;
    const others = (["running", "idle"] as TaskState[])
      .flatMap((state) => this.tryDb(() => this.list({ projectRef: task.projectRef, state, limit: ALSO_WRITING_MAX })) ?? [])
      .filter((t) => t.kind === "write" && t.taskId !== task.taskId && t.repoId === task.repoId)
      .slice(0, ALSO_WRITING_MAX);
    if (others.length === 0) return undefined;
    // Undefined: its node didn't say, or not within OBSERVE_TIMEOUT_MS.
    const changes = await Promise.all(
      others.map(async (t) => {
        const known = observed.paths.get(t.taskId);
        if (known) return known;
        if (observed.unknown.has(t.taskId)) return undefined;
        if (!t.threadRef) return [];
        return (await within(OBSERVE_TIMEOUT_MS, this.ports.changes(t.threadRef)))?.paths;
      }),
    );
    const lines = others.map((t, i) => {
      const p = changes[i];
      const paths =
        p === undefined
          ? "changes unknown"
          : p.length === 0
            ? "no changes yet"
            : p.length > ALSO_WRITING_PATHS
              ? `${p.slice(0, ALSO_WRITING_PATHS).join(", ")}, +${p.length - ALSO_WRITING_PATHS} more`
              : p.join(", ");
      return `${t.taskId} ${t.title} (${paths})`;
    });
    return `also writing: ${lines.join("; ")}`;
  }

  /** The project's agents against its max agents, from the slot board. */
  agents(r: ProjectRef): { running: number; cap: number; queued: number; source: string; idleSinceMs: number; idleMinutes: number } {
    const a = slots(this.hub).agents(r);
    const source =
      a.source.kind === "project"
        ? "max agents set"
        : a.source.kind === "fleet"
          ? "fleet cap set"
          : a.source.kind === "machine"
            ? "machine cap set"
            : `auto: ${a.source.why}`;
    return {
      running: a.running,
      cap: a.maxAgents,
      queued: a.queued,
      source,
      idleSinceMs: a.movedMs,
      idleMinutes: Math.trunc(Math.max(this.now() - a.movedMs, 0) / 60_000),
    };
  }

  live(r: ProjectRef | undefined): { taskId: TaskId; projectRef: ProjectRef }[] {
    return LIVE_TASKS.flatMap((state) =>
      (this.tryDb(() => this.list({ ...(r ? { projectRef: r } : {}), state, limit: SCAN_LIMIT })) ?? []).map((t) => ({
        taskId: t.taskId,
        projectRef: t.projectRef,
      })),
    );
  }

  /** The workstream's live tasks in the project, oldest first. */
  liveIn(r: ProjectRef, workstreamId: WorkstreamId): TaskId[] {
    return (this.tryDb(() => this.list({ projectRef: r, workstreamId, limit: SCAN_LIMIT })) ?? [])
      .filter((t) => LIVE_TASKS.includes(t.state))
      .map((t) => t.taskId)
      .reverse();
  }

  /** `cancel({ projectRef, by: "hub" }, taskId, reason)` for a removed project, errors ignored. */
  async cancelForRemoval(r: ProjectRef, taskId: TaskId, reason: string): Promise<void> {
    try {
      await this.cancel({ projectRef: r, by: "hub" }, taskId, reason);
    } catch {}
  }

  // --- cap.rs: pausing the agents above a lowered max ---

  /**
   * Tells each running writer or reader above `maxAgents` to push its work and end its turn, and queues it with a
   * resume message. One the node can't reach, or one waiting on its lead's answer, keeps running.
   */
  async pauseExtras(r: ProjectRef, maxAgents: number): Promise<TaskId[]> {
    // Starts in flight are recorded first, so a task one starts is paused as it runs.
    const release = await this.lockSettled();
    try {
      const paused: TaskId[] = [];
      for (const holder of slots(this.hub).extras(r)) {
        const stored = this.tryDb(() => TaskRecords.get(this.db, holder));
        if (!stored) continue;
        const task = stored.task;
        const thread = task.state === "running" ? task.threadRef : undefined;
        if (!thread || this.asking.has(task.taskId)) continue;
        const set = prompts(this.hub.db).forThread(thread.machineId, thread.threadId);
        const pause = set.render("task.pause", { maxAgents });
        try {
          // Under the tasks lock: a busy node holds it up 15 s at most, not two minutes.
          await this.ports.sendBrief(thread, pause, requestId(task, ["pause", String(task.attempt)]));
        } catch (error) {
          console.warn(`pause not delivered; the agent keeps running (${holder}):`, error);
          continue;
        }
        try {
          this.queue({ task: { ...task, attempt: task.attempt + 1 }, pendingMessage: set.render("task.resume", {}) }, "paused", pausedReasonOf(maxAgents));
          paused.push(task.taskId);
        } catch (error) {
          console.warn(`paused agent not queued (${holder}):`, error);
        }
      }
      return paused;
    } finally {
      release();
    }
  }

  // --- sweep.rs: the sweep's check and the machine breaker ---

  /** The sweep's check: the breakers' quiet spells, orphaned tasks, and sessions nobody owns. */
  async sweep(): Promise<void> {
    await this.lock.with(async () => {
      // Events appended but not yet applied aren't orphans: apply them first.
      await this.catchUp();
      await this.retryQueue();
      const now = this.now();
      let failed: unknown;
      try {
        await this.reconcile(now);
      } catch (error) {
        failed = error;
      }
      this.unownedSessions(now);
      if (failed) throw failed;
    });
  }

  private async reconcile(now: number): Promise<void> {
    for (const task of this.list({ state: "running", limit: 10_000 })) {
      const thread = task.threadRef;
      if (!thread) continue;
      // Unreachable is not dead: it waits for its node. One whose start is with the node is recorded once it answers.
      if (!this.ports.isConnected(thread.machineId) || this.continuing.has(task.taskId) || this.starting.has(task.taskId)) continue;
      const row = store(this.hub).threadGet(thread);
      const known = row && !row.thread.stale ? row : undefined;
      if (known && (known.thread.status === "running" || known.thread.status === "waiting" || known.thread.status === "idle")) continue;
      const last = this.lastEventMs(thread);
      if (last !== undefined && now - last < ORPHAN_MS) continue;
      const stored = TaskRecords.get(this.db, task.taskId);
      if (!stored) continue;
      if (known) {
        const event = this.endEvent(thread, known.lastRunId) ?? syntheticEnd(task, thread, known, now);
        console.warn(`sweep: a running task's end was never applied; applying it now (${task.taskId}, ${event.type})`);
        await this.onThreadEvent(event);
      } else {
        const machine = thread.machineId;
        console.warn(`sweep: a running task's node has no session for it (${task.taskId} on ${machine})`);
        await this.finish(
          stored,
          "failed",
          `[session_lost] the node on ${machine} has no session for this agent any more`,
          undefined,
          "its node no longer has its session, so it can't be resumed in it",
        );
      }
    }
  }

  /** When the hub last logged anything about the thread. */
  private lastEventMs(thread: ThreadRef): number | undefined {
    const row = this.db
      .query<{ at: number | null }, [string, string]>("SELECT MAX(created_ms) AS at FROM events WHERE machine_id = ? AND json_extract(data, '$.threadId') = ?")
      .get(thread.machineId, thread.threadId);
    return row?.at ?? undefined;
  }

  /** The first end the hub logged for the thread's run `run`. */
  private endEvent(thread: ThreadRef, run: string | undefined): HubEvent | undefined {
    if (run === undefined) return undefined;
    const row = this.db
      .query<{ seq: number; data: string }, [string, string, string, string]>(
        `SELECT seq, data FROM events
         WHERE type IN (SELECT value FROM json_each(?1)) AND machine_id = ?2
           AND json_extract(data, '$.threadId') = ?3 AND json_extract(data, '$.data.runId') = ?4
         ORDER BY seq LIMIT 1`,
      )
      .get(JSON.stringify(END_EVENTS), thread.machineId, thread.threadId, run);
    return row ? storedEvent(row.seq, row.data) : undefined;
  }

  /** Reports each running session on a linked node that no task or lead owns, once it was so for ORPHAN_MS. */
  private unownedSessions(now: number): void {
    const seen = new Set<string>();
    for (const thread of store(this.hub).threadsRunning()) {
      const r: ThreadRef = { machineId: thread.machineId, threadId: thread.threadId };
      if (!this.ports.isConnected(r.machineId) || this.ownedThread(r)) continue;
      const key = threadKey(r);
      seen.add(key);
      const entry = this.unowned.get(key) ?? [r, now, false];
      const due = !entry[2] && now - entry[1] >= ORPHAN_MS;
      this.unowned.set(key, [r, entry[1], entry[2] || due]);
      if (!due) continue;
      console.warn(`sweep: a session nobody owns (${r.machineId}/${r.threadId})`);
      events(this.hub).append({
        at: isoMs(now),
        type: "thread.orphaned",
        machineId: r.machineId,
        projectId: thread.projectId,
        threadId: r.threadId,
        summary: renderSummary(`${r.machineId} runs "${thread.title}", a session no agent or lead of this hub owns`),
        data: { title: thread.title, since: isoMs(entry[1]) },
        attention: "loud",
      } as NewEvent);
    }
    for (const key of this.unowned.keys()) if (!seen.has(key)) this.unowned.delete(key);
  }

  /** Whether a task, a lead, a memory refresh, a memory import or an approval check runs in the thread. */
  private ownedThread(r: ThreadRef): boolean {
    if (TaskRecords.byThread(this.db, r)) return true;
    const row = this.db
      .query<{ owned: number }, [string, string]>(
        `SELECT (EXISTS (SELECT 1 FROM leads WHERE machine_id = ?1 AND thread_id = ?2)
           OR EXISTS (SELECT 1 FROM memory_refreshes WHERE machine_id = ?1 AND thread_id = ?2)
           OR EXISTS (SELECT 1 FROM memory_imports WHERE machine_id = ?1 AND thread_id = ?2)
           OR EXISTS (SELECT 1 FROM approval_checks WHERE machine_id = ?1 AND thread_id = ?2)) AS owned`,
      )
      .get(r.machineId, r.threadId);
    return Boolean(row?.owned);
  }

  /** The reported sessions on the machine that no task or lead owns, for the doctor. */
  unownedOn(machine: MachineId): Unowned[] {
    return [...this.unowned.values()]
      .filter(([r, , reported]) => reported && r.machineId === machine)
      .map(([r]) => ({ threadId: r.threadId, title: this.tryDb(() => store(this.hub).threadGet(r))?.thread.title ?? "" }))
      .sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
  }

  /** The machine's breaker while it is open, for the doctor. */
  recoveryPausedOn(machine: MachineId): Paused | undefined {
    return this.breakers.paused(machine);
  }

  /** Counts a death toward its machine's breaker; what opened, if this opened it. Only exits and stalls count. */
  private countDeath(task: Task, kind: recovery.Kind): Opened | undefined {
    if (kind !== "Exited" && kind !== "Stalled") return undefined;
    return this.breakers.death(runsOnLine(task), task.taskId, this.now());
  }

  /** Whether the task waits on its machine's breaker. */
  private held_(task: Task): boolean {
    return this.breakers.holds(runsOnLine(task), task.taskId);
  }

  /** A dead task about to resume waits instead while its machine's breaker is open, and says so. */
  private holdIfPaused(taskId: TaskId, machine: MachineId): void {
    const stored = TaskRecords.get(this.db, taskId);
    if (!stored) return;
    const recovering = stored.task.state === "queued" && stored.task.recovery?.nextAt !== undefined;
    if (!recovering || !this.breakers.hold(machine, taskId)) return;
    const paused = this.breakers.paused(machine);
    if (!paused) return;
    this.queue(
      stored,
      "recover",
      `recovering: automatic recovery is paused on ${machine} after ${paused.openedBy.length} agents died there; resumes after ${clockTime(paused.untilMs)}`,
    );
  }

  /** The breaker on `machine` opened: dead agents there wait on it, and the leads of them and of the dead are told. */
  private recoveryPaused(machine: MachineId, opened: Opened): void {
    for (const stored of TaskRecords.queued(this.db)) if (runsOnLine(stored.task) === machine) this.holdIfPaused(stored.task.taskId, machine);
    const held = this.breakers.paused(machine)?.held ?? [];
    const leads = new Map<string, [ProjectRef, TaskId[]]>();
    for (const taskId of [...opened.taskIds, ...held]) {
      const stored = TaskRecords.get(this.db, taskId);
      if (!stored) continue;
      const r = stored.task.projectRef;
      const key = projectKey(r);
      const entry = leads.get(key) ?? [r, []];
      leads.set(key, entry);
      if (held.includes(taskId) && !entry[1].includes(taskId)) entry[1].push(taskId);
    }
    const summary = `automatic recovery paused on ${machine}: ${opened.taskIds.length} agents died there within ${WINDOW_MS / 60_000} min (${list(opened.taskIds)})`;
    console.warn(`tasks: machine breaker open: ${summary}`);
    this.breakerEvent(machine, summary, { paused: true, taskIds: opened.taskIds, until: isoMs(opened.untilMs) });
    // Rust's BTreeMap: the leads in key order.
    for (const key of [...leads.keys()].sort()) {
      const [r, waiting] = leads.get(key) as [ProjectRef, TaskId[]];
      this.ports.wake(r, "recovery_paused", pausedLines(machine, opened.taskIds, opened.untilMs, waiting));
    }
    this.retryAt(opened.untilMs);
  }

  /** Closes the machine's breaker, if open: `completed`, an agent there that got its work done, or its quiet spell. */
  private closeBreaker(machine: MachineId, completed: Task | undefined): void {
    const held = this.breakers.close(machine);
    if (!held) return;
    const why = completed ? `${completed.taskId} completed there` : `no agent died there for ${QUIET_MS / 60_000} min`;
    const resumes = held.length === 0 ? "" : `; ${list(held)} resume${held.length === 1 ? "s" : ""}`;
    const summary = `automatic recovery resumes on ${machine}: ${why}${resumes}`;
    console.info(`tasks: machine breaker closed: ${summary}`);
    this.breakerEvent(machine, summary, { paused: false });
  }

  /** Closes every breaker whose quiet spell is over. The caller runs the queue. */
  private closeQuietBreakers(now: number): void {
    for (const machine of this.breakers.quiet(now)) {
      try {
        this.closeBreaker(machine, undefined);
      } catch (error) {
        console.warn("tasks: breaker close not recorded:", error);
      }
    }
  }

  private breakerEvent(machine: MachineId, summary: string, data: { paused: boolean; taskIds?: TaskId[]; until?: string }): void {
    events(this.hub).append({
      at: this.nowIso(),
      type: "machine.recovery_paused",
      machineId: machine,
      summary: renderSummary(summary),
      data,
      ...(data.paused ? { attention: "loud" } : {}),
    } as NewEvent);
  }

  /** At hub start: each machine's breaker as its last `machine.recovery_paused` left it, holding its dead agents. */
  private restoreBreakers(): void {
    const latest =
      this.tryDb(() =>
        this.db
          .query<{ created_ms: number; data: string }, []>(
            `SELECT created_ms, data FROM events WHERE seq IN
               (SELECT MAX(seq) FROM events WHERE type = 'machine.recovery_paused' GROUP BY machine_id)`,
          )
          .all(),
      ) ?? [];
    const now = this.now();
    for (const { created_ms: at, data } of latest) {
      let event: HubEvent;
      try {
        event = storedEvent(0, data);
      } catch {
        continue;
      }
      const machine = event.machineId;
      const paused = event.data as { paused?: boolean; taskIds?: TaskId[]; until?: string } | undefined;
      const until = paused?.until !== undefined ? parseMs(paused.until) : undefined;
      if (machine === undefined || paused?.paused !== true || until === undefined) continue;
      this.breakers.restore(machine, { taskIds: paused.taskIds ?? [], untilMs: until }, at);
      for (const stored of this.tryDb(() => TaskRecords.queued(this.db)) ?? []) {
        if (runsOnLine(stored.task) === machine) {
          try {
            this.holdIfPaused(stored.task.taskId, machine);
          } catch {}
        }
      }
      this.retryAt(Math.max(until, now));
    }
  }
}

/** A paused agent's reason, as its task shows it while it waits (cap.rs `paused_reason`). */
const pausedReasonOf = (maxAgents: number) => `paused: max agents lowered to ${maxAgents}; resumes when a slot frees`;

/** The run's end cause a `thread.*` event carries; absent from events of nodes that don't record it. */
function endCauseOf(event: HubEvent): string | undefined {
  const end = (event.data as Record<string, unknown> | undefined)?.endCause;
  return typeof end === "string" ? end : undefined;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** The hub's tasks area: `tasks(hub).spawn(…)`. */
export const tasks = (hub: Hub): Tasks => hub.area("tasks", (h) => new Tasks(h));

