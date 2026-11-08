// The offline write queue (crates/fleetd/src/hub/queue/mod.rs). Additive writes (lead messages, wake firings) to a
// machine without a live node link wait here, in order, and go out when it comes back; each ends as one
// write.delivered or write.expired event. Interrupts and launches are not additive, so they never come through here.
import type { HubEvent, ThreadRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { events, type NewEvent } from "../store/events.ts";
import { isoMs } from "../store/time.ts";

/** How long a write to an offline machine waits in the queue. */
export const DEFAULT_TTL_MS = 24 * 3600 * 1000;
/** A send that takes longer is retried from the queue; the command id makes the retry harmless. */
const SEND_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 5000;

export type SendMode = "plain" | "boundary" | "now";

/** How a write reaches a running thread: plain (wakes, nudges), or as a steer. */
export type SendOpts = { mode?: SendMode; steer?: string; riders?: string[] };

/** A message the node took. */
export type Sent = { runId?: string; behindRun?: boolean };

export type SendResult = {
  runId?: string;
  /** True when the message waits in this queue rather than having reached the node. */
  queued: boolean;
  queuedUntil?: string;
  /** The node took it, and it waits behind the thread's active run. */
  behindRun?: true;
};

/** queue/ports.rs `ExecutorError`: why a send didn't reach the node. */
export class WriteError extends Error {
  constructor(
    readonly kind: "MachineNotConnected" | "ThreadNotFound" | "NodeRequestFailed",
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "WriteError";
  }

  /** The error tag, as event data carries it. */
  get tag(): string {
    return this.kind;
  }
}

/** How a write reaches a thread: the executor's `is_connected`, `await_live` and `send_with` (queue/ports.rs). */
export interface ThreadWriter {
  isConnected(machineId: string): boolean;
  /** Resolves once the machine takes writes, at once if it does now; on `signal`, early. */
  awaitLive(machineId: string, signal?: AbortSignal): Promise<void>;
  sendWith(target: ThreadRef, message: string, clientRequestId: string, opts: SendOpts): Promise<Sent>;
  /** Why a linked machine can't take a message at all (its runner logged out), so a send fails at once. */
  refusal?(machineId: string): WriteError | undefined;
}

type Row = {
  write_id: number;
  machine_id: string;
  thread_id: string;
  client_request_id: string;
  message: string;
  wake_id: string | null;
  queued_ms: number;
  expires_ms: number;
  mode: string | null;
  steer_id: string | null;
};

const optsOf = (r: Row): SendOpts => ({
  mode: r.mode === "boundary" ? "boundary" : r.mode === "now" ? "now" : "plain",
  ...(r.steer_id === null ? {} : { steer: r.steer_id }),
});

/** JS `Math.round` for the non-negative values used here. */
const ago = (ms: number) => (ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const TIMED_OUT = Symbol("timed out");
const within = <T>(ms: number, p: Promise<T>): Promise<T | typeof TIMED_OUT> =>
  Promise.race([p, new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms))]);

export type SteerExpired = (steer: string, reason: "ttl" | "refused") => void;

export class WriteQueue {
  /** Rows a flusher is sending right now; the expiry timer leaves them to it. */
  private readonly inFlight = new Set<number>();
  private readonly flushers = new Set<string>();
  private readonly stopped = new AbortController();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryWake: (() => void) | undefined;
  /** Told when a queued steer expires or is refused, so its receipt says so. */
  private steerExpired: SteerExpired | undefined;

  constructor(
    private readonly hub: Hub,
    readonly writer: ThreadWriter,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  private now = () => this.hub.clock.now();

  isConnected(machineId: string): boolean {
    return this.writer.isConnected(machineId);
  }

  onSteerExpired(fn: SteerExpired): void {
    this.steerExpired = fn;
  }

  /** Resumes delivery of writes queued before a restart and starts the expiry timer. */
  start(): void {
    for (const { machine_id } of this.hub.db.all<{ machine_id: string }>("SELECT DISTINCT machine_id FROM queued_writes")) {
      this.startFlusher(machine_id);
    }
    void this.expiryLoop();
  }

  /** Stops every loop (a hub shutdown); queued rows stay for the next start. */
  stop(): void {
    this.stopped.abort();
    clearTimeout(this.expiryTimer);
    this.expiryWake?.();
  }

  /**
   * Sends now when the machine is connected and nothing is queued for it; otherwise queues the message until it is.
   * `clientRequestId` names the node's run, so a retried or re-queued send is delivered once. Throws a WriteError
   * (ThreadNotFound or NodeRequestFailed), never MachineNotConnected.
   */
  async send(target: ThreadRef, message: string, clientRequestId: string, wakeId?: string, opts: SendOpts = {}): Promise<SendResult> {
    // Linked but unusable (logged out, claude out of range): fail now in the runner's words.
    const refused = this.writer.refusal?.(target.machineId);
    if (refused) throw refused;
    const behind =
      this.hub.db.conn.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM queued_writes WHERE machine_id = ?").get(target.machineId)?.n ?? 0;
    if (behind > 0 || !this.writer.isConnected(target.machineId)) return this.enqueue(target, message, clientRequestId, wakeId, opts);
    let sent: Sent | typeof TIMED_OUT;
    try {
      sent = await within(SEND_TIMEOUT_MS, this.writer.sendWith(target, message, clientRequestId, opts));
    } catch (error) {
      if (error instanceof WriteError && error.kind === "MachineNotConnected") return this.enqueue(target, message, clientRequestId, wakeId, opts);
      throw error;
    }
    if (sent === TIMED_OUT) return this.enqueue(target, message, clientRequestId, wakeId, opts);
    return { ...(sent.runId === undefined ? {} : { runId: sent.runId }), queued: false, ...(sent.behindRun ? { behindRun: true as const } : {}) };
  }

  private enqueue(target: ThreadRef, message: string, clientRequestId: string, wakeId: string | undefined, opts: SendOpts): SendResult {
    const now = this.now();
    const c = this.hub.db.conn;
    c.query(
      `INSERT INTO queued_writes (machine_id, thread_id, client_request_id, message, wake_id, queued_ms, expires_ms, mode, steer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (client_request_id) DO NOTHING`,
    ).run(
      target.machineId,
      target.threadId,
      clientRequestId,
      message,
      wakeId ?? null,
      now,
      now + this.ttlMs,
      opts.mode === "boundary" || opts.mode === "now" ? opts.mode : null,
      opts.steer ?? null,
    );
    const expires =
      c.query<{ expires_ms: number }, [string]>("SELECT expires_ms FROM queued_writes WHERE client_request_id = ?").get(clientRequestId)
        ?.expires_ms ?? now + this.ttlMs;
    this.startFlusher(target.machineId);
    this.expiryWake?.();
    return { queued: true, queuedUntil: isoMs(expires) };
  }

  hasSteer(steer: string): boolean {
    return (this.hub.db.conn.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM queued_writes WHERE steer_id = ?").get(steer)?.n ?? 0) > 0;
  }

  /** Drops a steer still waiting here for its machine; true when this call did. One being sent now is not dropped. */
  withdrawSteer(steer: string): boolean {
    const row = this.hub.db.conn.query<{ write_id: number }, [string]>("SELECT write_id FROM queued_writes WHERE steer_id = ?").get(steer);
    if (!row || this.inFlight.has(row.write_id)) return false;
    return this.hub.db.conn.query("DELETE FROM queued_writes WHERE write_id = ?").run(row.write_id).changes > 0;
  }

  private stillQueued = (writeId: number) =>
    this.hub.db.conn.query("SELECT 1 FROM queued_writes WHERE write_id = ?").get(writeId) !== null;

  private head = (machineId: string) =>
    this.hub.db.conn.query<Row, [string]>("SELECT * FROM queued_writes WHERE machine_id = ? ORDER BY write_id LIMIT 1").get(machineId) ??
    undefined;

  /** Removes the row and reports whether this call did, so each write ends in exactly one event. */
  private take = (row: Row) => this.hub.db.conn.query("DELETE FROM queued_writes WHERE write_id = ?").run(row.write_id).changes === 1;

  private fields(row: Row): Record<string, unknown> {
    return { clientRequestId: row.client_request_id, queuedAt: isoMs(row.queued_ms), ...(row.wake_id === null ? {} : { wakeId: row.wake_id }) };
  }

  /** Appends, logging instead of failing: a lost event must not stop delivery. */
  private emit(event: NewEvent): HubEvent | undefined {
    try {
      return events(this.hub).append(event);
    } catch (error) {
      console.error("event append failed:", error);
      return undefined;
    }
  }

  private delivered(row: Row, runId: string | undefined): void {
    if (!this.take(row)) return;
    const now = this.now();
    this.emit({
      at: isoMs(now),
      type: "write.delivered",
      machineId: row.machine_id,
      threadId: row.thread_id,
      summary: `Queued message to thread ${row.thread_id} on ${row.machine_id} delivered after ${ago(now - row.queued_ms)}`,
      data: { ...this.fields(row), ...(runId === undefined ? {} : { runId }) },
    });
  }

  private expired(row: Row, reason: "ttl" | "refused"): void {
    if (!this.take(row)) return;
    const now = this.now();
    const [t, m] = [row.thread_id, row.machine_id];
    const summary =
      reason === "ttl"
        ? `Queued message to thread ${t} on ${m} expired undelivered after ${ago(now - row.queued_ms)}`
        : `Queued message to thread ${t} on ${m} dropped: the node refused it`;
    const data: Record<string, unknown> = { ...this.fields(row), reason };
    if (row.steer_id !== null) {
      data.steerId = row.steer_id;
      this.steerExpired?.(row.steer_id, reason);
    }
    this.emit({ at: isoMs(now), type: "write.expired", machineId: m, threadId: t, summary, data });
  }

  private startFlusher(machineId: string): void {
    if (this.flushers.has(machineId) || this.stopped.signal.aborted) return;
    this.flushers.add(machineId);
    void this.flush(machineId);
  }

  /** Delivers one machine's queue in order, waiting for its connection as needed. Ends when the queue is empty. */
  private async flush(machineId: string): Promise<void> {
    const signal = this.stopped.signal;
    try {
      while (!signal.aborted) {
        const row = this.head(machineId);
        if (!row) return;
        if (row.expires_ms <= this.now()) {
          this.expired(row, "ttl");
          continue;
        }
        if (!this.writer.isConnected(machineId)) {
          // The head may expire meanwhile, so it is read again once the machine is back.
          await this.writer.awaitLive(machineId, signal);
          continue;
        }
        // Withdrawn between the read and now: nothing to send.
        if (!this.stillQueued(row.write_id)) continue;
        this.inFlight.add(row.write_id);
        let result: Sent | typeof TIMED_OUT | WriteError | Error;
        try {
          result = await within(SEND_TIMEOUT_MS, this.writer.sendWith({ machineId: row.machine_id, threadId: row.thread_id }, row.message, row.client_request_id, optsOf(row)));
        } catch (error) {
          result = error as Error;
        } finally {
          this.inFlight.delete(row.write_id);
        }
        if (result === TIMED_OUT) await sleep(RETRY_DELAY_MS, signal);
        else if (result instanceof Error) {
          // Lost the connection mid-send: wait for it again. Refused on a live connection: retrying won't help.
          if (result instanceof WriteError && result.kind === "MachineNotConnected") continue;
          if (!this.writer.isConnected(machineId)) continue;
          console.warn(`write queue: the node on ${machineId} refused a queued message to ${row.thread_id}: ${result.message}`);
          this.expired(row, "refused");
        } else this.delivered(row, result.runId);
      }
    } finally {
      this.flushers.delete(machineId);
      // An enqueue racing this exit starts a new flusher.
      if (!signal.aborted && this.head(machineId)) this.startFlusher(machineId);
    }
  }

  /** Expires rows as their TTL passes, so a write to a machine that stays away is reported on time. */
  private async expiryLoop(): Promise<void> {
    const signal = this.stopped.signal;
    while (!signal.aborted) {
      const now = this.now();
      for (const row of this.hub.db.all<Row>("SELECT * FROM queued_writes WHERE expires_ms <= ? ORDER BY write_id", [now])) {
        if (!this.inFlight.has(row.write_id)) this.expired(row, "ttl");
      }
      const next = this.hub.db.conn
        .query<{ next: number | null }, [number]>("SELECT MIN(expires_ms) AS next FROM queued_writes WHERE expires_ms > ?")
        .get(now)?.next;
      await new Promise<void>((resolve) => {
        this.expiryWake = resolve;
        if (next !== null && next !== undefined) this.expiryTimer = setTimeout(resolve, Math.max(0, next - this.now()));
      });
      clearTimeout(this.expiryTimer);
      this.expiryWake = undefined;
    }
  }
}

/** The executor's methods the queue writes through; `sendWith` arrives with the executor's send. */
type ExecutorSend = {
  sendWith?(target: ThreadRef, message: string, clientRequestId: string, opts: SendOpts): Promise<Sent>;
};

/** The queue's writer over the hub's executor. */
export function executorWriter(hub: Hub): ThreadWriter {
  const ex = () => executors(hub);
  return {
    isConnected: (m) => ex().isConnected(m),
    awaitLive: (m, signal) => ex().awaitLive(m, signal),
    sendWith: async (target, message, clientRequestId, opts) => {
      const send = (ex() as unknown as ExecutorSend).sendWith;
      if (!send) throw new WriteError("NodeRequestFailed", `the node on ${target.machineId} refused or failed the send request: the hub's executor can't send yet`);
      try {
        return await send.call(ex(), target, message, clientRequestId, opts);
      } catch (error) {
        const e = error as { kind?: string; message?: string; extra?: { fix?: string } };
        if (e.kind === "not_connected") throw new WriteError("MachineNotConnected", e.message ?? "");
        if (e.kind === "thread_not_found") throw new WriteError("ThreadNotFound", e.message ?? "");
        throw new WriteError("NodeRequestFailed", e.message ?? String(error), e.extra?.fix);
      }
    },
  };
}

/** The hub's write queue: `writeQueue(hub).send(…)`. */
export const writeQueue = (hub: Hub) => hub.area("write_queue", (h) => new WriteQueue(h, executorWriter(h)));
