// The nightly worktree sweep's rules, with no hub behind them (the sweep itself is worktrees.ts): its settings and
// limits, how the node's words for a kept worktree read, the person's lines, and when the next sweep runs.
import type { KeptWorktree, MachineId, Task } from "../../shared/contracts.ts";
import { MONTHS, zoned, zonedToUtc } from "../../cli/zoned.ts";

/** The global decision setting how many days after its task ended a worktree goes. */
export const WORKTREE_DAYS_KEY = "policy.worktree_days";
export const WORKTREE_DAYS = 3;
/** The global decision naming the hub's zone for its clock times. */
export const POLICY_TZ_KEY = "policy.tz";
/** The local hour the sweep runs at. */
export const SWEEP_HOUR = 4;
/** The first sweep after the hub starts, once its nodes have had time to link. */
export const AFTER_START_MS = 10 * 60_000;
export const DAY_MS = 86_400_000;
/** Failed tries, one a night, before the sweep gives a worktree up. */
export const MAX_TRIES = 7;
/** Kept worktrees in one chat line (fleetd-contracts chat.rs `WORKTREES_KEPT_MAX`). */
export const WORKTREES_KEPT_MAX = 200;
// The node's words for a worktree it kept (node/worktree.rs).
const KEPT = "kept ";
const UNCOMMITTED = "it has uncommitted changes";
const UNPUSHED = "not pushed";

/** Whether the node kept the worktree for work that exists only there, by its own words. */
export const holdsWork = (message: string) => message.includes(KEPT) && (message.includes(UNCOMMITTED) || message.includes(UNPUSHED));

/** "uncommitted changes" or "2 unpushed commits", from the node's `<why>`. */
export function unsaved(why: string): string {
  const n = why.endsWith(UNPUSHED) ? why.slice(0, -UNPUSHED.length).trimEnd() : undefined;
  const count = n?.endsWith("commit(s)") ? n.slice(0, -"commit(s)".length).trim() : undefined;
  if (count !== undefined && /^[0-9]+$/.test(count)) return Number(count) === 1 ? "1 unpushed commit" : `${Number(count)} unpushed commits`;
  return why.startsWith("it has ") ? why.slice("it has ".length) : why;
}

/** A worktree kept for its work, as the person's line lists it. */
export function keptWorktree(task: Pick<Task, "title">, machine: MachineId, message: string): KeptWorktree {
  // `... kept <path>: <why>`
  const at = message.lastIndexOf(KEPT);
  const kept = at >= 0 ? message.slice(at + KEPT.length) : "";
  const colon = kept.indexOf(": ");
  const [path, why] = colon >= 0 ? [kept.slice(0, colon), kept.slice(colon + 2)] : [kept, "work"];
  return { title: task.title, unsaved: unsaved(why), machineId: machine, path };
}

/** The text of a line listing `n` kept worktrees. */
export const keptSummary = (n: number) => `Cleanup kept ${n} ${n === 1 ? "worktree" : "worktrees"} with unsaved work`;

/** The person's line for the worktrees given up on: `ids` are `T12 on devbox`. */
export const givenUpLine = (ids: string[]) =>
  `Stopped trying to remove the worktrees of finished agents ${ids.join(", ")} after ${MAX_TRIES} nightly tries: the machine was offline or git refused. If the machine is still in use, delete them by hand under ~/.fleetd/node/worktrees.`;

/** Why a task queued under a closed order was cancelled. */
export const closedOrderReason = (workstreamId: string) => `Cancelled: its order ${workstreamId} is closed.`;

export const validZone = (name: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

/** The next SWEEP_HOUR:00 in `zone` after `nowMs`. A day whose SWEEP_HOUR:00 doesn't exist (a clock change) is skipped. */
export function nextRunMs(nowMs: number, zone: string): number {
  const z = zoned(nowMs, zone);
  let day = Date.UTC(Number(z.year), MONTHS.indexOf(z.month as string), Number(z.day));
  if (Number(z.hour) >= SWEEP_HOUR) day += DAY_MS;
  for (;;) {
    const d = new Date(day);
    const at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), SWEEP_HOUR, 0, zone);
    const back = zoned(at, zone);
    if (Number(back.hour) === SWEEP_HOUR && Number(back.minute) === 0 && at > nowMs) return at;
    day += DAY_MS;
  }
}
