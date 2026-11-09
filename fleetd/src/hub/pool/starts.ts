// Starts: every create and resume is a boat start, which boat limits per
// rolling minute, hour and day. fleetd allows itself half of each included window, counts a start before its call,
// pre-flights `/limits` before each one and never buys an extra start. What boat refuses sets a backoff, by its code,
// with one plain line that says why.
import { type BoatError, boatLine, type Limits, type StartLimits } from "./boat.ts";
import { type Settings, type Window, windowMs } from "./ledger.ts";

/** boat's $20 plan, until /limits was read. */
export const INCLUDED_UNKNOWN: StartLimits = { perMinute: 12, perHour: 60, perDay: 200 };

/** What fleetd allows itself in a window: half of what the plan includes there, at least one. */
export function allowed(included: StartLimits, window: Window): number {
  const n = window === "minute" ? included.perMinute : window === "hour" ? included.perHour : included.perDay;
  return Math.max(1, Math.floor(n / 2));
}

/** `HH:MM` in the hub's zone. */
export function clock(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(new Date(ms));
  }
}

/** Why the start budget holds a start back: the first full window's line, with when its oldest start leaves it. */
export function budgetLine(included: StartLimits, counts: [Window, number, number | undefined][], zone: string): string | undefined {
  for (const [window, used, oldest] of counts) {
    const n = allowed(included, window);
    if (used < n) continue;
    const head = `fleetd's boat.dev start budget is used (${used} of ${n} this ${window})`;
    return oldest !== undefined ? `${head}: next start at ${clock(oldest + windowMs(window), zone)}` : head;
  }
  return undefined;
}

/** Why the pre-flight refuses a start, or undefined to go ahead: boat must say it can start, and at no cost. */
export function preflight(limits: Limits): string | undefined {
  if (!limits.canStart) return `boat.dev: ${limits.startBlockedReason ?? "it can't start machines now"}`;
  if (limits.nextStartDollars === 0) return undefined;
  if (typeof limits.nextStartDollars === "number") return "boat.dev's included starts are used: fleetd never buys an extra start";
  return "boat.dev would refuse the next start";
}

/** What a refusal does to starts. */
export type Backoff =
  | { hold: true; until: number; step: number; reason: string }
  | { full: true }
  | { pause: "billing" | "key" | "refused"; reason: string };

/** The 5 s retries after `no_ready_machine` (3 of them), then 1, 2 and 4 minutes. */
const NO_READY_S = [5, 5, 5, 60, 120, 240];

/** The backoff for `error`, at the hold's current retry `step`; `jitter` in 0..1 spreads an unreachable boat's retries. */
export function backoff(error: BoatError, step: number, now: number, jitter: number, zone: string): Backoff {
  const next = step + 1;
  const hold = (secs: number, reason: string): Backoff => ({ hold: true, until: now + Math.max(1, secs) * 1000, step: next, reason });
  switch (error.kind) {
    case "rate_limited": {
      const until = Math.max(error.nextStartAt ?? (error.retryAfterS !== undefined ? now + error.retryAfterS * 1000 : now + 60_000), now + 1000);
      return { hold: true, until, step: next, reason: `boat.dev start limit: next start at ${clock(until, zone)}` };
    }
    case "limit_reached":
    case "member_limit_reached":
      return { full: true };
    case "billing":
      return {
        pause: "billing",
        reason: error.url !== undefined ? `boat.dev needs billing attention: Settings › Hub › Machines (${error.url})` : "boat.dev needs billing attention: Settings › Hub › Machines",
      };
    case "key_refused":
    case "no_key":
      return { pause: "key", reason: "boat.dev key refused: Settings › Hub › Machines" };
    case "no_ready_machine":
      return hold(NO_READY_S[Math.min(step, NO_READY_S.length - 1)]!, "boat.dev is short of machines, retrying");
    case "out_of_capacity":
      return hold(error.retryAfterS ?? 120, "boat.dev is short of machines, retrying");
    case "ip_rate_limited":
      return hold(error.retryAfterS ?? 60, "boat.dev rate limit, retrying");
    case "server":
    case "network":
    case "idempotency_in_progress": {
      const base = Math.min(5 * 2 ** Math.min(step, 6), 300);
      return hold(Math.round(base * (0.8 + 0.4 * Math.min(1, Math.max(0, jitter)))), "boat.dev unreachable, retrying");
    }
    default:
      // A refusal boat gives again to the same ask: nothing starts until a person fixes it and resumes.
      return { pause: "refused", reason: `${boatLine(error)}: fix that, then Resume in Settings › Hub › Machines › Cloud machines` };
  }
}

/** Why no start may go now, before the start budget and the money budget: the first that holds. */
export function held(s: Settings, now: number): string | undefined {
  if (!s.enabled) return "cloud machines are off";
  if (!s.hasKey) return "no boat.dev key: Settings › Hub › Machines";
  if (s.paused) return s.paused[1];
  if (s.holdUntil !== undefined && s.holdUntil > now) return s.holdReason ?? "boat.dev backoff";
  if (s.full) return "boat.dev: machines-at-once limit reached";
  return undefined;
}
