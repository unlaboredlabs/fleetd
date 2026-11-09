// The lease: boat's own auto-stop deadline on every machine, which the hub keeps
// pushing ahead while it wants the machine. If the hub stops renewing, boat stops the machine at the deadline by
// itself. Every ttl the hub sends is a Ttl, and `clamp` is the only way to make one: at most 30 minutes, and no longer
// than what is left under the budget at the pool's burn rate. A Ttl is a plain number of seconds above 60, so boat's
// `null` ("never stop") can't be sent.

/** The lease an awake machine gets at each renewal. */
export const LEASE_S = 30 * 60;
/** A create's: its setup script and first hello take about a minute, so the same as a renewal's. */
export const SETUP_S = 30 * 60;
/** At or under this, the machine is stopped rather than leased. */
export const STOP_AT_S = 60;

const made = Symbol("ttl");

/** Seconds until boat stops the machine: always a number, 61 to 1,800. Only `clamp` makes one. */
export type Ttl = { readonly seconds: number; readonly [made]: true };

export const ttlMs = (t: Ttl) => t.seconds * 1000;

export type Lease = { renew: Ttl } | { stop: true };

/**
 * The one clamping function: a lease of at most `longestS` (itself never above SETUP_S), cut to the time `budgetLeft`
 * dollars last at `burnPerHour`. Anything not a positive number of seconds above STOP_AT_S is a stop.
 */
export function clamp(longestS: number, budgetLeft: number, burnPerHour: number): Lease {
  const longest = Math.min(Math.max(0, longestS), SETUP_S);
  // An unknown burn (NaN) can't be leased against.
  const byBudget = Number.isNaN(burnPerHour) ? 0 : burnPerHour > 0 ? (budgetLeft / burnPerHour) * 3600 : budgetLeft > 0 ? longest : 0;
  // A NaN budget leases nothing.
  const seconds = byBudget < longest ? byBudget : byBudget >= longest ? longest : 0;
  return seconds > STOP_AT_S ? { renew: { seconds: Math.floor(seconds), [made]: true } } : { stop: true };
}
