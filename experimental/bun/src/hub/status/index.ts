// Status (crates/fleetd/src/hub/status/mod.rs): one row per project (rows.ts), its work in groups (groups.ts). A row is
// read when someone asks, from the event log and the hub's own records, and read again after any event, so it is never
// older than the last event. One loop follows the freshness deadlines, flipping sources stale or fresh with an event.
import type { ProjectRef, ProjectStatusRow } from "../../shared/contracts.ts";
import { readable } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { others } from "../navi/owner.ts";
import { events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";
import { type Flip, fresh } from "./fresh.ts";
import { read } from "./rows.ts";

export { fresh, github, train, GITHUB_STALE_MS, TRAIN_STALE_MS } from "./fresh.ts";

const HOUR_MS = 3_600_000;

export class Status {
  /** The rows as last read, and the event head they were read at. */
  private rows: { head: number; rows: ProjectStatusRow[] } | undefined;

  constructor(private readonly hub: Hub) {}

  /** Every project's row, by title, as of the last event (no caller's filter). */
  all(): ProjectStatusRow[] {
    const head = events(this.hub).head();
    if (this.rows?.head !== head) this.rows = { head, rows: read(this.hub, fresh(this.hub), this.hub.clock.now()) };
    return this.rows.rows;
  }

  /** One row per project the caller reads, by title. */
  projectRows(caller: Caller): ProjectStatusRow[] {
    const navis = others(this.hub.db, caller);
    return this.all().filter((r) => readable(caller, r.projectRef.machineId) && !navis.has(r.projectRef));
  }

  /** One project's row; undefined when the caller reads no such project. */
  project(caller: Caller, r: ProjectRef): ProjectStatusRow | undefined {
    return this.projectRows(caller).find((row) => row.projectRef.machineId === r.machineId && row.projectRef.projectId === r.projectId);
  }

  private emitFlip(flip: Flip): void {
    try {
      events(this.hub).append(
        flip.kind === "stale"
          ? {
              at: isoMs(this.hub.clock.now()),
              type: "source.stale",
              summary: `${flip.source} stale: ${flip.reason}`,
              data: { source: flip.source, sinceMs: flip.sinceMs, reason: flip.reason },
            }
          : {
              at: isoMs(this.hub.clock.now()),
              type: "source.fresh",
              summary: `${flip.source} live again`,
              data: { source: flip.source, staleMs: flip.staleMs },
            },
      );
    } catch (error) {
      console.error("status: source event:", error);
    }
  }

  /** One pass of the follower: every due flip as an event; returns how long to sleep before the next deadline. */
  tick(): number {
    const f = fresh(this.hub);
    for (const flip of f.check(this.hub.clock.now())) this.emitFlip(flip);
    const deadline = f.nextDeadline();
    return deadline === undefined ? HOUR_MS : Math.min(HOUR_MS, Math.max(0, deadline - this.hub.clock.now()));
  }

  /** The follower: freshness flips at their deadlines, and at once on a fresh flip. Runs until the hub stops. */
  run(): void {
    const signal = this.hub.shutdown.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      clearTimeout(timer);
      if (signal.aborted) return;
      timer = setTimeout(next, this.tick());
    };
    const unsubscribe = fresh(this.hub).onNotify(() => queueMicrotask(next));
    signal.addEventListener("abort", () => (clearTimeout(timer), unsubscribe()), { once: true });
    next();
  }
}

export const status = (hub: Hub) => hub.area("status", (h) => new Status(h));

/** Every project's status row at the last event, for factory_status and the other areas that read them. */
export const statusRows = (hub: Hub, _nowMs?: number): ProjectStatusRow[] => status(hub).all();
