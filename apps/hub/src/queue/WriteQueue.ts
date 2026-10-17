// The offline write queue. Additive writes (thread_send, wake firings) to a machine without a live T3 connection
// wait here, in order, and go out when it comes back; each ends as one write.delivered or write.expired event.
// Interrupts and launches are not additive, so they never come through here and still fail when offline.
import type { MachineId, ThreadId, ThreadRef } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Executors from "../executor/Executors.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";

export interface SendResult {
  readonly runId?: string;
  /** True when the message waits in this queue rather than having reached T3. */
  readonly queued: boolean;
  readonly queuedUntil?: string;
}

export class WriteQueue extends Context.Service<
  WriteQueue,
  {
    /**
     * Sends now when the machine is connected and nothing is queued for it; otherwise queues the message until it
     * is. `clientRequestId` is the T3 command id, so a retried or re-queued send is delivered once.
     */
    readonly send: (
      ref: ThreadRef,
      message: string,
      clientRequestId: string,
      origin?: { readonly wakeId?: string },
    ) => Effect.Effect<SendResult, Executors.ThreadNotFound | Executors.T3RequestFailed>;
  }
>()("fleetd/queue/WriteQueue") {}

export interface WriteQueueOptions {
  /** How long a queued write waits before it expires; default 24 h. */
  readonly ttl?: Duration.Input;
}

/** A send that takes longer is retried from the queue; the command id makes the retry harmless. */
const SEND_TIMEOUT = Duration.seconds(15);
const RETRY_DELAY = Duration.seconds(5);

interface Row {
  readonly writeId: number;
  readonly ref: ThreadRef;
  readonly clientRequestId: string;
  readonly message: string;
  readonly wakeId: string | undefined;
  readonly queuedMs: number;
  readonly expiresMs: number;
}

const toRow = (r: Record<string, unknown>): Row => ({
  writeId: Number(r.write_id),
  ref: { machineId: String(r.machine_id) as MachineId, threadId: String(r.thread_id) as ThreadId },
  clientRequestId: String(r.client_request_id),
  message: String(r.message),
  wakeId: r.wake_id === null ? undefined : String(r.wake_id),
  queuedMs: Number(r.queued_ms),
  expiresMs: Number(r.expires_ms),
});

const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => (ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`);

export const make = (options: WriteQueueOptions = {}) =>
  Effect.gen(function* () {
    const { db } = yield* HubDb.HubDb;
    const executors = yield* Executors.Executors;
    const events = yield* EventLog.EventLog;
    const ttlMs = Duration.toMillis(Duration.fromInputUnsafe(options.ttl ?? "24 hours"));

    const sql = {
      insert: db.prepare(
        `INSERT INTO queued_writes (machine_id, thread_id, client_request_id, message, wake_id, queued_ms, expires_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (client_request_id) DO NOTHING`,
      ),
      byRequest: db.prepare("SELECT * FROM queued_writes WHERE client_request_id = ?"),
      head: db.prepare("SELECT * FROM queued_writes WHERE machine_id = ? ORDER BY write_id LIMIT 1"),
      count: db.prepare("SELECT COUNT(*) AS n FROM queued_writes WHERE machine_id = ?"),
      machines: db.prepare("SELECT DISTINCT machine_id FROM queued_writes"),
      due: db.prepare("SELECT * FROM queued_writes WHERE expires_ms <= ? ORDER BY write_id"),
      nextExpiry: db.prepare("SELECT MIN(expires_ms) AS ms FROM queued_writes WHERE expires_ms > ?"),
      remove: db.prepare("DELETE FROM queued_writes WHERE write_id = ?"),
    };

    /** Rows a flusher is sending right now; the expiry timer leaves them to it. */
    const inFlight = new Set<number>();
    const flushers = yield* FiberMap.make<MachineId>();
    let changed = Deferred.makeUnsafe<void>();
    const signal = Effect.suspend(() => {
      const done = changed;
      changed = Deferred.makeUnsafe<void>();
      return Deferred.succeed(done, undefined);
    });

    /** Removes the row and reports whether this call did, so each write ends in exactly one event. */
    const take = (row: Row) => Effect.sync(() => Number(sql.remove.run(row.writeId).changes) === 1);

    const fields = (row: Row) => ({
      clientRequestId: row.clientRequestId,
      queuedAt: iso(row.queuedMs),
      ...(row.wakeId === undefined ? {} : { wakeId: row.wakeId }),
    });

    const delivered = (row: Row, runId: string | undefined) =>
      Effect.gen(function* () {
        if (!(yield* take(row))) return;
        const now = yield* Clock.currentTimeMillis;
        yield* events.append({
          at: iso(now),
          type: "write.delivered",
          machineId: row.ref.machineId,
          threadId: row.ref.threadId,
          summary: `Queued message to thread ${row.ref.threadId} on ${row.ref.machineId} delivered after ${ago(now - row.queuedMs)}`,
          data: { ...fields(row), ...(runId === undefined ? {} : { runId }) },
        });
      });

    const expired = (row: Row, reason: "ttl" | "refused") =>
      Effect.gen(function* () {
        if (!(yield* take(row))) return;
        const now = yield* Clock.currentTimeMillis;
        yield* events.append({
          at: iso(now),
          type: "write.expired",
          machineId: row.ref.machineId,
          threadId: row.ref.threadId,
          summary:
            reason === "ttl"
              ? `Queued message to thread ${row.ref.threadId} on ${row.ref.machineId} expired undelivered after ${ago(now - row.queuedMs)}`
              : `Queued message to thread ${row.ref.threadId} on ${row.ref.machineId} dropped: T3 refused it`,
          data: { ...fields(row), reason },
        });
      });

    const sendTimed = (ref: ThreadRef, message: string, clientRequestId: string) =>
      executors.send(ref, message, clientRequestId).pipe(Effect.timeoutOption(SEND_TIMEOUT));

    /** Delivers one machine's queue in order, waiting for its connection as needed. Ends when the queue is empty. */
    const flush = (machineId: MachineId) =>
      Effect.gen(function* () {
        while (true) {
          const raw = sql.head.get(machineId);
          if (raw === undefined) return;
          const row = toRow(raw);
          if (row.expiresMs <= (yield* Clock.currentTimeMillis)) {
            yield* expired(row, "ttl");
            continue;
          }
          if (!(yield* executors.isConnected(machineId))) {
            // The head may expire meanwhile, so it is read again once the machine is back.
            yield* executors.awaitLive(machineId);
            continue;
          }
          inFlight.add(row.writeId);
          const result = yield* sendTimed(row.ref, row.message, row.clientRequestId).pipe(
            Effect.result,
            Effect.ensuring(Effect.sync(() => inFlight.delete(row.writeId))),
          );
          if (result._tag === "Success") {
            if (Option.isSome(result.success)) yield* delivered(row, result.success.value.runId);
            else yield* Effect.sleep(RETRY_DELAY);
            continue;
          }
          // Lost the connection mid-send: wait for it again. Refused on a live connection: retrying won't help.
          const error = result.failure;
          if (error._tag === "MachineNotConnected" || !(yield* executors.isConnected(machineId))) continue;
          yield* Effect.logWarning("write queue: T3 refused a queued message").pipe(
            Effect.annotateLogs({ machineId, threadId: row.ref.threadId, error: error._tag }),
          );
          yield* expired(row, "refused");
        }
      });

    const startFlusher = (machineId: MachineId) => FiberMap.run(flushers, machineId, flush(machineId), { onlyIfMissing: true });

    /** Expires rows as their TTL passes, so a write to a machine that stays away is reported on time. */
    const expiryLoop = Effect.gen(function* () {
      while (true) {
        const wake = changed;
        const now = yield* Clock.currentTimeMillis;
        for (const raw of sql.due.all(now)) {
          const row = toRow(raw);
          if (!inFlight.has(row.writeId)) yield* expired(row, "ttl");
        }
        const next = sql.nextExpiry.get(now)?.ms;
        const waitFor = Deferred.await(wake);
        yield* next === null || next === undefined
          ? waitFor
          : Effect.raceFirst(Effect.sleep(Duration.millis(Number(next) - now)), waitFor);
      }
    });

    const enqueue = (ref: ThreadRef, message: string, clientRequestId: string, wakeId: string | undefined) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        sql.insert.run(ref.machineId, ref.threadId, clientRequestId, message, wakeId ?? null, now, now + ttlMs);
        const row = toRow(sql.byRequest.get(clientRequestId)!);
        yield* startFlusher(ref.machineId);
        yield* signal;
        return { queued: true, queuedUntil: iso(row.expiresMs) } satisfies SendResult;
      });

    const send: WriteQueue["Service"]["send"] = (ref, message, clientRequestId, origin) =>
      Effect.gen(function* () {
        const behind = Number(sql.count.get(ref.machineId)?.n ?? 0) > 0;
        if (behind || !(yield* executors.isConnected(ref.machineId))) {
          return yield* enqueue(ref, message, clientRequestId, origin?.wakeId);
        }
        const sent = yield* sendTimed(ref, message, clientRequestId).pipe(
          Effect.catchTag("MachineNotConnected", () => Effect.succeedNone),
        );
        if (Option.isNone(sent)) return yield* enqueue(ref, message, clientRequestId, origin?.wakeId);
        const runId = sent.value.runId;
        return runId === undefined ? { queued: false } : { runId, queued: false };
      });

    for (const raw of sql.machines.all()) yield* startFlusher(String(raw.machine_id) as MachineId);
    yield* Effect.forkScoped(expiryLoop);

    return WriteQueue.of({ send });
  });

export const layer = (options: WriteQueueOptions = {}) => Layer.effect(WriteQueue, make(options));
