// Open orders nothing moves, with no store behind them, so fleetd cloud's lead state flags them as a hub's does: on
// 2026-11-23 ten open orders sat with no agent for hours to days across lead restarts, and nobody noticed until the
// person asked. The lead's state opens with a line for each order that has had nothing running, queued or waiting (no
// task, no wait_ci, no Monitor, no PR on the train, no request to the person) for longer than STALLED_MS, with when it
// last moved. Each store says when an order last moved and whether anything of it is busy (stalled.ts for a hub).
import type { HumanRequest } from "../../shared/contracts.ts";

export const STALLED_MS = 30 * 60_000;

/** An open order as the rules read it: when it last moved, and whether anything of it runs, is queued or waits. */
export type OrderMotion = { workstreamId: string; lastMovedMs: number; busy: boolean };

/** "2026-11-23 10:05 UTC". */
const when = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

/** A line per open order with nothing running, queued or waiting for over STALLED_MS, the longest idle first. */
export function stalledLines(orders: readonly OrderMotion[], requests: readonly HumanRequest[], nowMs: number): string[] {
  return orders
    .filter((o) => !o.busy && nowMs - o.lastMovedMs > STALLED_MS && !requests.some((q) => q.workstreamId === o.workstreamId))
    .sort((a, b) => a.lastMovedMs - b.lastMovedMs)
    .map((o) => `${o.workstreamId} open, nothing running since ${when(o.lastMovedMs)}`);
}
