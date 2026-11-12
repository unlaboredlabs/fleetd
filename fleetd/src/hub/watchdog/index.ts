// The stall watchdog. Every running thread gets a persistent thread stream; a
// run with no frame for longer than its threshold is stalled. The hub emits thread.failed{reason:"stalled"} and
// interrupts the run, once. Its task is then resumed (`tasks/recovery.ts`), or failed for its lead to decide when it
// stalled the same way twice or ran out of recoveries; a lead's own stalled turn carries on once by itself
// (`leads/cut_off.ts`). Deterministic, no LLM.
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { interrupt, latestRun } from "../executor/sessions.ts";
import type { OpenTool } from "../executor/thread_view.ts";
import type { Progress } from "../executor/views.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { every } from "../sweep/index.ts";

/** No frame for this long outside a tool is a stall. Inside a tool: the tool's own timeout plus this again. */
export const STALL_MS = 10 * 60_000;

export type { OpenTool };

/** The threshold for a run in its current state. */
export function thresholdMs(stallMs: number, tool: OpenTool | undefined): number {
  if (!tool) return stallMs;
  return Math.max(tool.statedTimeoutMs ?? 0, tool.unstated ? stallMs : 0) + stallMs;
}

/** `machineId \0 threadId`. */
export type Key = string;
export const key = (machineId: string, threadId: string): Key => `${machineId}\0${threadId}`;
const parts = (k: Key) => k.split("\0") as [string, string];

/** What the watchdog reads and drives: the executor's thread watch and interrupt, and the event log. */
export interface WatchPort {
  nowMs(): number;
  /**
   * `[key, runId]` of threads whose shell row says running, on machines with a live node link. Not one waiting on a
   * person (a tool prompt): its node sends nothing until they answer.
   */
  running(): [Key, string][];
  /** `{ runId, running }` as last seen, running while its run is on (waiting on a person too); undefined for an unknown thread. */
  latestRun(k: Key): { runId?: string; running: boolean } | undefined;
  /** Opens the thread's stream if needed and keeps it open; false when it could not. */
  follow(k: Key): Promise<boolean>;
  release(k: Key): void;
  /** `{ lastFrameMs, tool }`; undefined when no stream is open. */
  progress(k: Key): Progress | undefined;
  interrupt(k: Key): Promise<void>;
  /** Appends a thread event; the port fills in the thread's title and project from the store. */
  emit(k: Key, kind: string, detail: string, data: Record<string, unknown>): Promise<void> | void;
}

function minutes(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

export class Watchdog {
  /** The run each thread stalled in: nothing more happens to that run. */
  private readonly stalled = new Map<Key, string>();
  /** Threads this watchdog has pinned a stream for. */
  private readonly followed = new Set<Key>();
  /** One pass at a time (the Rust state's mutex). */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    readonly stallMs: number,
    readonly port: WatchPort,
  ) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  private async follow(k: Key): Promise<boolean> {
    const ok = await this.port.follow(k);
    if (ok) this.followed.add(k);
    return ok;
  }

  /** Opens a stream for every running thread without one; returns how many it opened. */
  resubscribe(): Promise<number> {
    return this.exclusive(async () => {
      const missing = this.port
        .running()
        .map(([k]) => k)
        .filter((k) => this.port.progress(k) === undefined);
      let opened = 0;
      for (const k of missing) if (await this.follow(k)) opened++;
      return opened;
    });
  }

  private async checkRunning(k: Key, runId: string, now: number): Promise<void> {
    if (this.stalled.get(k) === runId) return;
    this.stalled.delete(k);
    const progress = this.port.progress(k);
    if (!progress) {
      await this.follow(k);
      return;
    }
    const limit = thresholdMs(this.stallMs, progress.tool);
    const idle = Math.max(0, now - progress.lastFrameMs);
    if (idle < limit) return;
    const where = progress.tool ? "inside a tool" : "outside a tool";
    const why = `no progress for ${minutes(idle)} ${where}, so fleetd interrupted it`;
    const data = {
      status: "failed",
      runId,
      reason: "stalled",
      inTool: progress.tool !== undefined,
      idleSec: Math.round(idle / 1000),
      thresholdSec: Math.round(limit / 1000),
      error: { class: "stalled", message: why },
    };
    // Before the interrupt, so the task fails with this reason rather than as a plain interrupt.
    await this.port.emit(k, "thread.failed", `stalled: ${why}`, data);
    this.stalled.set(k, runId);
    try {
      await this.port.interrupt(k);
    } catch (error) {
      const [machineId, threadId] = parts(k);
      console.warn(`watchdog: interrupt of ${machineId}/${threadId} failed:`, error);
    }
  }

  /** A stalled or followed thread that is no longer running. */
  private checkEnded(k: Key): void {
    // Running but not listed: its machine is disconnected.
    if (this.port.latestRun(k)?.running) return;
    this.stalled.delete(k);
    if (this.followed.delete(k)) this.port.release(k);
  }

  /** One pass over running threads: open missing streams and detect stalls. */
  check(): Promise<void> {
    return this.exclusive(async () => {
      const now = this.port.nowMs();
      const running = this.port.running();
      for (const [k, runId] of running) await this.checkRunning(k, runId, now);
      const listed = new Set(running.map(([k]) => k));
      const ended = [...new Set([...this.followed, ...this.stalled.keys()])].filter((k) => !listed.has(k));
      for (const k of ended) this.checkEnded(k);
    });
  }

  /** Checks every 30 s (sooner under a short lab threshold), until the hub stops. */
  start(hub: Hub): void {
    every(hub, Math.min(30_000, Math.max(1000, Math.floor(this.stallMs / 20))), () => this.check());
  }
}

/** The watch over the hub's own executor, its followed sessions, the store and the event log (`HubWatch`). */
export function hubWatch(hub: Hub): WatchPort {
  // A static import (D355): a variable-path import() finds nothing in the compiled binary.
  const ex = () => executors(hub);
  const ref = (k: Key) => {
    const [machineId, threadId] = parts(k);
    return { machineId, threadId };
  };
  return {
    nowMs: () => Math.max(0, hub.clock.now()),
    running: () =>
      ex()
        .running()
        .flatMap(({ thread }) => {
          // `running()` lists a waiting thread too, which the watchdog leaves to the person it waits on.
          const run = latestRun(hub, thread);
          return run?.running && run.runId !== undefined ? [[key(thread.machineId, thread.threadId), run.runId] as [Key, string]] : [];
        }),
    latestRun: (k) => {
      const r = ref(k);
      const run = latestRun(hub, r);
      // A run waiting on a person is still on: its follow stays, so the live lanes keep it too.
      return run && { ...run, running: run.running || ex().tracked(r)?.summary.status === "waiting" };
    },
    follow: async (k) => {
      try {
        await ex().views.follow(ref(k));
        return true;
      } catch {
        return false;
      }
    },
    release: (k) => ex().views.release(ref(k)),
    progress: (k) => ex().views.progress(ref(k)),
    interrupt: (k) => interrupt(hub, ref(k)),
    emit: (k, kind, detail, data) => {
      const [machineId, threadId] = parts(k);
      const stored = store(hub).threadGet({ machineId, threadId });
      const title = stored?.thread.title ?? threadId;
      try {
        events(hub).append({
          at: isoMs(hub.clock.now()),
          type: kind as never,
          machineId,
          ...(stored ? { projectId: stored.thread.projectId } : {}),
          threadId,
          summary: `"${title}" on ${machineId} ${detail}`,
          data,
        });
      } catch (error) {
        console.error("watchdog: event append failed:", error);
      }
    },
  };
}

/** The hub's watchdog: `watchdog(hub)`. Tests make their own with `new Watchdog(ms, port)`. */
export const watchdog = (hub: Hub) => hub.area("watchdog", (h) => new Watchdog(STALL_MS, hubWatch(h)));
