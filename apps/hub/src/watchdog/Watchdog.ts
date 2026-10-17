// The stall watchdog. Every running thread gets a persistent thread stream (ThreadWatch); a run with no
// frame for longer than its threshold is stalled. The ladder per chain: emit thread.stalled and
// interrupt; once the run has ended, send one "continue"; a second stall in the chain emits
// thread.failed{reason:"stalled"} and interrupts again, with no more retries. Deterministic, no LLM.
import type { MachineId, ThreadRef } from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Executors from "../executor/Executors.ts";
import { type Progress, ThreadWatch } from "../executor/ThreadWatch.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";

export interface WatchdogConfig {
  /** No frame for this long outside a tool is a stall. */
  readonly outsideToolMs: number;
  /** A tool's timeout when it states none. */
  readonly toolTimeoutMs: number;
  /** Inside a tool, a stall is no frame for the tool's timeout plus this. */
  readonly insideToolGraceMs: number;
  /** How often running threads are checked. */
  readonly checkEveryMs: number;
}

const MIN = 60_000;
export const DEFAULT_CONFIG: WatchdogConfig = {
  outsideToolMs: 10 * MIN,
  toolTimeoutMs: 10 * MIN,
  insideToolGraceMs: 10 * MIN,
  checkEveryMs: 30_000,
};

const ENV: Record<keyof WatchdogConfig, string> = {
  outsideToolMs: "FLEETD_STALL_OUTSIDE_SEC",
  toolTimeoutMs: "FLEETD_STALL_TOOL_TIMEOUT_SEC",
  insideToolGraceMs: "FLEETD_STALL_INSIDE_GRACE_SEC",
  checkEveryMs: "FLEETD_WATCHDOG_EVERY_SEC",
};

/** Thresholds from `FLEETD_STALL_*` / `FLEETD_WATCHDOG_EVERY_SEC` (seconds); unset or invalid keeps the default. */
export const configFromEnv = (env: Readonly<Record<string, string | undefined>>): WatchdogConfig => {
  const config = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(ENV) as Array<keyof WatchdogConfig>) {
    const raw = env[ENV[key]];
    const seconds = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) config[key] = Math.round(seconds * 1000);
  }
  return config;
};

export const NUDGE = "You seem stalled; continue the task from where you stopped.";

/** The threshold for a run in its current state. */
export const thresholdMs = (config: WatchdogConfig, tool: Progress["tool"]): number => {
  if (tool === undefined) return config.outsideToolMs;
  const timeout = Math.max(tool.statedTimeoutMs ?? 0, tool.unstated ? config.toolTimeoutMs : 0);
  return timeout + config.insideToolGraceMs;
};

/** Where a thread is on the ladder. No entry means no stall in its current chain. */
type Chain =
  /** Stalled and interrupted; the nudge goes out once the run has ended. */
  | { readonly stage: "interrupting"; readonly runId: string; readonly at: number }
  /** The nudge went out; the next run is its continuation, and its stall fails the chain. */
  | { readonly stage: "nudged"; readonly stalledRunId: string; readonly at: number }
  /** Failed for stalling; nothing more until this run ends. */
  | { readonly stage: "failed"; readonly runId: string; readonly at: number };

export class Watchdog extends Context.Service<
  Watchdog,
  {
    /** One pass over running threads: open missing streams, detect stalls, advance the ladder. */
    readonly check: () => Effect.Effect<void>;
    /** Opens a stream for every running thread without one; returns how many it opened. */
    readonly resubscribe: () => Effect.Effect<number>;
  }
>()("fleetd/watchdog/Watchdog") {}

const keyOf = (ref: ThreadRef) => `${ref.machineId}\u0000${ref.threadId}`;
const errorTag = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause);
  return typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "unknown";
};
const minutes = (ms: number) => (ms % MIN === 0 ? `${ms / MIN} min` : `${Math.round(ms / 1000)} s`);

export const make = (config: WatchdogConfig) =>
  Effect.gen(function* () {
    const watch = yield* ThreadWatch;
    const executors = yield* Executors.Executors;
    const events = yield* EventLog.EventLog;
    const store = yield* HubStore.HubStore;
    const chains = new Map<string, Chain>();
    /** Threads this watchdog has pinned a stream for. */
    const followed = new Map<string, ThreadRef>();

    const emit = (ref: ThreadRef, type: "thread.stalled" | "thread.failed", detail: string, data: Record<string, unknown>) =>
      Effect.gen(function* () {
        const summary = yield* store.threads.get(ref);
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* events.append({
          at,
          type,
          machineId: ref.machineId,
          ...(summary ? { projectId: summary.projectId } : {}),
          threadId: ref.threadId,
          summary: `"${summary?.title ?? ref.threadId}" on ${ref.machineId} ${detail}`,
          data: { status: type === "thread.failed" ? "failed" : "running", ...data },
        });
      });

    const bestEffort = (what: string, ref: ThreadRef) => (effect: Effect.Effect<unknown, unknown>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning(`watchdog: ${what} failed`).pipe(
            Effect.annotateLogs({ machineId: ref.machineId, threadId: ref.threadId, error: errorTag(cause) }),
          ),
        ),
      );

    const follow = (ref: ThreadRef) =>
      watch.follow(ref).pipe(
        Effect.map(() => {
          followed.set(keyOf(ref), ref);
          return true;
        }),
        Effect.catchCause(() => Effect.succeed(false)),
      );

    const resubscribe = () =>
      Effect.gen(function* () {
        const missing: Array<ThreadRef> = [];
        for (const { ref } of yield* watch.running()) if ((yield* watch.progress(ref)) === undefined) missing.push(ref);
        const opened = yield* Effect.forEach(missing, follow, { concurrency: 8 });
        return opened.filter(Boolean).length;
      });

    const stall = (ref: ThreadRef, runId: string, idleMs: number, limitMs: number, inTool: boolean, now: number) =>
      Effect.gen(function* () {
        const where = inTool ? "inside a tool" : "outside a tool";
        yield* emit(ref, "thread.stalled", `stalled: no progress for ${minutes(idleMs)} ${where}; interrupting and nudging once`, {
          runId,
          inTool,
          idleSec: Math.round(idleMs / 1000),
          thresholdSec: Math.round(limitMs / 1000),
        });
        chains.set(keyOf(ref), { stage: "interrupting", runId, at: now });
        yield* executors.interrupt(ref, `watchdog:${runId}:interrupt`).pipe(bestEffort("interrupt", ref));
      });

    const fail = (ref: ThreadRef, runId: string, idleMs: number, inTool: boolean, now: number) =>
      Effect.gen(function* () {
        const where = inTool ? "inside a tool" : "outside a tool";
        yield* emit(ref, "thread.failed", `failed: stalled again after a nudge (no progress for ${minutes(idleMs)} ${where})`, {
          runId,
          reason: "stalled",
          error: { class: "stalled", message: "stalled twice; the watchdog interrupted it and will not retry" },
        });
        chains.set(keyOf(ref), { stage: "failed", runId, at: now });
        yield* executors.interrupt(ref, `watchdog:${runId}:fail`).pipe(bestEffort("interrupt", ref));
      });

    const checkRunning = (ref: ThreadRef, runId: string, now: number) =>
      Effect.gen(function* () {
        const key = keyOf(ref);
        let chain = chains.get(key);
        if (chain?.stage === "failed" && chain.runId !== runId) chain = undefined;
        // A new run before the nudge went out (T3's own continuation, or a user message) stands in for it.
        if (chain?.stage === "interrupting" && chain.runId !== runId) {
          chain = { stage: "nudged", stalledRunId: chain.runId, at: chain.at };
        }
        if (chain === undefined) chains.delete(key);
        else chains.set(key, chain);
        if (chain?.stage === "failed") return;
        const progress = yield* watch.progress(ref);
        if (progress === undefined) {
          yield* follow(ref);
          return;
        }
        const limitMs = thresholdMs(config, progress.tool);
        const idleMs = now - Math.max(progress.lastFrameMs, chain?.at ?? 0);
        if (idleMs < limitMs) return;
        const inTool = progress.tool !== undefined;
        if (chain === undefined) yield* stall(ref, runId, idleMs, limitMs, inTool, now);
        else yield* fail(ref, runId, idleMs, inTool, now);
      });

    /** A thread on the ladder or followed that is no longer running. */
    const checkEnded = (key: string, ref: ThreadRef, now: number) =>
      Effect.gen(function* () {
        const chain = chains.get(key);
        const latest = yield* watch.latestRun(ref);
        if (latest?.running === true) return; // Running but not listed: its machine is disconnected.
        if (chain?.stage === "interrupting" && latest !== undefined) {
          const sent = yield* executors.send(ref, NUDGE, `watchdog:${chain.runId}:continue`).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("watchdog: nudge failed; retrying next check").pipe(
                Effect.annotateLogs({ machineId: ref.machineId, threadId: ref.threadId, error: errorTag(cause) }),
                Effect.as(false),
              ),
            ),
          );
          if (sent) chains.set(key, { stage: "nudged", stalledRunId: chain.runId, at: now });
          return;
        }
        // The continuation has not started yet; give it one outside-tool threshold.
        if (chain?.stage === "nudged" && latest?.runId === chain.stalledRunId && now - chain.at < config.outsideToolMs) return;
        chains.delete(key);
        if (followed.delete(key)) yield* watch.release(ref);
      });

    const check = () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const running = yield* watch.running();
        const live = new Set<string>();
        for (const { ref, runId } of running) {
          live.add(keyOf(ref));
          yield* checkRunning(ref, runId, now).pipe(bestEffort("check", ref));
        }
        const idle = new Map<string, ThreadRef>(followed);
        for (const key of chains.keys()) {
          const [machineId, threadId] = key.split("\u0000") as [MachineId, ThreadRef["threadId"]];
          if (!idle.has(key)) idle.set(key, { machineId, threadId });
        }
        for (const [key, ref] of idle) if (!live.has(key)) yield* checkEnded(key, ref, now).pipe(bestEffort("check", ref));
      });

    yield* Effect.sleep(Duration.millis(config.checkEveryMs)).pipe(
      Effect.andThen(check()),
      Effect.forever,
      Effect.forkScoped,
    );

    return Watchdog.of({ check, resubscribe });
  });

/** The watchdog, checking every `config.checkEveryMs`. Needs Executors and ThreadWatch (Executors.layer). */
export const layer = (config: WatchdogConfig = configFromEnv(process.env)) => Layer.effect(Watchdog, make(config));
