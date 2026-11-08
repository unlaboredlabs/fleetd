// A live screen's pacing for one app connection that acks its frames (crates/fleetd/src/hub/app_ws/pace.rs): frames go
// only as fast as the link delivers them, at most two round trips' worth in flight, so a slow phone sees the newest
// frame late by one frame's time rather than by a queue. The acks measure what the link carries; while frames wait
// for room, that is the watch's limit, raised half again every PROBE_EVERY once they stop waiting. Times are ms.

const ROUND_TRIPS = 2;
const RATE_WINDOW = 10_000;
const FULL_FOR = 2_000;
export const PROBE_EVERY = 10_000;
const PROBE_GAIN = 1.5;
const CEILING_KBPS = 50_000;
const STALL = 15_000;
const PING_EVERY = 1_000;
/** The payload of the pings that time a round trip. */
export const PING = "pace";

type Sent = { seq: number; at: number; bytes: number; delivered: number; busySince: number; fromAck: boolean };

function trim<T>(samples: [number, T][], now: number): void {
  while (samples.length > 1 && now - samples[0]![0] > RATE_WINDOW) samples.shift();
}

export class Pace {
  private inFlight: Sent[] = [];
  private delivered = 0;
  private rates: [number, number][] = [];
  private rtts: [number, number][] = [];
  private pingAt: number | undefined;
  private pinged: number | undefined;
  private waitedAt: number | undefined;
  private ackedAt: number | undefined;
  /** bytes/ms and since when. */
  limit: [number, number] | undefined;
  private readonly gap: number | undefined;
  private last: number | undefined;

  constructor(fps?: number) {
    this.gap = fps === undefined ? undefined : 1000 / Math.max(fps, 1);
  }

  /** The client's frame rate: the next frame waits until then. */
  notBefore(now: number): number | undefined {
    if (this.last === undefined || this.gap === undefined) return undefined;
    const next = this.last + this.gap;
    return next > now ? next : undefined;
  }

  private rate(): number {
    return this.rates.reduce((m, [, r]) => Math.max(m, r), 0);
  }

  private rtt(): number | undefined {
    return this.rtts.length === 0 ? undefined : Math.min(...this.rtts.map(([, r]) => r));
  }

  /** Room for a frame now; else when there will be (undefined: at the next ack). */
  room(now: number): { ok: true } | { ok: false; at: number | undefined } {
    if (this.inFlight[0] && now - this.inFlight[0].at > STALL) this.inFlight = [];
    const oldest = this.inFlight[0];
    if (!oldest) return { ok: true };
    const rate = this.rate();
    const rtt = rate > 0 ? this.rtt() : undefined;
    if (rtt === undefined) return this.inFlight.length < 2 ? { ok: true } : { ok: false, at: undefined };
    const [busySince] = this.busySince() ?? [oldest.at, false];
    const inFlight = this.inFlight.reduce((n, s) => n + s.bytes, 0);
    const work = inFlight / rate;
    const at = busySince + Math.max(work - rtt * ROUND_TRIPS, 0);
    return at <= now ? { ok: true } : { ok: false, at };
  }

  /** A frame waited for room: the link is full. */
  waited(now: number): void {
    if (this.rtt() !== undefined && this.rate() > 0) this.waitedAt = now;
  }

  /** Whether to send a ping before this frame: nothing in flight, none out, and a second since the last. */
  ping(now: number): boolean {
    const due =
      this.inFlight.length === 0 && this.pingAt === undefined && (this.pinged === undefined || now - this.pinged >= PING_EVERY);
    if (due) {
      this.pingAt = now;
      this.pinged = now;
    }
    return due;
  }

  pong(now: number): void {
    if (this.pingAt === undefined) return;
    this.rtts.push([now, now - this.pingAt]);
    this.pingAt = undefined;
    trim(this.rtts, now);
  }

  sent(seq: number, bytes: number, now: number): void {
    this.last = now;
    const [busySince, fromAck] = this.busySince() ?? [now, false];
    this.inFlight.push({ seq, at: now, bytes, delivered: this.delivered, busySince, fromAck });
  }

  private busySince(): [number, boolean] | undefined {
    const oldest = this.inFlight[0]?.at;
    if (oldest === undefined) return undefined;
    return this.ackedAt !== undefined && this.ackedAt > oldest ? [this.ackedAt, true] : [oldest, false];
  }

  acked(seq: number, now: number): void {
    const at = this.inFlight.findIndex((s) => s.seq === seq);
    if (at < 0) return;
    const rtt = this.rtt() ?? 0;
    this.ackedAt = now;
    for (const sent of this.inFlight.splice(0, at + 1)) {
      this.delivered += sent.bytes;
      const took = now - sent.busySince;
      const moving = sent.fromAck ? took : Math.max(Math.max(took - rtt, 0), took / 4);
      this.rates.push([now, (this.delivered - sent.delivered) / Math.max(moving, 1)]);
    }
    trim(this.rates, now);
    const rate = this.rate();
    const full = this.waitedAt !== undefined && now - this.waitedAt < FULL_FOR;
    if (full) {
      this.limit = rate * 8 < CEILING_KBPS ? [rate, now] : undefined;
    } else if (this.limit && now - this.limit[1] >= PROBE_EVERY) {
      const raised = this.limit[0] * PROBE_GAIN;
      this.limit = raised * 8 < CEILING_KBPS ? [raised, now] : undefined;
    }
  }

  /** What the link carries in kbit/s, while frames had to wait for it; undefined while it keeps up. */
  kbps(): number | undefined {
    return this.limit === undefined ? undefined : Math.max(Math.round(this.limit[0] * 8), 1);
  }
}
