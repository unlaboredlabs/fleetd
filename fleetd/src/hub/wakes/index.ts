// Hub-owned wakes (crates/fleetd/src/hub/wakes/mod.rs): stored in SQLite, scheduled on the hub clock, delivered
// through the write queue so a wake for an offline machine waits for it. One scheduler sleeps until the earliest active
// wake is due. A firing is a turn, so one whose thread the usage layer holds stays due until the hold clears.
import type { MachineId, ThreadId, Wake, WakeCatchUp, WakeSchedule, WakeState, WakeTarget } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { queuePorts } from "../leads/seams.ts";
import { events, type NewEvent } from "../store/events.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { nextRun, ScheduleError, validate } from "./schedule.ts";

/** A firing this much past its time follows the wake's catchUp: the hub was down, or the host slept. */
export const LATE_AFTER_MS = 60_000;

export type WakeSet = {
  target: WakeTarget;
  schedule: WakeSchedule;
  message: string;
  once: boolean;
  catchUp: WakeCatchUp;
  clientRequestId: string;
  /** keyId of the caller. */
  createdBy: string;
};

export type WakeFilter = { machineId?: MachineId; threadId?: ThreadId; state?: WakeState };

export class WakeInvalid extends Error {}

const thread = (t: WakeTarget) => ({ machineId: t.machineId, threadId: t.threadId });

/** The wake in the Rust struct's field order, so rows read the same. */
function encode(w: Wake): string {
  const o: Record<string, unknown> = {
    wakeId: w.wakeId,
    target: w.target,
    schedule: w.schedule,
    message: w.message,
    once: w.once,
    catchUp: w.catchUp,
  };
  if (w.nextRunAt !== undefined) o.nextRunAt = w.nextRunAt;
  if (w.lastFiredAt !== undefined) o.lastFiredAt = w.lastFiredAt;
  o.createdBy = w.createdBy;
  o.state = w.state;
  return JSON.stringify(o);
}

const decode = (data: string) => JSON.parse(data) as Wake;

/** `wk_` and 9 random bytes, URL-safe base64. */
const newId = () => `wk_${Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString("base64url")}`;

export const wakes = (hub: Hub) => hub.area("wakes", (h) => new Wakes(h));

export class Wakes {
  /** Due wakes waiting for their thread's usage hold to clear. */
  private readonly held = new Set<string>();
  private wakeUp: (() => void) | undefined;
  private started = false;

  constructor(private readonly hub: Hub) {}

  private now(): number {
    return this.hub.clock.now();
  }

  private signal(): void {
    this.wakeUp?.();
  }

  private heldJson(): string {
    return JSON.stringify([...this.held]);
  }

  /** Idempotent per (createdBy, clientRequestId): a retry returns the wake the first call made. */
  set(input: WakeSet): { wakeId: string; nextRunAt: string } {
    const existing = this.hub.db.all<{ data: string }>("SELECT data FROM wakes WHERE created_by = ? AND client_request_id = ?", [
      input.createdBy,
      input.clientRequestId,
    ])[0];
    if (existing) {
      const w = decode(existing.data);
      return { wakeId: w.wakeId, nextRunAt: w.nextRunAt ?? w.lastFiredAt ?? "" };
    }
    let next: number | undefined;
    try {
      validate(input.schedule);
      next = nextRun(input.schedule, this.now());
    } catch (error) {
      if (error instanceof ScheduleError) throw new WakeInvalid(error.message);
      throw error;
    }
    if (next === undefined) {
      throw new WakeInvalid(input.schedule.kind === "at" ? `${input.schedule.at} is in the past` : "this schedule never runs");
    }
    const wake: Wake = {
      wakeId: newId(),
      target: input.target,
      schedule: input.schedule,
      message: input.message,
      once: input.once,
      catchUp: input.catchUp,
      nextRunAt: isoMs(next),
      createdBy: input.createdBy,
      state: "active",
    };
    this.hub.db.conn
      .query(
        `INSERT INTO wakes (wake_id, created_by, client_request_id, machine_id, thread_id, state, next_run_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(wake.wakeId, input.createdBy, input.clientRequestId, wake.target.machineId, wake.target.threadId, wake.state, next, encode(wake));
    this.signal();
    return { wakeId: wake.wakeId, nextRunAt: isoMs(next) };
  }

  /** Oldest first. */
  list(filter: WakeFilter): Wake[] {
    return this.hub.db
      .all<{ data: string }>(
        `SELECT data FROM wakes
         WHERE (?1 IS NULL OR machine_id = ?1) AND (?2 IS NULL OR thread_id = ?2) AND (?3 IS NULL OR state = ?3)
         ORDER BY rowid`,
        [filter.machineId ?? null, filter.threadId ?? null, filter.state ?? null],
      )
      .map((r) => decode(r.data));
  }

  private row(wakeId: string): { wake: Wake; fired: number } | undefined {
    const r = this.hub.db.all<{ data: string; fired: number }>("SELECT data, fired FROM wakes WHERE wake_id = ?", [wakeId])[0];
    return r ? { wake: decode(r.data), fired: r.fired } : undefined;
  }

  get(wakeId: string): Wake | undefined {
    return this.row(wakeId)?.wake;
  }

  /** A no-op for a wake that is already done or cancelled. */
  cancel(wakeId: string): void {
    const wake = this.get(wakeId);
    if (!wake || wake.state !== "active") return;
    const cancelled: Wake = { ...wake, state: "cancelled" };
    delete cancelled.nextRunAt;
    this.hub.db.conn
      .query("UPDATE wakes SET state = 'cancelled', next_run_ms = NULL, data = ? WHERE wake_id = ? AND state = 'active'")
      .run(encode(cancelled), wakeId);
    this.signal();
  }

  /** The sweep's check: counts active wakes overdue by more than `olderThanMs` and wakes the scheduler. */
  sweepOverdue(olderThanMs: number): number {
    const before = this.now() - olderThanMs;
    const n =
      this.hub.db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM wakes WHERE state = 'active' AND next_run_ms < ?1
         AND wake_id NOT IN (SELECT value FROM json_each(?2))`,
        [before, this.heldJson()],
      )[0]?.n ?? 0;
    if (n === 0) return 0;
    console.warn(`sweep: ${n} wakes overdue; waking the scheduler`);
    this.signal();
    return n;
  }

  private advance(wake: Wake, next: number | undefined, fired: number): void {
    // Only an active wake moves on, so a cancel that lands mid-firing sticks.
    this.hub.db.conn
      .query("UPDATE wakes SET state = ?, next_run_ms = ?, fired = ?, data = ? WHERE wake_id = ? AND state = 'active'")
      .run(wake.state, next ?? null, fired, encode(wake), wake.wakeId);
  }

  /**
   * Fires (or, when late with catchUp "skip", passes over) a due wake and schedules its next run. A wake whose thread
   * is held by the usage layer is not fired: it stays due and fires once the hold clears (`afterHold`).
   */
  private async fire(wake: Wake, fired: number, afterHold: boolean): Promise<void> {
    const ports = queuePorts(this.hub);
    if (!afterHold && (await ports.usageHold(thread(wake.target))) !== undefined) {
      this.holdUntilClear(wake);
      return;
    }
    const now = this.now();
    const scheduledAt = wake.nextRunAt;
    if (scheduledAt === undefined) throw new Error("active wake without nextRunAt");
    const scheduled = parseMs(scheduledAt);
    if (scheduled === undefined) throw new Error("bad nextRunAt");
    const lateMs = now - scheduled;
    const late = !afterHold && lateMs >= LATE_AFTER_MS;
    const lateMin = Math.round(lateMs / 60_000);
    const next = wake.once ? undefined : nextRun(wake.schedule, now, scheduled);
    const moved: Wake = { ...wake, state: next === undefined ? "done" : "active" };
    if (next === undefined) delete moved.nextRunAt;
    else moved.nextRunAt = isoMs(next);
    const nextNote = next === undefined ? "" : `; next at ${isoMs(next)}`;
    const event = (type: NewEvent["type"], summary: string, data: Record<string, unknown>): NewEvent => ({
      at: isoMs(now),
      type,
      machineId: wake.target.machineId,
      threadId: wake.target.threadId,
      summary,
      data,
    });
    if (late && wake.catchUp === "skip") {
      this.advance(moved, next, fired);
      events(this.hub).append(
        event(
          "wake.missed",
          `Wake ${wake.wakeId} for thread ${wake.target.threadId} missed its ${scheduledAt} run by ${lateMin} min and was skipped${nextNote}`,
          { wakeId: wake.wakeId, scheduledAt, lateMin },
        ),
      );
      return;
    }
    const n = fired + 1;
    const message = afterHold
      ? `(held ${lateMin} min by a usage pause) ${wake.message}`
      : late
        ? `(late by ${lateMin} min) ${wake.message}`
        : wake.message;
    // The id is stable per firing, so a firing retried after a crash reaches the thread once.
    let result: { ok: true; sent: Awaited<ReturnType<typeof ports.send>> } | { ok: false; error: unknown };
    try {
      result = { ok: true, sent: await ports.send(thread(wake.target), message, `wake:${wake.wakeId}:${n}`, wake.wakeId) };
    } catch (error) {
      result = { ok: false, error };
    }
    this.advance({ ...moved, lastFiredAt: isoMs(now) }, next, n);
    const outcome = !result.ok
      ? `could not be delivered: ${(result.error as Error).message ?? result.error}`
      : result.sent.queued
        ? `queued until ${result.sent.queuedUntil ?? ""} (machine offline)`
        : "delivered";
    const data: Record<string, unknown> = { wakeId: wake.wakeId, n, scheduledAt };
    if (late) {
      data.late = true;
      data.lateMin = lateMin;
    } else if (afterHold) data.heldMin = lateMin;
    if (!result.ok) {
      data.delivered = false;
      data.error = (result.error as { tag?: string }).tag ?? "NodeRequestFailed";
    } else {
      data.queued = result.sent.queued;
      if (result.sent.queuedUntil !== undefined) data.queuedUntil = result.sent.queuedUntil;
      if (result.sent.runId !== undefined) data.runId = result.sent.runId;
    }
    const how = late ? ` ${lateMin} min late` : afterHold ? ` after a ${lateMin} min usage hold` : "";
    events(this.hub).append(
      event("wake.fired", `Wake ${wake.wakeId} fired${how} for thread ${wake.target.threadId}: ${outcome}${nextNote}`, data),
    );
  }

  /** Takes the wake out of the schedule until its thread's usage hold clears, then fires it as it stands then. */
  private holdUntilClear(wake: Wake): void {
    const id = wake.wakeId;
    if (this.held.has(id)) return;
    this.held.add(id);
    void (async () => {
      await queuePorts(this.hub).whenClear(thread(wake.target));
      if (this.hub.shutdown.signal.aborted) return;
      const now = this.row(id);
      if (now && now.wake.state === "active") {
        await this.fire(now.wake, now.fired, true).catch((error) => console.error(`held wake ${id} firing failed:`, error));
      }
      this.held.delete(id);
      this.signal();
    })();
  }

  /** Starts the scheduler, until the hub stops. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.scheduler();
  }

  /** Sleeps until the earliest active wake is due, or until a wake is set or cancelled. */
  private async scheduler(): Promise<void> {
    const stop = this.hub.shutdown.signal;
    while (!stop.aborted) {
      const row = this.hub.db.all<{ wake_id: string; data: string; fired: number; next_run_ms: number }>(
        `SELECT wake_id, data, fired, next_run_ms FROM wakes
         WHERE state = 'active' AND next_run_ms IS NOT NULL AND wake_id NOT IN (SELECT value FROM json_each(?1))
         ORDER BY next_run_ms LIMIT 1`,
        [this.heldJson()],
      )[0];
      const wait = row ? row.next_run_ms - this.now() : undefined;
      if (wait === undefined || wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = wait === undefined ? undefined : setTimeout(done, Math.min(wait, 2 ** 31 - 1));
          function done() {
            clearTimeout(timer);
            stop.removeEventListener("abort", done);
            resolve();
          }
          this.wakeUp = done;
          stop.addEventListener("abort", done);
        });
        this.wakeUp = undefined;
        continue;
      }
      if (!row) continue;
      try {
        await this.fire(decode(row.data), row.fired, false);
      } catch (error) {
        // Retiring it keeps one broken row from spinning the scheduler.
        console.error(`wake ${row.wake_id} firing failed; wake retired:`, error);
        this.hub.db.conn.query("UPDATE wakes SET state = 'done', next_run_ms = NULL WHERE wake_id = ?").run(row.wake_id);
      }
    }
  }
}
