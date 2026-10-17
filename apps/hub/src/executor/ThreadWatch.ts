// What the watchdog needs from the executor: which threads are running, and a persistent stream per
// running thread that reports when it last moved and whether a tool call is open. The stream is the
// same one thread_tail reads, so there is at most one per thread.
import type { ThreadRef } from "@fleetd/contracts";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ExecutorError } from "./Executors.ts";
import type { ThreadView } from "./ThreadView.ts";

export interface RunningThread {
  readonly ref: ThreadRef;
  readonly runId: string;
}

export interface Progress {
  /** Epoch ms of the stream's last frame, or of its opening. */
  readonly lastFrameMs: number;
  /**
   * Set while a command or tool call of the run is open. `statedTimeoutMs` is the longest timeout an open
   * tool states itself; `unstated` means some open tool states none (the watchdog applies its default).
   */
  readonly tool?: { readonly statedTimeoutMs?: number; readonly unstated: boolean };
}

export class ThreadWatch extends Context.Service<
  ThreadWatch,
  {
    /** Threads whose shell row says running, on machines with a live T3 connection. */
    readonly running: () => Effect.Effect<ReadonlyArray<RunningThread>>;
    /** T3's latest run on the thread as last seen; undefined for an unknown thread. */
    readonly latestRun: (ref: ThreadRef) => Effect.Effect<{ readonly runId: string | null; readonly running: boolean } | undefined>;
    /** Opens the thread's stream if needed and keeps it open until `release`. */
    readonly follow: (ref: ThreadRef) => Effect.Effect<void, ExecutorError>;
    /** The stream then closes 60 s from now unless something reads it. */
    readonly release: (ref: ThreadRef) => Effect.Effect<void>;
    /** Undefined when no stream is open (never followed, or its connection dropped). */
    readonly progress: (ref: ThreadRef) => Effect.Effect<Progress | undefined>;
  }
>()("fleetd/executor/ThreadWatch") {}

const TOOL_TYPES = new Set<OrchestrationV2TurnItem["type"]>(["command_execution", "dynamic_tool", "subagent", "web_search", "file_search"]);
const OPEN = new Set<OrchestrationV2TurnItem["status"]>(["pending", "running"]);

/** A tool's own `timeout` (ms), as Claude's tools take it, when T3 passes the input through. */
const statedTimeout = (item: OrchestrationV2TurnItem): number | undefined => {
  if (item.type !== "dynamic_tool" || typeof item.input !== "object" || item.input === null) return undefined;
  const timeout = (item.input as { readonly timeout?: unknown }).timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
};

/** The open tool calls of `runId`, if any. */
export const openTool = (view: ThreadView, runId: string | undefined): Progress["tool"] => {
  let open = false;
  let unstated = false;
  let stated: number | undefined;
  for (const item of view.items.values()) {
    if (!TOOL_TYPES.has(item.type) || !OPEN.has(item.status)) continue;
    if (runId !== undefined && item.runId !== runId) continue;
    open = true;
    const timeoutMs = statedTimeout(item);
    if (timeoutMs === undefined) unstated = true;
    else stated = Math.max(stated ?? 0, timeoutMs);
  }
  if (!open) return undefined;
  return stated === undefined ? { unstated } : { statedTimeoutMs: stated, unstated };
};
