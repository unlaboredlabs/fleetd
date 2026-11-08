// The hub's side of every node's sessions (crates/fleetd/src/hub/executor/mod.rs `Executors`): the node link hands
// each welcomed socket over with `attach`, every session-side frame with `handleFrame`, and its close with
// `detachLink`. The executor subscribes to the machine stream, keeps the hub's thread and project caches from it,
// logs the transitions as events, and makes session calls, matching each reply to its call by frame id.
import type { MachineId, ProjectRef, ThreadId, ThreadRef } from "../../shared/contracts.ts";
import type {
  CloneProgressFrame,
  MachineEvent,
  MachineEventFrame,
  RunnerInfo,
  SessionCall,
  SessionCallFrame,
  SessionError,
  SessionOutput,
  SessionReplyFrame,
  SteerReceipt,
  ThreadEventFrame,
} from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";
import type { Hub } from "../api/hub.ts";
import { ProfileStore } from "../projects/profiles.ts";
import { events, type NewEvent } from "../store/events.ts";
import { type StoredThread as StoreThread, store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import {
  applyMachineEvent,
  fromThread,
  newShellState,
  removedProjects,
  type ShellState,
  type StoredThread,
  type TrackedThread,
  toThread,
  transitionEvent,
} from "./shell_mapper.ts";
import { Views } from "./views.ts";

/** The activity tracker (T2253's src/hub/executor/activity.ts, `hub.area("activity")`), once its area exists. */
type ActivityArea = { onThreadEvent(machineId: MachineId, frame: ThreadEventFrame): void };

/** `hub.peek(name)` (D355): an area another module owns, if it was made; never makes one. */
export const peek = <T>(hub: Hub, name: string): T | undefined => hub.peek<T>(name);

/** A hub -> node frame the executor sends: a session call (node_link.rs `HubToNode::SessionCall`). */
export type HubToNodeSession = { t: "session_call" } & SessionCallFrame;

/** The node -> hub frames the executor takes (node_link.rs `NodeToHub`'s session side). */
export type NodeToHubSession =
  | ({ t: "session_reply" } & SessionReplyFrame)
  | ({ t: "machine_event" } & MachineEventFrame)
  | ({ t: "thread_event" } & ThreadEventFrame)
  | ({ t: "clone_progress" } & CloneProgressFrame);

/** A sender over one welcomed node link, which the link builds per socket. `linkId` tells a newer link from the one it replaced. */
export type NodeSessions = { linkId: number; send(frame: HubToNodeSession): boolean | void };

/** Resubscribe delay: doubles from 1 s to a 30 s cap, ±25 % jitter so machines don't retry in step. */
export function backoffMs(attempt: number, random: number): number {
  const base = 1000 * 2 ** Math.min(attempt, 5) * (0.75 + random * 0.5);
  return Math.min(Math.round(base), 30_000);
}

export const WATCH_IDLE_MS = 60_000;
export const READ_TIMEOUT_MS = 15_000;
/** A launch may create a worktree and spawn claude before the node answers. */
export const LAUNCH_TIMEOUT_MS = 60_000;
/** The node first stops the project's claude processes, then removes its worktrees and a Navi's sign-ins. */
export const REMOVE_TIMEOUT_MS = 70_000;
/** The node's stop waits up to 25 s for claude to exit. */
export const STOP_TIMEOUT_MS = 40_000;
/** The node keeps the last 2000 characters of the assistant's text on the summary. */
export const SUMMARY_TAIL_MAX = 2000;

export type NodeOperation = "launch" | "send" | "interrupt" | "stop" | "answer" | "read" | "project";

/** Why a node request produced no answer (executor/mod.rs `ExecutorError`). */
export class ExecutorError extends Error {
  constructor(
    readonly kind: "not_connected" | "thread_not_found" | "node_failed",
    readonly machineId: MachineId,
    message: string,
    readonly extra: { threadId?: ThreadId; operation?: NodeOperation; nodeMessage?: string; fix?: string } = {},
  ) {
    super(message);
    this.name = "ExecutorError";
  }

  static notConnected(machineId: MachineId): ExecutorError {
    return new ExecutorError("not_connected", machineId, `machine ${machineId} has no live node link`);
  }

  static threadNotFound(machineId: MachineId, threadId: ThreadId): ExecutorError {
    return new ExecutorError("thread_not_found", machineId, `thread ${threadId} is not known on machine ${machineId}`, { threadId });
  }

  /** `message` is the node's own words (or why no answer came); safe to show. */
  static failed(machineId: MachineId, operation: NodeOperation, message: string, fix?: string): ExecutorError {
    return new ExecutorError("node_failed", machineId, `the node on ${machineId} refused or failed the ${operation} request: ${message}`, {
      operation,
      nodeMessage: message,
      ...(fix !== undefined ? { fix } : {}),
    });
  }
}

function fromSessionError(machineId: MachineId, operation: NodeOperation, session: ThreadId | undefined, error: SessionError): ExecutorError {
  if (error.code === "not_found" && session !== undefined && operation !== "answer" && operation !== "launch") {
    return ExecutorError.threadNotFound(machineId, session);
  }
  return ExecutorError.failed(machineId, operation, error.message, error.fix);
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function uuidOf(b: Uint8Array): string {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A random v4-shaped UUID. */
export const newUuid = () => uuidOf(crypto.getRandomValues(new Uint8Array(16)));

/** A v4-shaped UUID derived from `seed`: the same request always names the same session or run. */
export const uuidFrom = (seed: string) => uuidOf(new Bun.CryptoHasher("sha256").update(seed).digest().subarray(0, 16));

export const threadRef = (machineId: MachineId, threadId: string): ThreadRef => ({ machineId, threadId });

function toStored(s: StoreThread): StoredThread {
  return {
    summary: fromThread(s.thread),
    ...(s.lastSequence !== undefined ? { lastSequence: Math.max(0, s.lastSequence) } : {}),
    ...(s.lastRunId !== undefined ? { lastRunId: s.lastRunId } : {}),
    ...(s.lastRunStatus !== undefined ? { lastRunStatus: s.lastRunStatus } : {}),
  };
}

function fromStored(s: StoredThread): StoreThread {
  return {
    thread: toThread(s.summary),
    ...(s.lastSequence !== undefined ? { lastSequence: s.lastSequence } : {}),
    ...(s.lastRunId !== undefined ? { lastRunId: s.lastRunId } : {}),
    ...(s.lastRunStatus !== undefined ? { lastRunStatus: s.lastRunStatus } : {}),
  };
}

/** The node of a live link said it had sent everything it replayed on it. */
export type CaughtUp = { atMs: number; head: number };

type Pending = { resolve: (reply: SessionReplyFrame["result"]) => void; reject: (error: Error) => void };

type Slot = {
  link?: NodeSessions;
  /** Aborted when the link is replaced or dropped: its supervisor stops. */
  stop?: AbortController;
  /** Machine events waiting for the supervisor, applied in order. */
  inbox: MachineEventFrame[];
  wake?: () => void;
  live: boolean;
  liveSinceMs: number;
  caughtUp?: CaughtUp;
  shell: ShellState;
  /** Calls in flight on the current link, by frame id. */
  pending: Map<string, Pending>;
};

/** A watcher of one boolean per machine (the Rust executor's `watch` channels). */
class Flags {
  private readonly values = new Map<MachineId, boolean>();
  private readonly waiters = new Map<MachineId, Set<() => void>>();
  get(m: MachineId): boolean {
    return this.values.get(m) ?? false;
  }
  set(m: MachineId, value: boolean): void {
    if (this.get(m) === value) return;
    this.values.set(m, value);
    const waiting = this.waiters.get(m);
    if (!waiting) return;
    this.waiters.delete(m);
    for (const w of waiting) w();
  }
  /** Resolves once the flag changes. */
  changed(m: MachineId, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(m) ?? new Set();
      this.waiters.set(m, set);
      const done = () => {
        set.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  /** Resolves once the flag is `value`, at once if it is. */
  async until(m: MachineId, value: boolean, signal?: AbortSignal): Promise<void> {
    while (this.get(m) !== value && !signal?.aborted) await this.changed(m, signal);
  }
}

/** Told of each finished command whose output names a GitHub PR (the train). */
export type PrSink = (r: ThreadRef) => void;
/** Told of each skill a session ran with the Skill tool, by the name it ran (the skills area). */
export type SkillSink = (r: ThreadRef, skill: string) => void;
/** Told when a machine's node has reported every run its restart cut off (the tasks area). */
export type CaughtUpSink = (machineId: MachineId) => void;
/** Told of each steer receipt, in stream order (the steer area). */
export type SteerSink = (machineId: MachineId, receipt: SteerReceipt) => void;
/** Told of each clone's progress (the projects area). */
export type CloneSink = (frame: CloneProgressFrame) => void;
/** Told of each thread event of a followed session (the executor's thread views). */
export type ThreadSink = (machineId: MachineId, frame: ThreadEventFrame) => void;

export class Executors {
  private readonly machines = new Map<MachineId, Slot>();
  /** Per machine: true while live. `awaitLive` waits on it. */
  readonly live = new Flags();
  /** Per machine: true once the link server announced the machine online by its runner's verdict. */
  readonly ready = new Flags();
  /** Per machine: the runner as the node last reported it. */
  private readonly runners = new Map<MachineId, RunnerInfo>();
  sinks: {
    pr?: PrSink;
    skill?: SkillSink;
    caughtUp?: CaughtUpSink;
    steer?: SteerSink;
    clone?: CloneSink;
    thread?: ThreadSink;
    /** The time area's cursor of the node's spans outbox, sent with each subscribe. */
    spansAfter?: (machineId: MachineId) => number | undefined;
  } = {};

  /** The followed sessions: tail, actions, work, window. */
  readonly views: Views = new Views(this);

  constructor(readonly hub: Hub) {}

  /** Each thread event to the activity tracker (src/hub/executor/activity.ts, looked up at run time) and the sink. */
  feedActivity(machineId: MachineId, frame: ThreadEventFrame): void {
    try {
      peek<ActivityArea>(this.hub, "activity")?.onThreadEvent(machineId, frame);
    } catch (error) {
      console.error("executor: activity failed on a thread event:", error);
    }
    this.sinks.thread?.(machineId, frame);
  }

  private slot(machineId: MachineId): Slot {
    let slot = this.machines.get(machineId);
    if (!slot) {
      slot = { inbox: [], live: false, liveSinceMs: 0, shell: newShellState(), pending: new Map() };
      this.machines.set(machineId, slot);
    }
    return slot;
  }

  private dropPending(slot: Slot): void {
    for (const p of slot.pending.values()) p.reject(new Error("the node link dropped before the node answered"));
    slot.pending.clear();
  }

  /** Takes over the machine's link and (re)subscribes. Idempotent for the same link. */
  attach(machineId: MachineId, sessions: NodeSessions): void {
    const slot = this.slot(machineId);
    // Two links of one machine can get here in either order: an older one coming late must not take over.
    if (slot.link && slot.link.linkId >= sessions.linkId) return;
    slot.stop?.abort();
    this.endLive(machineId, slot);
    slot.link = sessions;
    slot.inbox = [];
    // Replies to calls on the old link never come: their waiters fail.
    this.dropPending(slot);
    const stop = new AbortController();
    slot.stop = stop;
    void this.supervise(machineId, slot, stop.signal);
  }

  /** Drops the link. The machine's shell state is kept, so a later attach resumes from its cursor. */
  detach(machineId: MachineId): void {
    this.setRunnerReady(machineId, false);
    const slot = this.machines.get(machineId);
    if (!slot) return;
    slot.link = undefined;
    slot.inbox = [];
    this.dropPending(slot);
    slot.stop?.abort();
    slot.stop = undefined;
    this.endLive(machineId, slot);
  }

  /** Drops the link only if it is still `linkId` (a newer link may have taken over). */
  detachLink(machineId: MachineId, linkId: number): void {
    if (this.machines.get(machineId)?.link?.linkId === linkId) this.detach(machineId);
  }

  /** Clears the slot's live flag when a supervisor ends, however it ends. */
  private endLive(machineId: MachineId, slot: Slot): void {
    slot.live = false;
    slot.wake?.();
    this.views.dropMachine(machineId);
    this.live.set(machineId, false);
  }

  isConnected(machineId: MachineId): boolean {
    const slot = this.machines.get(machineId);
    return slot !== undefined && slot.live && slot.link !== undefined;
  }

  /** When the machine's current link went live, in ms; undefined while it has no live link. */
  liveSince(machineId: MachineId): number | undefined {
    return this.isConnected(machineId) ? this.machines.get(machineId)?.liveSinceMs : undefined;
  }

  /** When the node of the live link said it had reported every run its restart cut off. */
  caughtUp(machineId: MachineId): CaughtUp | undefined {
    return this.isConnected(machineId) ? this.machines.get(machineId)?.caughtUp : undefined;
  }

  /** Returns once the machine's node accepted the subscription, at once if it has. */
  awaitLive(machineId: MachineId, signal?: AbortSignal): Promise<void> {
    return this.live.until(machineId, true, signal);
  }

  /** The link server sets this after it announced the machine online, and clears it when the runner turns unusable. */
  setRunnerReady(machineId: MachineId, ready: boolean): void {
    this.ready.set(machineId, ready);
  }

  isReady(machineId: MachineId): boolean {
    return this.ready.get(machineId);
  }

  /** Live, and announced online: what the offline queue waits for before it delivers anything. */
  async awaitReady(machineId: MachineId, signal?: AbortSignal): Promise<void> {
    while (!(this.isConnected(machineId) && this.isReady(machineId)) && !signal?.aborted) {
      // One wait per flag; the one that doesn't fire is taken back, so no waiter outlives its turn.
      const turn = new AbortController();
      const stop = () => turn.abort();
      signal?.addEventListener("abort", stop, { once: true });
      await Promise.race([this.live.changed(machineId, turn.signal), this.ready.changed(machineId, turn.signal)]);
      turn.abort();
      signal?.removeEventListener("abort", stop);
    }
  }

  cachedRunner(machineId: MachineId): RunnerInfo | undefined {
    return this.runners.get(machineId);
  }

  private rememberRunner(machineId: MachineId, info: RunnerInfo): void {
    this.runners.set(machineId, info);
  }

  /** Every session-side frame the node sends, as the link received it. */
  handleFrame(machineId: MachineId, frame: NodeToHubSession): void {
    switch (frame.t) {
      case "session_reply": {
        const slot = this.machines.get(machineId);
        const pending = slot?.pending.get(frame.id);
        if (!slot || !pending) return;
        slot.pending.delete(frame.id);
        pending.resolve(frame.result);
        return;
      }
      case "machine_event": {
        if (frame.event.type === "runner_info") {
          const { type: _type, ...info } = frame.event;
          this.rememberRunner(machineId, info);
        }
        if (frame.event.type === "session_updated") this.views.touched(threadRef(machineId, frame.event.sessionId));
        const slot = this.machines.get(machineId);
        if (!slot?.link) return;
        slot.inbox.push({ seq: frame.seq, at: frame.at, event: frame.event });
        slot.wake?.();
        return;
      }
      case "thread_event": {
        const { t: _t, ...thread } = frame;
        this.views.applyFrame(machineId, thread);
        this.feedActivity(machineId, thread);
        return;
      }
      case "clone_progress": {
        const { t: _t, ...progress } = frame;
        this.sinks.clone?.(progress);
        return;
      }
    }
  }

  /** One `session_call` and its `session_reply`, at most `waitMs`. */
  async call(machineId: MachineId, operation: NodeOperation, call: SessionCall, waitMs: number): Promise<SessionOutput> {
    const session = "sessionId" in call && call.op !== "launch" && call.op !== "read_image" && call.op !== "window" && call.op !== "release" && call.op !== "withdraw"
      ? call.sessionId
      : undefined;
    const slot = this.machines.get(machineId);
    const link = slot?.link;
    if (!slot || !link) throw ExecutorError.notConnected(machineId);
    const id = newUuid();
    const reply = new Promise<SessionReplyFrame["result"]>((resolve, reject) => slot.pending.set(id, { resolve, reject }));
    let sent: boolean | void;
    try {
      sent = link.send({ t: "session_call", id, call });
    } catch {
      sent = false;
    }
    // A link that refuses the frame (its socket closed) is no live link, as Rust's failed `send` is.
    if (sent === false) {
      slot.pending.delete(id);
      throw ExecutorError.notConnected(machineId);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    let result: SessionReplyFrame["result"] | "timeout";
    try {
      result = await Promise.race([reply, timeout]);
    } catch (error) {
      throw ExecutorError.failed(machineId, operation, (error as Error).message);
    } finally {
      clearTimeout(timer);
    }
    if (result === "timeout") {
      slot.pending.delete(id);
      throw ExecutorError.failed(machineId, operation, `no answer within ${Math.floor(waitMs / 1000)} s`);
    }
    if ("ok" in result) return result.ok;
    throw fromSessionError(machineId, operation, session, result.err);
  }

  /** One link's lifetime: subscribe after the stored cursor, then apply the machine stream until detached. */
  private async supervise(machineId: MachineId, slot: Slot, signal: AbortSignal): Promise<void> {
    const cursor = store(this.hub).cursorGet(machineId);
    // A replay only carries changed rows, and project counts need every row, so the first stream in this process
    // starts from a snapshot; it is diffed against the stored summaries, so nothing is missed.
    const after = slot.shell.complete && cursor !== undefined ? Math.max(0, cursor) : undefined;
    const baseline = cursor === undefined;
    // The agents' Mac hosts no session and refuses a subscription: its link is live once it is up.
    const toolOnly = store(this.hub).machineGet(machineId)?.agentsMac === true;
    for (let attempt = 0; !toolOnly && !signal.aborted; ) {
      try {
        const spansAfter = this.sinks.spansAfter?.(machineId);
        await this.call(
          machineId,
          "read",
          { op: "subscribe", ...(after !== undefined ? { after } : {}), ...(spansAfter !== undefined ? { spansAfter } : {}), caughtUp: true },
          READ_TIMEOUT_MS,
        );
        break;
      } catch (error) {
        if (error instanceof ExecutorError && error.kind === "not_connected") return;
        if (signal.aborted) return;
        const delay = backoffMs(attempt++, Math.random());
        console.warn(`node ${machineId} refused the session subscription; retrying in ${delay} ms: ${(error as Error).message}`);
        await sleep(delay, signal);
      }
    }
    if (signal.aborted) return;
    slot.live = true;
    slot.liveSinceMs = this.hub.clock.now();
    slot.caughtUp = undefined;
    this.live.set(machineId, true);
    // One abort listener for the link's life, waking whichever wait is current.
    const wake = () => slot.wake?.();
    signal.addEventListener("abort", wake, { once: true });
    while (!signal.aborted) {
      const frame = slot.inbox.shift();
      if (!frame) {
        await new Promise<void>((resolve) => {
          slot.wake = resolve;
        });
        slot.wake = undefined;
        continue;
      }
      try {
        await this.handleMachineEvent(machineId, frame.seq, frame.event, baseline);
      } catch (error) {
        console.error(`executor: machine event from ${machineId} failed:`, error);
      }
    }
    signal.removeEventListener("abort", wake);
  }

  /** Applies one machine stream event: caches, the event log, the cursor. */
  async handleMachineEvent(machineId: MachineId, seq: number | undefined, event: MachineEvent, baseline: boolean): Promise<void> {
    if (event.type === "caught_up") return this.caughtUpNow(machineId);
    this.followActive(machineId, event);
    this.flagRefused(machineId, event);
    if (event.type === "steer") {
      const { type: _type, ...receipt } = event;
      this.sinks.steer?.(machineId, receipt);
    }
    const slot = this.machines.get(machineId);
    if (!slot) return;
    const ids =
      event.type === "snapshot" ? event.sessions.map((s) => s.sessionId) : event.type === "session_updated" ? [event.sessionId] : [];
    const stored = new Map<string, StoredThread>();
    for (const id of ids.filter((id) => !slot.shell.threads.has(id))) {
      const row = store(this.hub).threadGet(threadRef(machineId, id));
      if (row) stored.set(id, toStored(row));
    }
    const now = isoMs(this.hub.clock.now());
    const applied = applyMachineEvent(slot.shell, seq, event, { machineId, now, stored, baseline });
    const upserts: StoredThread[] = [];
    for (const t of applied.threads) {
      const at = upserts.findIndex((u) => u.summary.threadId === t.summary.threadId);
      if (at >= 0) upserts[at] = t;
      else upserts.push(t);
    }
    // TODO(executor): a long reply's headline from a thread read, once the thread views are ported.
    for (const u of upserts) {
      try {
        store(this.hub).threadUpsert(fromStored(u));
      } catch (error) {
        console.error("executor: thread write failed:", error);
      }
    }
    if (applied.projects.length > 0) {
      try {
        store(this.hub).projectsUpsertMany(machineId, applied.projects as never);
      } catch (error) {
        console.error("executor: project write failed:", error);
      }
    }
    if (applied.present) {
      // Rows the node has no session for never resume.
      try {
        store(this.hub).threadsMarkStale(machineId, applied.present, now);
      } catch (error) {
        console.error("executor: stale marking failed:", error);
      }
    }
    if (event.type === "project_removed" || event.type === "snapshot") this.pruneProjects(machineId, slot, event, now);
    for (const t of applied.transitions) {
      const tracked = slot.shell.threads.get(t.threadId);
      if (tracked) this.append(transitionEvent(t, tracked, machineId));
    }
    if (applied.cursor !== undefined) {
      try {
        store(this.hub).cursorSet(machineId, applied.cursor);
      } catch (error) {
        console.error("executor: cursor write failed:", error);
      }
    }
  }

  /**
   * Follows a session the moment a run of it is active, and lets the follow idle out once none is, so the live lanes
   * see its tool calls, text and usage from the start.
   */
  private followActive(machineId: MachineId, event: MachineEvent): void {
    const sessions = event.type === "snapshot" ? event.sessions : event.type === "session_updated" ? [event] : [];
    for (const s of sessions) {
      const active = s.activeRunId !== undefined || s.status === "running" || s.status === "waiting";
      const r = threadRef(machineId, s.sessionId);
      if (active) {
        if (!this.views.pin(r)) void this.views.follow(r).catch(() => {});
      } else if (this.views.isFollowed(r)) this.views.release(r);
    }
  }

  /** A session whose model claude refused runs on the runner's own: the profiles on that model are marked refused. */
  private flagRefused(machineId: MachineId, event: MachineEvent): void {
    const sessions = event.type === "snapshot" ? event.sessions : event.type === "session_updated" ? [event] : [];
    for (const s of sessions) {
      if (s.modelRefused === undefined) continue;
      const why = `claude on ${machineId} refused ${s.modelRefused} at ${s.createdAt}: agents run on ${s.model} instead until you set this again.`;
      try {
        if (new ProfileStore(this.hub.db.conn).refuse(s.modelRefused, s.createdAt, why)) {
          console.warn(`claude on ${machineId} refused ${s.modelRefused}; its profiles flagged`);
        }
      } catch (error) {
        console.warn("a refused model was not flagged:", error);
      }
    }
  }

  /** The node's replay is applied, so every run its restart cut off is logged by now. */
  private caughtUpNow(machineId: MachineId): void {
    const slot = this.machines.get(machineId);
    if (!slot) return;
    slot.caughtUp = { atMs: this.hub.clock.now(), head: events(this.hub).head() };
    this.sinks.caughtUp?.(machineId);
  }

  /** Projects the node removed: dropped from the cache, each with a project.removed event. */
  private pruneProjects(machineId: MachineId, slot: Slot, event: MachineEvent, now: string): void {
    const cached = store(this.hub).projectsList(machineId);
    for (const projectId of removedProjects(slot.shell, event, cached.map((p) => p.projectId))) {
      const title = cached.find((p) => p.projectId === projectId)?.title ?? projectId;
      const r: ProjectRef = { machineId, projectId };
      try {
        store(this.hub).projectRemove(r);
      } catch (error) {
        console.error("executor: project remove failed:", error);
      }
      this.append({
        at: now,
        type: "project.removed",
        machineId,
        projectId,
        summary: jsPrefix(`Project "${title}" on ${machineId} was removed`, 200),
        data: { title },
      });
    }
  }

  private append(event: NewEvent): void {
    try {
      events(this.hub).append(event);
    } catch (error) {
      console.error("executor: event append failed:", error);
    }
  }

  /** The thread as the machine stream last said, while this hub has seen it. */
  tracked(r: ThreadRef): TrackedThread | undefined {
    return this.machines.get(r.machineId)?.shell.threads.get(r.threadId);
  }

  /** Threads running now on every live machine, by the machine stream. */
  running(): { thread: ThreadRef; projectId: string; runId?: string }[] {
    const out: { thread: ThreadRef; projectId: string; runId?: string }[] = [];
    for (const [machineId, slot] of this.machines) {
      if (!slot.live) continue;
      for (const [id, t] of slot.shell.threads) {
        if (t.summary.status !== "running" && t.summary.status !== "waiting") continue;
        out.push({ thread: threadRef(machineId, id), projectId: t.summary.projectId, ...(t.activeRunId ? { runId: t.activeRunId } : {}) });
      }
    }
    return out;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The hub's executor, `hub.area("executors")`. */
export const executors = (hub: Hub) => hub.area("executors", (h) => new Executors(h));
