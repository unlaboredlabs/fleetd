// The executor's followed sessions (crates/fleetd/src/hub/executor/mod.rs `view`, `follow_thread`, `fill_outputs`,
// `tail`, `work`, `messages`, `reads`, `actions`, `window`, `follow`, `release`, `progress`): a thread read follows its
// session on its node (`follow`), keeps the node's snapshot plus the live events after it, and releases it once
// nobody has read it for a minute (a pinned follow stays until released).
import type { MachineId, ThreadRef } from "../../shared/contracts.ts";
import type { ThreadEventFrame, ThreadItem, ThreadMessage } from "../../shared/sessions.ts";
import { clip } from "../api/refusals.ts";
import { store } from "../store/hub_store.ts";
import type { ExecutorError as ExecutorErrorType, Executors } from "./index.ts";
import { ExecutorError, READ_TIMEOUT_MS, WATCH_IDLE_MS } from "./index.ts";
import { fromThread, type Summary, withAssistantText } from "./shell_mapper.ts";
import {
  type Action,
  actionsOf,
  applyThreadEvent,
  latestAssistantText,
  newView,
  omittedOutputs,
  type OpenTool,
  openTool,
  readOf,
  type TailRow,
  tailOf,
  type ThreadView,
  toAction,
  workPage,
} from "./thread_view.ts";

type Ready = { state: "pending" } | { state: "open" } | { state: "failed"; error: ExecutorErrorType };

class Watch {
  view: ThreadView = newView();
  lastUsedMs: number;
  /** Any machine or thread frame for the session counts as progress; starts at the follow's opening. */
  lastFrameMs: number;
  /** Followed by the watchdog or an active run: stays open however long nobody reads it. */
  pinned = false;
  ready: Ready = { state: "pending" };
  private readonly waiters = new Set<() => void>();
  /** Ends the follow's idle wait early: its link dropped. */
  readonly stop = new AbortController();
  /** Wakes the idle wait when the watch is used or unpinned. */
  nudge: (() => void) | undefined;

  constructor(now: number) {
    this.lastUsedMs = now;
    this.lastFrameMs = now;
  }

  /** Settles a pending watch; a ready one stays ready. */
  settle(to: Ready): void {
    if (this.ready.state !== "pending") return;
    this.ready = to;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** Resolves once settled, or after `ms`. */
  async settled(ms: number): Promise<Ready | undefined> {
    if (this.ready.state !== "pending") return this.ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      timer = setTimeout(done, ms);
    });
    return this.ready.state === "pending" ? undefined : this.ready;
  }
}

/** Set while the session is followed: when its last frame came, and the open tool calls of its active run. */
export type Progress = { lastFrameMs: number; tool?: OpenTool };

export type Tail = { items: TailRow[]; thread: Summary; truncated: boolean };
export type Work = { rows: [string, TailRow][]; more: boolean; running: boolean };

const keyOf = (r: ThreadRef) => `${r.machineId}\u0000${r.threadId}`;

/** A Command that finished with a GitHub PR URL in its output. */
export function namesAPr(item: ThreadItem): boolean {
  return item.kind.type === "command" && item.status === "completed" && item.kind.output !== undefined && item.kind.output.includes("github.com/") && item.kind.output.includes("/pull/");
}

/** The skill a finished Skill call ran, as the session lists it. */
export function skillRan(item: ThreadItem): string | undefined {
  if (item.kind.type !== "tool" || item.kind.toolName !== "Skill" || item.status !== "completed") return undefined;
  const input = item.kind.input as Record<string, unknown> | null;
  for (const k of ["skill", "command"]) if (typeof input?.[k] === "string") return input[k] as string;
  return undefined;
}

export class Views {
  private readonly watches = new Map<string, Watch>();
  private hooked = false;

  constructor(private readonly ex: Executors) {}

  private now(): number {
    return this.ex.hub.clock.now();
  }

  /** A link went down: every follow of the machine fails, so the next read follows afresh. */
  dropMachine(machineId: MachineId): void {
    for (const [k, w] of this.watches) {
      if (!k.startsWith(`${machineId}\u0000`)) continue;
      this.watches.delete(k);
      w.stop.abort();
      w.settle({ state: "failed", error: ExecutorError.notConnected(machineId) });
    }
  }

  /** One thread frame of a followed session. */
  applyFrame(machineId: MachineId, frame: ThreadEventFrame): void {
    const r = { machineId, threadId: frame.sessionId };
    const w = this.watches.get(keyOf(r));
    if (!w) return;
    w.lastFrameMs = this.now();
    applyThreadEvent(w.view, frame.event);
    if (w.view.ready) w.settle({ state: "open" });
    if (frame.event.type === "item") {
      const { type: _type, ...item } = frame.event;
      if (namesAPr(item)) this.ex.sinks.pr?.(r);
      const skill = skillRan(item);
      if (skill !== undefined) this.ex.sinks.skill?.(r, skill);
    }
  }

  /** A machine frame of a session counts as progress of its follow. */
  touched(r: ThreadRef): void {
    const w = this.watches.get(keyOf(r));
    if (w) w.lastFrameMs = this.now();
  }

  /** The thread's live view, following the session if nobody does yet. */
  async view(r: ThreadRef): Promise<Watch> {
    if (!this.ex.isConnected(r.machineId)) throw ExecutorError.notConnected(r.machineId);
    if (!this.hooked) {
      // A stopping hub ends every follow's idle wait.
      this.hooked = true;
      this.ex.hub.shutdown.signal.addEventListener("abort", () => {
        for (const w of this.watches.values()) w.stop.abort();
      });
    }
    let w = this.watches.get(keyOf(r));
    if (!w) {
      w = new Watch(this.now());
      this.watches.set(keyOf(r), w);
      void this.followThread(r, w);
    }
    w.lastUsedMs = this.now();
    w.nudge?.();
    const ready = await w.settled(READ_TIMEOUT_MS);
    if (!ready) throw ExecutorError.failed(r.machineId, "read", "no thread snapshot within 15 s");
    if (ready.state === "failed") throw ready.error;
    return w;
  }

  /** Follows one session until the follow fails, or until it is unpinned and nobody read it for WATCH_IDLE_MS. */
  private async followThread(r: ThreadRef, w: Watch): Promise<void> {
    let end: ExecutorErrorType;
    try {
      const out = await this.ex.call(r.machineId, "read", { op: "follow", sessionId: r.threadId }, READ_TIMEOUT_MS);
      if (out.kind === "snapshot") {
        const { kind: _kind, ...snapshot } = out;
        applyThreadEvent(w.view, { type: "snapshot", ...snapshot });
        this.ex.feedActivity(r.machineId, { sessionId: r.threadId, at: new Date(this.now()).toISOString(), event: { type: "snapshot", ...snapshot } });
        w.settle({ state: "open" });
      }
      for (;;) {
        const idle = Math.max(0, this.now() - w.lastUsedMs);
        if ((idle >= WATCH_IDLE_MS && !w.pinned) || w.stop.signal.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, w.pinned ? WATCH_IDLE_MS : WATCH_IDLE_MS - idle);
          function done() {
            clearTimeout(timer);
            w.stop.signal.removeEventListener("abort", done);
            w.nudge = undefined;
            resolve();
          }
          w.nudge = done;
          w.stop.signal.addEventListener("abort", done, { once: true });
        });
      }
      if (!w.stop.signal.aborted) {
        try {
          await this.ex.call(r.machineId, "read", { op: "release", sessionId: r.threadId }, READ_TIMEOUT_MS);
        } catch {}
      }
      end = ExecutorError.failed(r.machineId, "read", "the follow went idle");
    } catch (error) {
      end = error instanceof ExecutorError ? error : ExecutorError.failed(r.machineId, "read", (error as Error).message);
    }
    if (this.watches.get(keyOf(r)) === w) this.watches.delete(keyOf(r));
    w.settle({ state: "failed", error: end });
  }

  /** Fills in the outputs the bounded snapshot cut, for the items about to be returned; four fetches at a time. */
  private async fillOutputs(r: ThreadRef, w: Watch, ids: string[]): Promise<void> {
    const omitted = omittedOutputs(w.view, ids);
    let failed: unknown;
    for (let i = 0; i < omitted.length; i += 4) {
      const results = await Promise.allSettled(
        omitted.slice(i, i + 4).map((itemId) => this.ex.call(r.machineId, "read", { op: "read_item", sessionId: r.threadId, itemId }, READ_TIMEOUT_MS)),
      );
      // Every fetch that worked is kept, even when another failed: that one keeps its stored tail.
      for (const res of results) {
        if (res.status === "fulfilled") {
          if (res.value.kind === "item") w.view.items.set(res.value.item.id, res.value.item);
        } else failed ??= res.reason;
      }
    }
    if (failed !== undefined) throw failed;
  }

  /** The thread's summary from the shell, else the store. */
  private summaryOf(r: ThreadRef): Summary {
    const tracked = this.ex.tracked(r);
    if (tracked) return tracked.summary;
    const stored = store(this.ex.hub).threadGet(r);
    if (!stored) throw ExecutorError.threadNotFound(r.machineId, r.threadId);
    return fromThread(stored.thread);
  }

  private refreshed(w: Watch, rows: [string, TailRow][]): [string, TailRow][] {
    return rows.map(([id, row]) => {
      if (row.kind !== "action") return [id, row];
      const item = w.view.items.get(id);
      const action = (item && toAction(item)) ?? row.action;
      return [id, { kind: "action", at: row.at, action }];
    });
  }

  /** Newest first. `kinds` are "message" and "action"; none means both. */
  async tail(r: ThreadRef, n: number, kinds: string[] | undefined): Promise<Tail> {
    const summary = this.summaryOf(r);
    const w = await this.view(r);
    const [rows, truncated] = tailOf(w.view, n, kinds);
    await this.fillOutputs(
      r,
      w,
      rows.filter(([, row]) => row.kind === "action").map(([id]) => id),
    );
    const items = this.refreshed(w, rows).map(([, row]) => row);
    return { items, thread: withAssistantText(summary, latestAssistantText(w.view)), truncated };
  }

  /** A page of the session's steps for the agents view, newest first, strictly older than `before`. */
  async work(r: ThreadRef, before: [string, string] | undefined, limit: number): Promise<Work> {
    const summary = this.summaryOf(r);
    const w = await this.view(r);
    const [rows, more] = workPage(w.view, before, limit);
    await this.fillOutputs(
      r,
      w,
      rows.filter(([, row]) => row.kind === "action").map(([id]) => id),
    );
    return { rows: this.refreshed(w, rows), more, running: summary.status === "running" };
  }

  /** The thread's latest assistant message whole, read from its followed view (the summary keeps only its ends). */
  async latestText(r: ThreadRef): Promise<string | undefined> {
    return latestAssistantText((await this.view(r)).view);
  }

  /** The session's messages as its view holds them, oldest first. */
  async messages(r: ThreadRef): Promise<ThreadMessage[]> {
    this.summaryOf(r);
    const w = await this.view(r);
    return [...w.view.messages.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** What the session read lately: its newest tool calls and commands, each with its call and whole output. */
  async reads(r: ThreadRef, limit: number): Promise<[string, string][]> {
    this.summaryOf(r);
    const w = await this.view(r);
    const ids = actionsOf(w.view, limit, false).map(([id]) => id);
    // A whole output that couldn't be fetched leaves its tail.
    try {
      await this.fillOutputs(r, w, ids);
    } catch (error) {
      console.warn(`a read's whole output not fetched, its tail kept: ${(error as Error).message}`);
    }
    return ids.flatMap((id) => {
      const item = w.view.items.get(id);
      const read = item && readOf(item);
      return read ? [read] : [];
    });
  }

  /** Newest first. */
  async actions(r: ThreadRef, limit: number, failedOnly: boolean): Promise<Action[]> {
    this.summaryOf(r);
    const w = await this.view(r);
    const picked = actionsOf(w.view, limit, failedOnly);
    await this.fillOutputs(
      r,
      w,
      picked.map(([id]) => id),
    );
    return picked.map(([id, a]) => {
      const item = w.view.items.get(id);
      return (item && toAction(item)) ?? a;
    });
  }

  /** The items and messages around `itemId`, oldest first, from the node's own log, and the item's index among them. */
  async window(r: ThreadRef, itemId: string, before: number, after: number): Promise<[TailRow[], number | undefined]> {
    if (itemId === "") throw ExecutorError.failed(r.machineId, "read", "the item id is empty");
    const out = await this.ex.call(
      r.machineId,
      "read",
      { op: "window", sessionId: r.threadId, itemId, before: Math.min(before, 25), after: Math.min(after, 25) },
      READ_TIMEOUT_MS,
    );
    if (out.kind !== "window") return [[], undefined];
    const rows: TailRow[] = [];
    for (const e of out.entries) {
      if (typeof e.kind === "object") {
        const item = e as ThreadItem;
        const action = toAction(item);
        if (action) rows.push({ kind: "action", at: item.startedAt, action });
      } else {
        const m = e as ThreadMessage;
        rows.push({ kind: "message", at: m.createdAt, role: m.role, text: clip(m.text, 2000) });
      }
    }
    return [rows, out.focus];
  }

  /** Follows the session if needed and keeps following until `release`. */
  async follow(r: ThreadRef): Promise<void> {
    const w = await this.view(r);
    w.pinned = true;
  }

  /** The follow then ends a minute from now unless something reads it. */
  release(r: ThreadRef): void {
    const w = this.watches.get(keyOf(r));
    if (!w) return;
    w.pinned = false;
    w.lastUsedMs = this.now();
    w.nudge?.();
  }

  isFollowed(r: ThreadRef): boolean {
    return this.watches.has(keyOf(r));
  }

  pin(r: ThreadRef): boolean {
    const w = this.watches.get(keyOf(r));
    if (w) w.pinned = true;
    return w !== undefined;
  }

  /** Undefined when the session is not followed (never followed, or its link dropped). */
  progress(r: ThreadRef): Progress | undefined {
    const w = this.watches.get(keyOf(r));
    if (!w || !w.view.ready) return undefined;
    const tool = openTool(w.view, this.ex.tracked(r)?.activeRunId);
    return { lastFrameMs: w.lastFrameMs, ...(tool ? { tool } : {}) };
  }
}
