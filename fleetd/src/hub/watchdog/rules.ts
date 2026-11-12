// When a run is stalled, and how a stall is told (index.ts watches the threads).
import type { OpenTool } from "../executor/thread_view.ts";

/** No frame for this long outside a tool is a stall. Inside a tool: the tool's own timeout plus this again. */
export const STALL_MS = 10 * 60_000;

/** The threshold for a run in its current state. */
export function thresholdMs(stallMs: number, tool: OpenTool | undefined): number {
  if (!tool) return stallMs;
  return Math.max(tool.statedTimeoutMs ?? 0, tool.unstated ? stallMs : 0) + stallMs;
}

export function minutes(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/** Why a run quiet for `idle` ms stalled, as its `thread.failed` says it. */
export const stallWhy = (idle: number, inTool: boolean) =>
  `no progress for ${minutes(idle)} ${inTool ? "inside a tool" : "outside a tool"}, so fleetd interrupted it`;
