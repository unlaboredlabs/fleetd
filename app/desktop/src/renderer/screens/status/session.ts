// What the Status view shows, decided from the data layer's state (src/renderer/src/data): the doc comes from a
// `status_get` query that events invalidate, and the layer drops every answer when the link drops or a new snapshot
// arrives. So it cannot be stale: no answer on this connection yet is the skeleton, never a kept number shown as
// live. Staleness of hub data is the hub's call (each part's as-of and reason come in the doc).

import type { StatusDoc } from "./contracts";

export type Phase = "skeleton" | "live" | "notLive";

export interface StatusRead {
  /** The doc this connection's status_get answered with; undefined until it has. */
  readonly doc: StatusDoc | undefined;
  /** Local clock when `doc` arrived, to carry its hub `now` forward. */
  readonly receivedMs: number;
  /** The link is up and the store has this connection's snapshot. */
  readonly fresh: boolean;
  /** The last read failed (its doc, if any, is the previous answer). */
  readonly error: string | null;
}

/** A doc from this connection whose last read succeeded is live; a doc whose refresh failed is shown, not live. */
export const phase = (r: StatusRead): Phase => (r.doc === undefined ? "skeleton" : r.fresh && r.error === null ? "live" : "notLive");

/** The hub's clock now: the doc's `now` carried forward by the local time since it arrived. */
export const hubNow = (r: StatusRead, localNowMs: number): number => {
  const at = r.doc ? Date.parse(r.doc.now) : Number.NaN;
  return Number.isNaN(at) ? localNowMs : at + Math.max(0, localNowMs - r.receivedMs);
};

/** Time on screen with the window focused, for since-you-last-looked: a look counts after LOOK_MS in total. */
export const LOOK_MS = 3000;

export class Looked {
  #since: number | null = null;
  #total = 0;

  set(visible: boolean, nowMs: number): void {
    if (visible && this.#since === null) this.#since = nowMs;
    if (!visible && this.#since !== null) {
      this.#total += nowMs - this.#since;
      this.#since = null;
    }
  }

  /** Ends the look: whether it was long enough to count. */
  take(nowMs: number): boolean {
    this.set(false, nowMs);
    const long = this.#total >= LOOK_MS;
    this.#total = 0;
    return long;
  }
}
