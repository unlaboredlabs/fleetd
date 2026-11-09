// Warnings the train can hit on every pass (GitHub unreachable, a machine offline), crates/fleetd/src/hub/train/
// repeats.rs: each one logs the first time, then at most once an hour while the same error repeats, with how many it
// held back, so a long outage stays a few lines instead of burying the hub log.

export const REPEAT_EVERY_MS = 60 * 60 * 1000;

/** Past this many warnings tracked, the ones not logged in the last hour are forgotten. */
const KEPT = 4096;

type Repeat = { what: string; loggedMs: number; held: number };

export class Repeats {
  private readonly seen = new Map<string, Repeat>();

  /**
   * The warning at `key` (its line and what it is about) happened with `what` (its error): how many were held back
   * since its last line, to log it now; undefined to hold it back. Another `what` than the last logs at once.
   */
  due(key: string, what: string, nowMs: number): number | undefined {
    const r = this.seen.get(key);
    if (r && r.what === what) {
      if (nowMs - r.loggedMs < REPEAT_EVERY_MS) {
        r.held += 1;
        return undefined;
      }
      const held = r.held;
      r.loggedMs = nowMs;
      r.held = 0;
      return held;
    }
    if (this.seen.size >= KEPT) {
      for (const [k, v] of this.seen) if (nowMs - v.loggedMs >= REPEAT_EVERY_MS) this.seen.delete(k);
    }
    this.seen.set(key, { what, loggedMs: nowMs, held: 0 });
    return 0;
  }

  /** The trouble at `key` is over: whether it was there. */
  clear(key: string): boolean {
    return this.seen.delete(key);
  }
}

/**
 * `console.warn` through `repeats` (`warn_hourly!`): `line` once, then at most hourly while `what` stays the same for
 * this `key` (the line's own name and what it is about), with how many were held back.
 */
export function warnHourly(repeats: Repeats, nowMs: number, key: string[], what: string, line: string): void {
  const held = repeats.due(key.join(" "), what, nowMs);
  if (held === undefined) return;
  console.warn(held === 0 ? line : `${line} (${held} like it held back)`);
}
