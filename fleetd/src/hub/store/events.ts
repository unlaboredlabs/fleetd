// The hub-global, append-only event log behind `events_wait` and the app stream,
// over the same `events` table: a row's `data` is the event without its
// seq, and seq is the row's AUTOINCREMENT key, so it never goes backwards past retention deletes.
import type { Clock } from "../../shared/clock.ts";
import type { HubEvent, HubEventType, MachineId, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "./db.ts";
import { type NewEvent, trim } from "./new_event.ts";

const PAGE = 100;
/**
 * How long a walk over a backlog of the log (a projector catching up, a replay at start) holds the event loop before it
 * yields, so the hub answers while it catches up, as the Rust hub's walks run on tasks of their own.
 */
export const BATCH_MS = 20;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** A `HubEvent` before the log numbers it; also exactly what a row's `data` column holds. */
export type { NewEvent } from "./new_event.ts";

export type WaitInput = {
  /** Absent means start at the current end. */
  cursor?: number;
  types?: HubEventType[];
  machineId?: MachineId;
  timeoutSec: number;
};

export type WaitResult = {
  events: HubEvent[];
  /** Pass back as the next `cursor`; it moves past events the filters skipped. */
  cursor: number;
  /** More matching events are already waiting. */
  more: boolean;
};

/** The hub's one event log, `hub.area("events")`: `events(hub).append(…)`. Other areas name it the same way. */
export const events = (hub: Hub) => hub.area("events", (h) => new EventLog(h.db, h.clock));

const withSeq = (event: NewEvent, seq: number): HubEvent => ({ ...event, seq });

/** `EventLog.projectPage`'s query: each half walks `events_by_project` newest first and stops at the limit. */
const PROJECT_PAGE = `SELECT seq, data FROM (
         SELECT seq, data FROM events
          WHERE machine_id = $machine AND json_extract(data, '$.projectId') = $project
            AND seq < COALESCE($before, 9223372036854775807)
            AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
          ORDER BY seq DESC LIMIT $limit)
       UNION ALL
       SELECT seq, data FROM (
         SELECT seq, data FROM events
          WHERE $hub_wide AND machine_id IS NULL AND json_extract(data, '$.projectId') IS NULL
            AND seq < COALESCE($before, 9223372036854775807)
            AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
          ORDER BY seq DESC LIMIT $limit)
       ORDER BY seq DESC LIMIT $limit`;

const PAGE_SQL = `SELECT seq, data FROM events
       WHERE seq > $after
         AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
         AND ($machine IS NULL OR machine_id = $machine)
       ORDER BY seq LIMIT $limit`;

type Row = { seq: number; data: string };

export class EventLog {
  private lastPruneMs: number;
  private headSeq: number;
  private readonly listeners = new Set<(event: HubEvent) => void>();

  /** Prunes events past retention, then picks the head up where the database left it. */
  constructor(
    readonly db: HubDb,
    private readonly clock: Clock,
  ) {
    const now = clock.now();
    db.conn.query("DELETE FROM events WHERE created_ms < ?").run(now - RETENTION_MS);
    const row = db.conn.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get();
    this.headSeq = row?.seq ?? 0;
    this.lastPruneMs = now;
  }

  /** Seq of the newest event ever appended; 0 for none. */
  head(): number {
    return this.headSeq;
  }

  /**
   * Calls `listener` after each append, in order, with the stored event (the Rust log's `subscribe`). Returns the
   * unsubscribe. A throwing listener is logged and never stops an append.
   */
  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(event: NewEvent): HubEvent {
    const now = this.clock.now();
    const trimmed = trim(event);
    const prune = now - this.lastPruneMs >= PRUNE_EVERY_MS;
    if (prune) this.lastPruneMs = now;
    if (prune) this.db.conn.query("DELETE FROM events WHERE created_ms < ?").run(now - RETENTION_MS);
    const row = this.db.conn
      .query<{ seq: number }, [number, string, string | null, string]>(
        "INSERT INTO events (created_ms, type, machine_id, data) VALUES (?, ?, ?, ?) RETURNING seq",
      )
      .get(now, trimmed.type, trimmed.machineId ?? null, JSON.stringify(trimmed));
    const seq = row?.seq ?? this.headSeq + 1;
    this.headSeq = seq;
    const stored = withSeq(trimmed, seq);
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch (error) {
        console.error("event listener failed:", error);
      }
    }
    return stored;
  }

  /** One page after `after`, with the cursor to resume from. */
  page(after: number, types?: HubEventType[], machineId?: MachineId): WaitResult {
    const rows = this.db.all<Row>(PAGE_SQL, {
      after,
      types: types ? JSON.stringify(types) : null,
      machine: machineId ?? null,
      limit: PAGE + 1,
    });
    const more = rows.length > PAGE;
    const events = rows.slice(0, PAGE).map((r) => withSeq(JSON.parse(r.data) as NewEvent, r.seq));
    // Without more, every event up to head was looked at, matching or not.
    const cursor = more ? (events[PAGE - 1]?.seq ?? after) : Math.max(after, this.headSeq);
    return { events, cursor, more };
  }

  /**
   * One project's events before `before` (the newest without it), newest first, and whether older ones remain.
   * `hubWide` adds the events that name no machine or project.
   */
  projectPage(
    project: ProjectRef,
    before: number | undefined,
    types: HubEventType[] | undefined,
    hubWide: boolean,
    limit: number,
  ): { events: HubEvent[]; more: boolean } {
    const rows = this.db.all<Row>(PROJECT_PAGE, {
      before: before ?? null,
      types: types ? JSON.stringify(types) : null,
      machine: project.machineId,
      project: project.projectId,
      hub_wide: hubWide ? 1 : 0,
      limit: limit + 1,
    });
    return {
      events: rows.slice(0, limit).map((r) => withSeq(JSON.parse(r.data) as NewEvent, r.seq)),
      more: rows.length > limit,
    };
  }

  /** Returns at once if matching events exist after `cursor`, otherwise waits up to `timeoutSec` for one. */
  async wait(input: WaitInput, signal?: AbortSignal): Promise<WaitResult> {
    const deadline = this.clock.now() + input.timeoutSec * 1000;
    // A cursor past head (say, from before a hub reset) waits for new events instead of forever.
    let after = Math.min(input.cursor ?? this.headSeq, this.headSeq);
    for (;;) {
      const page = this.page(after, input.types, input.machineId);
      const remaining = deadline - this.clock.now();
      if (page.events.length > 0 || remaining <= 0 || signal?.aborted) return page;
      after = page.cursor;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        const unsubscribe = this.subscribe(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
}
