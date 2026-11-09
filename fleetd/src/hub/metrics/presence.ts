// App presence: once a minute, while presence is on, the desktop app says
// whether a window is focused, which project is on screen and whether there was input in the last minute. A human
// key's minute with all three becomes one `app.presence` event over the minute before it, on the hub's clock.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows, isoMs } from "../auth/index.ts";
import { events, type NewEvent } from "../store/events.ts";

/** What one frame covers: the minute before it. */
export const WINDOW_MS = 60_000;
/** A key's next interval must add at least this much, so a key records at most about one a minute. */
export const MIN_MS = 50_000;

/** Where each key's last interval ended: `hub.area("presence")`. */
export class Presence {
  private readonly last = new Map<string, number>();

  /** The interval a frame at `now` records for `key`; undefined when that adds less than MIN_MS. */
  interval(key: string, now: number): [number, number] | undefined {
    const end = this.last.get(key);
    const from = end === undefined ? now - WINDOW_MS : Math.max(end, now - WINDOW_MS);
    if (now - from < MIN_MS) return undefined;
    this.last.set(key, now);
    return [from, now];
  }
}

/** The `app.presence` event for `[from, to]` on `project`, by the key named `by`. */
export function presenceEvent(project: ProjectRef, by: string, from: number, to: number): NewEvent {
  const data: Record<string, unknown> = { fromMs: from, toMs: to };
  if (by.length >= 1 && by.length <= 200 && !/[\r\n]/.test(by)) data.by = by;
  return {
    at: isoMs(to),
    type: "app.presence",
    machineId: project.machineId,
    projectId: project.projectId,
    summary: "app in use",
    data,
  } as NewEvent;
}

/**
 * One `presence` frame from the app. Only a human key's focused minute with input, on a project the hub knows on
 * that machine and the key may read, is recorded; the frame is never answered. Whether it was recorded.
 */
export function record(hub: Hub, caller: Caller, focused: boolean, input: boolean, project: ProjectRef | undefined): boolean {
  if (!project || !focused || !input) return false;
  if (caller.kind !== "human" || !allows(caller, "read", project.machineId)) return false;
  const known = hub.db.conn
    .query("SELECT 1 FROM projects WHERE machine_id = ?1 AND project_id = ?2")
    .get(project.machineId, project.projectId);
  if (!known) return false;
  const span = hub.area("presence", () => new Presence()).interval(caller.keyId, hub.clock.now());
  if (!span) return false;
  events(hub).append(presenceEvent(project, caller.name, span[0], span[1]));
  return true;
}
