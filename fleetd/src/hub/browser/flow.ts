// A live screen's frames to one viewer that acks each one, paced by its acks (W837): the rules of screen-relay's
// FlowControl without TCP statistics (vercel-labs/screen-relay, src/engine/core/flow.hpp), as fleetd's screens have
// them. The hub's socket (./app.ts) and the node's peers (src/node/rtc) both send through it.
//
// Each ack's time from the frame's send to its ack is its depth. The smallest over 10 s is the link's base; the
// smallest above that over one base round trip (at least two frame intervals) is the standing queue, so one late
// burst doesn't count, and a queue that lasts does. From those:
// - the window, the frames on their way at once: the base, in frames, plus two (one before any ack). The engine sizes it
//   from the largest depth, as a frame it can't send it doesn't capture; here a frame past the window waits for it;
// - the pause, while the standing queue reaches the base plus two frame intervals (250 ms before any ack), or a frame
//   has waited that long to be sent, or 8 MiB wait: frames that come meanwhile aren't taken, so nothing piles up. The
//   engine skips capture where this can't: a screen's encoder runs ahead of the viewer, so its frames wait here for
//   the window, and that wait is the sender's, timed apart from the network's;
// - the budget: a quarter off (at most each 500 ms) while the queue, the network's and the frames waiting for the
//   window together, is past half the pause, and a tenth on each second
//   while it's under a quarter, between MIN_KBPS and START_KBPS. At START_KBPS it is no budget: the link keeps up.
// A screen's frames can't all be dropped alike: an H.264 frame not taken loses the ones made from it, so the sender
// then waits for a keyframe or a JPEG and asks the screen for one, at most each KEY_EVERY.

import type { LinkPerf } from "../../shared/contracts.ts";

/** Times are ms. */
const BASE_WINDOW = 10_000;
const PAUSE_AGE = 250;
export const TIMEOUT = 3_000;
const MAX_BYTES = 8 << 20;
export const MIN_KBPS = 500;
/** The budget a link starts at, and the most it is ever told: at or above, the link keeps up (no budget). */
export const START_KBPS = 8_000;
const CUT_EVERY = 500;
const RAISE_EVERY = 1_000;
/** A keyframe asked again this soon after the last goes unasked: one is on its way. */
export const KEY_EVERY = 1_000;

/** The smallest (or largest) of timed values over a span, read over any shorter trailing window. */
class Extreme {
  private samples: [number, number][] = [];
  private forgotten = Number.NEGATIVE_INFINITY;
  constructor(private readonly smallest = true) {}
  push(now: number, value: number): void {
    while (this.samples.length > 0 && now - this.samples[0]![0] >= BASE_WINDOW) this.samples.shift();
    while (this.samples.length > 0 && (this.smallest ? this.samples.at(-1)![1] >= value : this.samples.at(-1)![1] <= value)) this.samples.pop();
    this.samples.push([now, value]);
  }
  empty(): boolean {
    return this.samples.length === 0;
  }
  overall(none: number): number {
    return this.samples[0]?.[1] ?? none;
  }
  /** Later reads over a window ignore anything older than `window` before `now`. */
  forget(now: number, window: number): void {
    this.forgotten = Math.max(this.forgotten, now - window);
  }
  over(now: number, window: number, none: number, floor = Number.NEGATIVE_INFINITY): number {
    for (const [at, v] of this.samples) if (at > Math.max(this.forgotten, floor) && now - at < window) return v;
    return none;
  }
  get forgottenAt(): number {
    return this.forgotten;
  }
}

type Admitted = { seq: number; bytes: number; at: number; sentAt: number | undefined };

/** The acks' measures and the decisions made from them (flow.hpp `FlowControl`, without TCP statistics). */
export class AckFlow {
  private readonly depth = new Extreme();
  private readonly network = new Extreme();
  private readonly held = new Extreme(false);
  private readonly waiting = new Extreme();
  readonly frames: Admitted[] = [];
  private bytes = 0;
  private largest = 0;
  private acked = 0;
  private firstAckAt: number | undefined;
  private progressAt = 0;
  /** The budget in kbit/s. */
  target = START_KBPS;
  window = 1;
  private sampleStart = 0;
  private sampleBytes = 0;
  private sampleAcks = 0;
  private previousSent = 0;
  private cutAt = Number.NEGATIVE_INFINITY;
  private raisedAt = Number.NEGATIVE_INFINITY;
  private goodput = 0;
  readonly interval: number;

  constructor(fps = 30) {
    this.interval = 1000 / Math.max(fps, 1);
  }

  private viewerWait(): number {
    return Math.min(100, this.held.overall(0));
  }
  private networkBase(): number {
    return this.network.overall(0);
  }
  private base(): number {
    return this.networkBase() + this.viewerWait();
  }
  private standingWindow(): number {
    return Math.max(this.base(), 2 * this.interval);
  }
  private pauseQueue(): number {
    return this.depth.empty() ? PAUSE_AGE : this.base() + 2 * this.interval;
  }
  /** How long the oldest frame on its way has been. */
  private oldestAge(now: number): number {
    const f = this.frames.find((x) => x.sentAt !== undefined);
    return f === undefined ? 0 : now - f.sentAt!;
  }
  /** How long the oldest frame not yet sent has waited for the window: from the first ack on, as before it the window
   * is one frame whatever the link. */
  private unsentAge(now: number): number {
    const f = this.frames.find((x) => x.sentAt === undefined);
    return f === undefined || this.firstAckAt === undefined ? 0 : now - Math.max(f.at, this.firstAckAt);
  }
  private standingAbove(now: number, acked: Extreme, base: number): number {
    if (this.inFlight() === 0) return 0;
    const window = this.standingWindow();
    const lowest = Math.min(this.oldestAge(now), acked.over(now, window, Infinity), this.waiting.over(now, window, Infinity, acked.forgottenAt));
    return lowest > base ? lowest - base : 0;
  }
  /** 0 clear, 1 building, 2 congested, 3 paused. */
  private level(queue: number): number {
    const limit = this.pauseQueue();
    if (queue >= limit) return 3;
    if (queue >= limit / 2) return 2;
    return queue >= limit / 4 ? 1 : 0;
  }
  private frameLimit(): number {
    return Math.max(2, Math.ceil((TIMEOUT / 1000) * (1000 / this.interval)));
  }

  /** Whether a frame that comes now isn't taken: a queue stands, or too much waits. */
  paused(now: number): boolean {
    return (
      this.bytes + this.largest > MAX_BYTES ||
      this.frames.length >= this.frameLimit() ||
      this.unsentAge(now) >= this.pauseQueue() ||
      this.level(this.standingAbove(now, this.depth, this.base())) === 3
    );
  }

  /** Frames sent and not acked. */
  inFlight(): number {
    return this.frames.filter((f) => f.sentAt !== undefined).length;
  }

  /** No progress for TIMEOUT while frames are out: the viewer's link has stalled. */
  timedOut(now: number): boolean {
    return this.inFlight() > 0 && (now - this.progressAt >= TIMEOUT || this.oldestAge(now) >= TIMEOUT);
  }

  admit(seq: number, bytes: number, now: number): void {
    if (this.inFlight() === 0) this.progressAt = now;
    this.frames.push({ seq, bytes, at: now, sentAt: undefined });
    this.bytes += bytes;
    this.largest = Math.max(this.largest, bytes);
  }

  /** An admitted frame let go unsent (a newer whole picture made it needless). */
  unadmit(seq: number): void {
    const at = this.frames.findIndex((f) => f.seq === seq && f.sentAt === undefined);
    if (at < 0) return;
    this.bytes -= this.frames[at]!.bytes;
    this.frames.splice(at, 1);
  }

  sent(seq: number, now: number): void {
    const f = this.frames.find((x) => x.seq === seq && x.sentAt === undefined);
    if (f) f.sentAt = now;
  }

  /** The viewer has `seq` (and so every frame sent before it); `wait`: how long it held it before it showed. */
  ack(seq: number, now: number, wait = 0): void {
    const at = this.frames.findIndex((f) => f.seq === seq && f.sentAt !== undefined);
    if (at < 0) return;
    for (const f of this.frames.splice(0, at + 1)) {
      const total = now - f.sentAt!;
      const w = wait <= total ? wait : 0;
      this.network.forget(now, this.standingWindow());
      this.depth.push(now, total);
      this.held.push(now, w);
      this.network.push(now, total - w);
      this.depth.forget(now, this.standingWindow());
      const sentAt = f.sentAt!;
      if (this.previousSent && sentAt - this.previousSent > 3 * this.interval) this.sampleStart = this.sampleBytes = this.sampleAcks = 0;
      if (!this.sampleStart) this.sampleStart = sentAt;
      this.previousSent = sentAt;
      this.sampleBytes += f.bytes;
      this.sampleAcks++;
      this.bytes -= f.bytes;
      this.acked++;
    }
    this.progressAt = now;
    this.firstAckAt ??= now;
    this.update(now);
  }

  /** Called as time passes with frames out (each frame that comes, each ack): the queue's age counts while no ack does. */
  update(now: number): void {
    this.window = this.acked ? Math.min(Math.max(Math.ceil(this.base() / this.interval) + 2, 2), this.frameLimit()) : 1;
    if (this.inFlight() > 0) {
      this.waiting.push(now, this.oldestAge(now));
      this.depth.forget(now, this.standingWindow());
      this.network.forget(now, this.standingWindow());
    }
    const busy = this.sampleStart > 0 && this.sampleAcks >= 8 && this.sampleBytes >= 65_536;
    const span = this.sampleStart ? now - this.sampleStart : 0;
    if (busy && span >= 500) this.goodput = (this.sampleBytes * 8) / span;
    const state = this.level(this.standingAbove(now, this.network, this.networkBase()) + this.unsentAge(now));
    if (this.frames.length >= 2 && this.bytes >= Math.min((this.target * 1000) / 8 / 80, 65_536) && state >= 2 && now - this.cutAt >= CUT_EVERY) {
      let next = (this.target * 3) / 4;
      if (busy && span >= 500) next = Math.min(next, this.goodput * 0.9);
      this.target = Math.max(MIN_KBPS, Math.round(next));
      this.cutAt = this.raisedAt = now;
    } else if (busy && span >= 1_000 && state === 0 && now - this.raisedAt >= RAISE_EVERY && now - this.cutAt >= 2_000) {
      this.target = Math.min(START_KBPS, Math.round(this.target * 1.1));
      this.raisedAt = now;
    }
    if (span >= 1_000) {
      this.sampleStart = now;
      this.sampleBytes = this.sampleAcks = 0;
    }
  }

  /** The budget to tell the screen: undefined while the link keeps up. */
  kbps(): number | undefined {
    return this.target >= START_KBPS ? undefined : this.target;
  }

  /** The link as the panel shows it (contracts' LinkPerf), from what the acks measured: nothing before the first. */
  stats(now: number): Omit<LinkPerf, "skipped"> | undefined {
    if (this.acked === 0) return undefined;
    const kbps = this.kbps();
    return {
      rttMs: Math.round(this.networkBase()),
      queueMs: Math.round(this.standingAbove(now, this.network, this.networkBase())),
      ...(this.goodput > 0 ? { kbps: Math.round(this.goodput) } : {}),
      ...(kbps === undefined ? {} : { budgetKbps: kbps }),
    };
  }

  /** The viewer stalled: start again, as with a new viewer. */
  reset(): void {
    this.frames.length = 0;
    this.bytes = this.largest = 0;
  }
}

/** A frame as a sender has it: what goes, its seq and size, and whether it is H.264 and a keyframe. */
export type Outgoing<T> = { seq: number; bytes: number; h264: boolean; key: boolean; data: T };

/**
 * One viewer's frames through an AckFlow: a whole picture (a JPEG or a keyframe) replaces any that waits unsent; an
 * H.264 frame waits in order behind those before it; and one that comes while the flow is paused isn't taken, so
 * the sender waits for the next whole picture, which it asks the screen for.
 */
export class FrameSender<T> {
  readonly flow: AckFlow;
  private readonly queue: Outgoing<T>[] = [];
  /** H.264 deltas aren't taken until a whole picture comes. */
  needKey: boolean;
  private keyedAt = Number.NEGATIVE_INFINITY;
  private told: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The viewer draws at most `fps`: frames go no closer together than this, the newest whole picture at the gap. */
  private readonly gap: number | undefined;
  private lastSent = Number.NEGATIVE_INFINITY;
  /** Frames offered and not taken since `stats` last read them. */
  private skipped = 0;
  private deferred: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly out: {
      send(frame: Outgoing<T>): void;
      /** Ask the screen for a whole picture. */
      key(): void;
      /** The budget changed (undefined: the link keeps up). */
      budget(kbps: number | undefined): void;
      /** Whether the transport itself has room (a data channel's backlog); absent: it has. */
      room?(): boolean;
    },
    fps?: number,
    needKey = false,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.flow = new AckFlow(fps);
    this.gap = fps === undefined ? undefined : 1000 / Math.max(fps, 1);
    this.needKey = needKey;
  }

  offer(frame: Outgoing<T>): void {
    const now = this.now();
    if (this.flow.timedOut(now)) {
      // A viewer that stopped acking: what is out is written off, and the stream starts again at a whole picture.
      this.flow.reset();
      this.queue.length = 0;
      this.needKey = true;
    }
    this.flow.update(now);
    if (frame.h264 && !frame.key && this.needKey) {
      this.skipped++;
      return this.askKey(now);
    }
    if (!frame.h264 || frame.key) {
      // Deltas after a JPEG that replaced some unsent are made from those: they wait for a keyframe.
      const lost = !frame.key && this.queue.some((q) => q.h264);
      // Skipped only where the link held it: one that waits out the viewer's own frame gap is a frame it never asked for.
      const held = this.deferred === undefined;
      for (const q of this.queue.splice(0)) {
        this.flow.unadmit(q.seq);
        if (held) this.skipped++;
      }
      this.needKey = lost;
      if (lost) this.askKey(now);
      if (this.flow.paused(now) && this.flow.frames.length > 0) {
        // A whole picture that can't go now waits alone, replaced by any newer.
        this.queue.push(frame);
        this.flow.admit(frame.seq, frame.bytes, now);
        return this.pump();
      }
    } else if (this.flow.paused(now)) {
      for (const q of this.queue.splice(0)) {
        this.flow.unadmit(q.seq);
        this.skipped++;
      }
      this.skipped++;
      this.needKey = true;
      return this.askKey(now);
    }
    this.queue.push(frame);
    this.flow.admit(frame.seq, frame.bytes, now);
    this.pump();
  }

  private askKey(now: number): void {
    if (now - this.keyedAt < KEY_EVERY) return;
    this.keyedAt = now;
    this.out.key();
  }

  /** Sends what the window has room for. */
  pump(): void {
    const now = this.now();
    while (this.queue.length > 0 && this.flow.inFlight() < this.flow.window && (this.out.room?.() ?? true)) {
      if (this.gap !== undefined && now < this.lastSent + this.gap) {
        this.deferred ??= setTimeout(() => {
          this.deferred = undefined;
          this.pump();
        }, this.lastSent + this.gap - now);
        break;
      }
      const f = this.queue.shift()!;
      this.lastSent = now;
      this.flow.sent(f.seq, now);
      this.out.send(f);
    }
    // A stall is seen while no ack comes: look again then.
    clearTimeout(this.timer);
    this.timer = this.flow.frames.length > 0 ? setTimeout(() => this.tick(), TIMEOUT) : undefined;
  }

  private tick(): void {
    const now = this.now();
    if (!this.flow.timedOut(now)) return this.pump();
    this.flow.reset();
    this.queue.length = 0;
    this.needKey = true;
    this.askKey(now);
  }

  ack(seq: number, wait = 0): void {
    this.flow.ack(seq, this.now(), wait);
    const kbps = this.flow.kbps();
    if (kbps !== this.told) {
      this.told = kbps;
      this.out.budget(kbps);
    }
    this.pump();
  }

  /** The link's measures, and the frames skipped since the last read (contracts' LinkPerf); nothing before the first
   * ack, the skips kept for the first read that has one. */
  stats(): LinkPerf | undefined {
    const flow = this.flow.stats(this.now());
    if (flow === undefined) return undefined;
    const out = { ...flow, skipped: this.skipped };
    this.skipped = 0;
    return out;
  }

  end(): void {
    clearTimeout(this.timer);
    clearTimeout(this.deferred);
    this.queue.length = 0;
  }
}
