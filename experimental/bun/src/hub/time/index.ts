// The agent time inspector's hub area (crates/fleetd/src/hub/time/mod.rs): spans from the nodes (their outboxes, acked
// after commit) and from the hub's own choke points through one sink, plus spans the projector folds out of the event
// log. One writer commits them in batches with their labels, roll-ups and cursors; reads give breakdowns, critical
// paths and insights. The writer runs once the event loop is free, never inside the call that sent a span.
import type { Hub } from "../api/hub.ts";
import { parseMs } from "../store/time.ts";
import { type Ack, closePrefix, gap, ingestFrame, type SpansFrame, writeHub } from "./ingest.ts";
import { LIVE_CI_MS } from "./reads.ts";
import { cursor, type NewSpan, prune, write } from "./store.ts";
import { saveUpkeep, upkeep, type UpkeepJob } from "./upkeep.ts";

/** Node batches waiting for the writer; past this a batch is not acked and the node resends it on reconnect. */
export const NODE_BATCHES = 64;
/** Hub spans waiting for the writer; past this they are counted into one `gap` span. */
export const HUB_SPANS = 10_000;
/** Hub spans committed per transaction. */
const HUB_BATCH = 500;
/** Clock offsets are the minimum over this window of heartbeats. */
const OFFSET_WINDOW_MS = 10 * 60 * 1000;
const PRUNE_EVERY_MS = 3_600_000;
/** How often the upkeep looks for hours to build, when none were left over. */
const UPKEEP_EVERY_MS = 10_000;
/** How often the stored bytes are measured again. */
const BYTES_EVERY_MS = 600_000;

/** What the hub's areas send the writer: a span, or "close every open hub span under `prefix` at `endMs`". */
export type HubMsg = { span: NewSpan } | { close: string; endMs: number };

export type NodeBatch = { machineId: string; frame: SpansFrame; ack: (ack: Ack) => void };

/** Where the hub's areas write spans (`time(hub).sink`). A full writer drops the span and counts it. */
export type TimeSink = { span(span: NewSpan): void; close(prefix: string, endMs: number): void };

export class Time {
  private readonly hubQueue: HubMsg[] = [];
  private readonly nodeQueue: NodeBatch[] = [];
  private dropped = 0;
  nodeDropped = 0;
  private scheduled = false;
  /** Per machine: (hub ms, hub receive time minus the node's heartbeat stamp), newest last. */
  private readonly offsets = new Map<string, [number, number][]>();
  readonly sink: TimeSink;

  constructor(private readonly hub: Hub) {
    this.sink = {
      span: (span) => this.send({ span: { ...span, src: "h" } }),
      close: (prefix, endMs) => this.send({ close: prefix, endMs }),
    };
  }

  nowMs(): number {
    return this.hub.clock.now();
  }

  private send(msg: HubMsg): void {
    if (this.hub.shutdown.signal.aborted) return;
    if (this.hubQueue.length >= HUB_SPANS) {
      this.dropped += 1;
      return;
    }
    this.hubQueue.push(msg);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.flush();
    }, 0);
  }

  /** Commits what waits: each node batch in its own transaction, acked after it; hub spans in batches. */
  flush(): void {
    while (this.nodeQueue.length > 0) {
      const batch = this.nodeQueue.shift() as NodeBatch;
      const offset = this.offset(batch.machineId);
      let ack: Ack;
      try {
        ack = this.hub.db.transaction((c) => ingestFrame(c, batch.machineId, offset, batch.frame));
      } catch (error) {
        console.error(`time: node spans of ${batch.machineId} not stored:`, error);
        ack = { upto: this.nodeCursor(batch.machineId), rewind: true };
      }
      batch.ack(ack);
    }
    while (this.hubQueue.length > 0) {
      const spans = this.hubQueue.splice(0, HUB_BATCH);
      const dropped = this.dropped;
      this.dropped = 0;
      const now = this.nowMs();
      try {
        this.hub.db.transaction((c) => {
          for (const m of spans) {
            if ("span" in m) writeHub(c, m.span);
            else closePrefix(c, m.close, m.endMs);
          }
          if (dropped > 0) write(c, gap(now, dropped));
        });
      } catch (error) {
        console.error("time: hub spans not stored:", error);
      }
    }
  }

  /** A heartbeat from `machine` stamped `nodeAt` (its clock) arrived now. */
  heartbeat(machine: string, nodeAt: string): void {
    const nodeMs = parseMs(nodeAt);
    if (nodeMs === undefined) return;
    const now = this.nowMs();
    const q = this.offsets.get(machine) ?? [];
    q.push([now, now - nodeMs]);
    while (q.length > 0 && (q[0] as [number, number])[0] < now - OFFSET_WINDOW_MS) q.shift();
    this.offsets.set(machine, q);
  }

  /** Add this to a node stamp to get hub time: the minimum of `hub_rx - heartbeat.at` over the window; 0 before one. */
  offset(machine: string): number {
    const q = this.offsets.get(machine);
    return q && q.length > 0 ? Math.min(...q.map(([, d]) => d)) : 0;
  }

  /** A node's `spans` frame; acked after commit. When the writer is full the node is told to send again. */
  nodeSpans(batch: NodeBatch): void {
    if (this.nodeQueue.length >= NODE_BATCHES) {
      this.nodeDropped += 1;
      batch.ack({ upto: this.nodeCursor(batch.machineId), rewind: true });
      return;
    }
    this.nodeQueue.push(batch);
    this.schedule();
  }

  /** The outbox row the hub has stored up to for `machine`: `spansAfter` on every (re)subscribe. */
  nodeCursor(machine: string): number {
    try {
      return Math.max(cursor(this.hub.db.conn, `node:${machine}`) ?? 0, 0);
    } catch {
      return 0;
    }
  }

  /** The hourly prune, until the hub stops. */
  startPrune(): void {
    const stop = this.hub.shutdown.signal;
    const timer = setInterval(async () => {
      const now = this.nowMs();
      try {
        // One batch per transaction, the hub serving between them, as the Rust hub yields between them.
        while (!stop.aborted && this.hub.db.transaction((c) => prune(c, now))) await Bun.sleep(0);
      } catch (error) {
        console.warn("time: prune failed:", error);
      }
    }, PRUNE_EVERY_MS);
    stop.addEventListener("abort", () => clearInterval(timer), { once: true });
  }
}

/**
 * The digests' upkeep (upkeep.ts) until the hub stops: at start, then every UPKEEP_EVERY_MS, straight away again
 * while history is left to build. Running orders' segments are worked out twice per LIVE_CI_MS, so a read finds them.
 */
export function startUpkeep(hub: Hub): void {
  const t = time(hub);
  const stop = hub.shutdown.signal;
  let ciAt = Number.NEGATIVE_INFINITY;
  let bytesAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    let more = false;
    try {
      const now = t.nowMs();
      const job: UpkeepJob = { now, ci: now - ciAt >= LIVE_CI_MS / 2, bytes: now - bytesAt >= BYTES_EVERY_MS };
      const readers = hub.db.readers();
      const got = readers ? await readers.upkeep(job) : upkeep(hub.db.conn, job);
      if (stop.aborted) return;
      hub.db.transaction((c) => saveUpkeep(c, got, t.nowMs()));
      if (job.ci) ciAt = now;
      if (job.bytes) bytesAt = now;
      more = got.more;
    } catch (error) {
      if (stop.aborted) return;
      console.warn("time: upkeep failed:", error);
    }
    timer = setTimeout(tick, more ? 0 : UPKEEP_EVERY_MS);
  };
  timer = setTimeout(tick, 0);
  stop.addEventListener("abort", () => clearTimeout(timer), { once: true });
}

export const time = (hub: Hub) => hub.area("time", (h) => new Time(h));
