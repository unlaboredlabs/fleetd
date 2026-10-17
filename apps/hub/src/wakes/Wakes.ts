// Hub-owned wakes: stored in SQLite, scheduled on the Effect clock, delivered through the write queue so a wake
// for an offline machine waits for it. One scheduler fiber sleeps until the earliest active wake is due. A firing is
// a turn, so one whose thread the usage layer holds (paused login, parked thread) stays due until the hold clears.
import { randomBytes } from "node:crypto";
import { Wake, type MachineId, type ThreadId, type WakeSetInput, type WakeState } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Usage from "../usage/Usage.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { nextRun, ScheduleError, validate } from "./schedule.ts";

export class WakeInvalid extends Schema.TaggedError<WakeInvalid>()("WakeInvalid", { message: Schema.String }) {}

export type WakeSet = Omit<typeof WakeSetInput.Type, "clientRequestId"> & {
  readonly clientRequestId: string;
  /** keyId of the caller. */
  readonly createdBy: string;
};

export interface WakeFilter {
  readonly machineId?: MachineId;
  readonly threadId?: ThreadId;
  readonly state?: WakeState;
}

export class Wakes extends Context.Service<
  Wakes,
  {
    /** Idempotent per (createdBy, clientRequestId): a retry returns the wake the first call made. */
    readonly set: (input: WakeSet) => Effect.Effect<{ readonly wakeId: string; readonly nextRunAt: string }, WakeInvalid>;
    /** Oldest first. */
    readonly list: (filter: WakeFilter) => Effect.Effect<ReadonlyArray<Wake>>;
    readonly get: (wakeId: string) => Effect.Effect<Wake | undefined>;
    /** A no-op for a wake that is already done or cancelled. */
    readonly cancel: (wakeId: string) => Effect.Effect<void>;
    /**
     * The sweep's check: counts active wakes overdue by more than `olderThanMs` and wakes the scheduler, which fires
     * them per their catchUp. Firing from here instead would race the scheduler.
     */
    readonly sweepOverdue: (olderThanMs: number) => Effect.Effect<number>;
  }
>()("fleetd/wakes/Wakes") {}

/** A firing this much past its time follows the wake's catchUp: the hub was down, or the host slept. */
export const LATE_AFTER = Duration.minutes(1);

const encodeWake = Schema.encodeSync(Schema.fromJsonString(Wake));
const decodeWake = Schema.decodeSync(Schema.fromJsonString(Wake));
const iso = (ms: number) => new Date(ms).toISOString();

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const queue = yield* WriteQueue.WriteQueue;
  const events = yield* EventLog.EventLog;
  const usage = yield* Usage.Usage;
  const scope = yield* Effect.scope;
  const lateAfterMs = Duration.toMillis(LATE_AFTER);

  const sql = {
    insert: db.prepare(
      `INSERT INTO wakes (wake_id, created_by, client_request_id, machine_id, thread_id, state, next_run_ms, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    byRequest: db.prepare("SELECT data FROM wakes WHERE created_by = ? AND client_request_id = ?"),
    get: db.prepare("SELECT data, fired FROM wakes WHERE wake_id = ?"),
    list: db.prepare(
      `SELECT data FROM wakes
       WHERE ($machine IS NULL OR machine_id = $machine) AND ($thread IS NULL OR thread_id = $thread)
         AND ($state IS NULL OR state = $state)
       ORDER BY rowid`,
    ),
    // Held wakes ($held, a JSON array of ids) wait on the usage layer, not on the clock.
    earliest: db.prepare(
      `SELECT wake_id, data, fired, next_run_ms FROM wakes
       WHERE state = 'active' AND next_run_ms IS NOT NULL AND wake_id NOT IN (SELECT value FROM json_each($held))
       ORDER BY next_run_ms LIMIT 1`,
    ),
    // Only an active wake moves on, so a cancel that lands mid-firing sticks.
    advance: db.prepare("UPDATE wakes SET state = ?, next_run_ms = ?, fired = ?, data = ? WHERE wake_id = ? AND state = 'active'"),
    cancel: db.prepare("UPDATE wakes SET state = 'cancelled', next_run_ms = NULL, data = ? WHERE wake_id = ? AND state = 'active'"),
    overdue: db.prepare(
      "SELECT COUNT(*) AS n FROM wakes WHERE state = 'active' AND next_run_ms < $before AND wake_id NOT IN (SELECT value FROM json_each($held))",
    ),
  };

  /** Due wakes waiting for their thread's usage hold to clear. */
  const held = new Set<string>();
  const heldJson = () => JSON.stringify([...held]);

  let changed = Deferred.makeUnsafe<void>();
  const signal = Effect.suspend(() => {
    const done = changed;
    changed = Deferred.makeUnsafe<void>();
    return Deferred.succeed(done, undefined);
  });

  const getWake = (wakeId: string) => {
    const row = sql.get.get(wakeId);
    return row === undefined ? undefined : decodeWake(String(row.data));
  };

  const set: Wakes["Service"]["set"] = (input) =>
    Effect.gen(function* () {
      const existing = sql.byRequest.get(input.createdBy, input.clientRequestId);
      if (existing !== undefined) {
        const wake = decodeWake(String(existing.data));
        return { wakeId: wake.wakeId, nextRunAt: wake.nextRunAt ?? wake.lastFiredAt ?? "" };
      }
      const now = yield* Clock.currentTimeMillis;
      const next = yield* Effect.try({
        try: () => {
          validate(input.schedule);
          return nextRun(input.schedule, now);
        },
        catch: (error) => new WakeInvalid({ message: error instanceof ScheduleError ? error.message : String(error) }),
      });
      if (next === undefined) {
        return yield* new WakeInvalid({
          message: input.schedule.kind === "at" ? `${input.schedule.at} is in the past` : "this schedule never runs",
        });
      }
      const wake: Wake = {
        wakeId: `wk_${randomBytes(9).toString("base64url")}`,
        target: input.target,
        schedule: input.schedule,
        message: input.message,
        once: input.once,
        catchUp: input.catchUp,
        nextRunAt: iso(next),
        createdBy: input.createdBy,
        state: "active",
      };
      sql.insert.run(
        wake.wakeId,
        input.createdBy,
        input.clientRequestId,
        wake.target.machineId,
        wake.target.threadId,
        wake.state,
        next,
        encodeWake(wake),
      );
      yield* signal;
      return { wakeId: wake.wakeId, nextRunAt: wake.nextRunAt! };
    });

  const cancel: Wakes["Service"]["cancel"] = (wakeId) =>
    Effect.gen(function* () {
      const wake = getWake(wakeId);
      if (wake === undefined || wake.state !== "active") return;
      const { nextRunAt: _, ...rest } = wake;
      sql.cancel.run(encodeWake({ ...rest, state: "cancelled" }), wakeId);
      yield* signal;
    });

  /**
   * Fires (or, when late with catchUp "skip", passes over) a due wake and schedules its next run. A wake whose
   * thread is held by the usage layer is not fired: it stays due and fires once the hold clears. `afterHold` is that
   * firing, which goes out whatever its catchUp, since the wait was fleetd's, not a missed run.
   */
  const fire = (wake: Wake, fired: number, afterHold = false): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!afterHold && (yield* usage.hold(wake.target)) !== undefined) return yield* holdUntilClear(wake);
      const now = yield* Clock.currentTimeMillis;
      const scheduled = Date.parse(wake.nextRunAt!);
      const lateMs = now - scheduled;
      const late = !afterHold && lateMs >= lateAfterMs;
      const lateMin = Math.round(lateMs / 60_000);
      const next = wake.once ? undefined : nextRun(wake.schedule, now, scheduled);
      const { nextRunAt: _, ...rest } = wake;
      const moved: Wake = {
        ...rest,
        ...(next === undefined ? {} : { nextRunAt: iso(next) }),
        state: next === undefined ? "done" : "active",
      };
      const base = { at: iso(now), machineId: wake.target.machineId, threadId: wake.target.threadId };
      const nextNote = next === undefined ? "" : `; next at ${iso(next)}`;

      if (late && wake.catchUp === "skip") {
        sql.advance.run(moved.state, next ?? null, fired, encodeWake(moved), wake.wakeId);
        yield* events.append({
          ...base,
          type: "wake.missed",
          summary: `Wake ${wake.wakeId} for thread ${wake.target.threadId} missed its ${wake.nextRunAt} run by ${lateMin} min and was skipped${nextNote}`,
          data: { wakeId: wake.wakeId, scheduledAt: wake.nextRunAt, lateMin },
        });
        return;
      }

      const n = fired + 1;
      const message = afterHold
        ? `(held ${lateMin} min by a usage pause) ${wake.message}`
        : late
          ? `(late by ${lateMin} min) ${wake.message}`
          : wake.message;
      // The id is stable per firing, so a firing retried after a crash reaches the thread once.
      const result = yield* queue
        .send(wake.target, message, `wake:${wake.wakeId}:${n}`, { wakeId: wake.wakeId })
        .pipe(Effect.result);
      const done: Wake = { ...moved, lastFiredAt: iso(now) };
      sql.advance.run(done.state, next ?? null, n, encodeWake(done), wake.wakeId);
      const outcome =
        result._tag === "Failure"
          ? `could not be delivered: ${result.failure.message}`
          : result.success.queued
            ? `queued until ${result.success.queuedUntil} (machine offline)`
            : "delivered";
      yield* events.append({
        ...base,
        type: "wake.fired",
        summary: `Wake ${wake.wakeId} fired${late ? ` ${lateMin} min late` : afterHold ? ` after a ${lateMin} min usage hold` : ""} for thread ${wake.target.threadId}: ${outcome}${nextNote}`,
        data: {
          wakeId: wake.wakeId,
          n,
          scheduledAt: wake.nextRunAt,
          ...(late ? { late: true, lateMin } : afterHold ? { heldMin: lateMin } : {}),
          ...(result._tag === "Failure"
            ? { delivered: false, error: result.failure._tag }
            : {
                queued: result.success.queued,
                ...(result.success.queuedUntil === undefined ? {} : { queuedUntil: result.success.queuedUntil }),
                ...(result.success.runId === undefined ? {} : { runId: result.success.runId }),
              }),
        },
      });
    });

  /** Takes the wake out of the schedule until its thread's usage hold clears, then fires it as it stands then. */
  const holdUntilClear = (wake: Wake): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { wakeId } = wake;
      if (held.has(wakeId)) return;
      held.add(wakeId);
      yield* Effect.logInfo("wake held by the usage layer until it clears", { wakeId, thread: `${wake.target.machineId}/${wake.target.threadId}` });
      yield* usage.whenClear(wake.target).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const row = sql.get.get(wakeId);
            const now = row === undefined ? undefined : decodeWake(String(row.data));
            // Cancelled while held.
            return now?.state === "active" ? fire(now, Number(row!.fired), true) : Effect.void;
          }),
        ),
        Effect.catchCause((cause) => Effect.logError("held wake firing failed", { wakeId, cause })),
        Effect.ensuring(Effect.andThen(Effect.sync(() => held.delete(wakeId)), signal)),
        Effect.forkIn(scope),
      );
    });

  /** Sleeps until the earliest active wake is due, or until a wake is set or cancelled. */
  const scheduler = Effect.gen(function* () {
    while (true) {
      const wake = changed;
      const row = sql.earliest.get({ held: heldJson() });
      if (row === undefined) {
        yield* Deferred.await(wake);
        continue;
      }
      const wait = Number(row.next_run_ms) - (yield* Clock.currentTimeMillis);
      if (wait > 0) {
        yield* Effect.raceFirst(Effect.sleep(Duration.millis(wait)), Deferred.await(wake));
        continue;
      }
      const wakeId = String(row.wake_id);
      yield* Effect.suspend(() => fire(decodeWake(String(row.data)), Number(row.fired))).pipe(
        // Retiring it keeps one broken row from spinning the scheduler.
        Effect.catchDefect((defect) =>
          Effect.logError("wake firing failed; wake retired", { wakeId, defect }).pipe(
            Effect.andThen(Effect.sync(() => db.prepare("UPDATE wakes SET state = 'done', next_run_ms = NULL WHERE wake_id = ?").run(wakeId))),
          ),
        ),
      );
    }
  });

  yield* Effect.forkScoped(scheduler);

  return Wakes.of({
    set,
    list: (filter) =>
      Effect.sync(() =>
        sql.list
          .all({ machine: filter.machineId ?? null, thread: filter.threadId ?? null, state: filter.state ?? null })
          .map((row) => decodeWake(String(row.data))),
      ),
    get: (wakeId) => Effect.sync(() => getWake(wakeId)),
    cancel,
    sweepOverdue: (olderThanMs) =>
      Effect.gen(function* () {
        const n = Number(sql.overdue.get({ before: (yield* Clock.currentTimeMillis) - olderThanMs, held: heldJson() })?.n ?? 0);
        if (n === 0) return 0;
        yield* Effect.logWarning("sweep: wakes overdue; waking the scheduler", { overdue: n });
        yield* signal;
        return n;
      }),
  });
});

/** Needs HubDb, WriteQueue, EventLog and Usage. */
export const layer = Layer.effect(Wakes, make);
