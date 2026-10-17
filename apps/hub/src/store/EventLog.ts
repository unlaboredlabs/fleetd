import { HubEvent, type HubEventType, type MachineId } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as HubDb from "./HubDb.ts";

export interface WaitInput {
  /** Absent means start at the current end. */
  readonly cursor?: number;
  readonly types?: ReadonlyArray<HubEventType>;
  readonly machineId?: MachineId;
  readonly timeoutSec: number;
}

export interface WaitResult {
  readonly events: ReadonlyArray<HubEvent>;
  /** Pass back as the next `cursor`; it moves past events the filters skipped. */
  readonly cursor: number;
  /** More matching events are already waiting. */
  readonly more: boolean;
}

/** The hub-global, append-only event log behind `events_wait` and the app stream. */
export class EventLog extends Context.Service<
  EventLog,
  {
    /** Trims `summary` to 200 characters and drops a `data` over 2 KB of JSON. */
    readonly append: (event: Omit<HubEvent, "seq">) => Effect.Effect<HubEvent>;
    /** Seq of the newest event ever appended; 0 for none. */
    readonly head: () => Effect.Effect<number>;
    /** Returns at once if matching events exist after `cursor`, otherwise waits up to `timeoutSec` for one. */
    readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>;
  }
>()("fleetd/store/EventLog") {}

const PAGE = 100;
const MAX_DATA_BYTES = 2048;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const StoredEvent = Schema.fromJsonString(HubEvent.mapFields(Struct.omit(["seq"])));
const decodeStored = Schema.decodeSync(StoredEvent);
const encodeStored = Schema.encodeSync(StoredEvent);

const trim = (event: Omit<HubEvent, "seq">): Omit<HubEvent, "seq"> => {
  const summary = event.summary.length > 200 ? `${event.summary.slice(0, 199)}…` : event.summary;
  if (event.data === undefined || Buffer.byteLength(JSON.stringify(event.data) ?? "") <= MAX_DATA_BYTES) {
    return { ...event, summary };
  }
  return { ...event, summary, data: { truncated: true } };
};

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;

  const sql = {
    insert: db.prepare("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?, ?, ?, ?) RETURNING seq"),
    page: db.prepare(
      `SELECT seq, data FROM events
       WHERE seq > $after
         AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
         AND ($machine IS NULL OR machine_id = $machine)
       ORDER BY seq LIMIT $limit`,
    ),
    prune: db.prepare("DELETE FROM events WHERE created_ms < ?"),
    // AUTOINCREMENT keeps this past retention deletes, so seq never goes backwards.
    head: db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'"),
  };

  let head = Number(sql.head.get()?.seq ?? 0);
  // Completed and replaced on every append; waiters grab the current one before reading.
  let appended = Deferred.makeUnsafe<void>();
  let lastPruneMs = yield* Clock.currentTimeMillis;
  sql.prune.run(lastPruneMs - RETENTION_MS);

  const readPage = (after: number, input: WaitInput): WaitResult => {
    const rows = sql.page.all({
      after,
      types: input.types ? JSON.stringify(input.types) : null,
      machine: input.machineId ?? null,
      limit: PAGE + 1,
    });
    const more = rows.length > PAGE;
    const events = rows.slice(0, PAGE).map((row) => ({ seq: Number(row.seq), ...decodeStored(String(row.data)) }));
    // Without more, every event up to head was looked at, matching or not.
    return { events, more, cursor: more ? events[PAGE - 1]!.seq : Math.max(after, head) };
  };

  const append = (event: Omit<HubEvent, "seq">) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const trimmed = trim(event);
      const hubEvent = yield* Effect.sync(() => {
        if (now - lastPruneMs >= PRUNE_EVERY_MS) {
          sql.prune.run(now - RETENTION_MS);
          lastPruneMs = now;
        }
        const row = sql.insert.get(now, trimmed.type, trimmed.machineId ?? null, encodeStored(trimmed));
        head = Number(row?.seq);
        const done = appended;
        appended = Deferred.makeUnsafe<void>();
        return { done, hubEvent: { seq: head, ...trimmed } };
      });
      yield* Deferred.succeed(hubEvent.done, undefined);
      return hubEvent.hubEvent;
    });

  const wait = (input: WaitInput) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + input.timeoutSec * 1000;
      // A cursor past head (say, from before a hub reset) waits for new events instead of forever.
      let after = Math.min(input.cursor ?? head, head);
      while (true) {
        const { signal, page } = yield* Effect.sync(() => ({ signal: appended, page: readPage(after, input) }));
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (page.events.length > 0 || remaining <= 0) return page;
        after = page.cursor;
        yield* Deferred.await(signal).pipe(Effect.timeoutOption(remaining));
      }
    });

  return EventLog.of({ append, head: () => Effect.sync(() => head), wait });
});

export const layer = Layer.effect(EventLog, make);
