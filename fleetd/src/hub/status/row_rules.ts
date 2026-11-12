// A status row's keys, the events that change one, its clock text and its state word, without the hub (rows.ts reads
// the facts).
import type { HubEventType, ProjectRef, ProjectRowState } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";

export const DAY_MS = 24 * 3_600_000;

export const pkey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

export function projectRef(key: string): ProjectRef {
  const slash = key.indexOf("/");
  return slash < 0 ? { machineId: key, projectId: "" } : { machineId: key.slice(0, slash), projectId: key.slice(slash + 1) };
}

/** Event types that can change a row: `fleetd status --watch` reads the rows again after one. */
export const CHANGES_A_ROW: HubEventType[] = [
  "machine.online", "machine.offline", "machine.degraded", "machine.guard", "project.added", "project.removed",
  "chat.message", "chat.waiting", "lead.started", "workstream.created", "workstream.running", "workstream.state",
  "workstream.done", "task.queued", "task.started", "task.completed", "task.failed", "task.cancelled", "thread.waiting",
  "thread.usage_limited", "thread.started", "thread.completed", "thread.failed", "thread.interrupted", "request.opened",
  "request.updated", "review.verdict", "change.queued", "change.ready", "change.needs_rebase", "change.ci_failed",
  "change.refused", "change.state", "pr.merged", "pr.merged_outside", "usage.breaker", "usage.resumed", "ci.main",
  "source.stale", "source.fresh",
] as HubEventType[];

export function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: p.year, mon: p.month, d: p.day, wd: p.weekday, hm: `${p.hour}:${p.minute}` };
}

/** "14:02" today, "Thu 14:00" within a week, else "Oct 21 14:00", in the hub's zone. */
export function clock(ms: number, now: number, tz: string): string {
  if (Number.isNaN(new Date(ms).getTime())) return isoMs(ms);
  const t = parts(ms, tz);
  const n = parts(now, tz);
  if (t.y === n.y && t.mon === n.mon && t.d === n.d) return t.hm;
  if (Math.abs(ms - now) < 6 * DAY_MS) return `${t.wd} ${t.hm}`;
  return `${t.mon} ${t.d} ${t.hm}`;
}

/** What decides a row's state word. */
export type Facts = { needsYou: boolean; blocked?: string; agents: number; inFlight: number; leadWorking: boolean };

/** Waiting on you first (only you can move it), then blocked, then working; idle when nothing runs or waits. */
export function stateOf(f: Facts): ProjectRowState {
  if (f.needsYou) return "waiting_on_you";
  if (f.blocked !== undefined) return "blocked";
  if (f.agents > 0 || f.inFlight > 0 || f.leadWorking) return "working";
  return "idle";
}
