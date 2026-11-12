// GitHub's API budget as the hub's own answers show it (`x-ratelimit-*`), per account and resource (`core`, `graphql`).
// A limit GitHub says is used up is waited out until the reset it names: no call on that budget is made before then,
// and nothing that needed one is refused or failed for it. Under a tenth left, the hub warns once and polls GitHub
// `SPREAD` times less often until the reset.

/** The longest a used-up limit is waited out: GitHub's primary limit resets within the hour. */
export const LIMIT_WAIT_MAX_MS = 60 * 60_000;
/** A refusal that names no reset is waited out this long: GitHub's advice for its secondary limit. */
export const LIMIT_WAIT_DEFAULT_MS = 60_000;
/** How many times less often the hub polls GitHub while a budget is under a tenth. */
export const SPREAD = 4;

/** GitHub refused for its rate limit: a 429, or a 403 saying so (the primary "API rate limit exceeded …" and the secondary limit alike). */
export function rateLimited(status: number, message: string): boolean {
  return status === 429 || (status === 403 && message.toLowerCase().includes("rate limit"));
}

/** When the rate limit that refused `error` (a `GhError`'s `resetMs`) resets; undefined for any other error. */
export function limitReset(error: unknown): number | undefined {
  const reset = (error as { resetMs?: unknown } | null | undefined)?.resetMs;
  return typeof reset === "number" ? reset : undefined;
}

/** The start of what the hub says while a limit is used up. */
export const LIMIT_USED_UP = "GitHub's API rate limit is used up until";
/** The state line of a Change that waits on a used-up limit. */
export const WAITING_FOR_LIMIT = "waiting for GitHub's API rate limit to reset";

const isoS = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
export const limitText = (untilMs: number) => `${LIMIT_USED_UP} ${isoS(untilMs)}`;
export const limitNote = (untilMs: number) => `${WAITING_FOR_LIMIT} at ${isoS(untilMs)}; the train goes on then`;

type Account = { limit?: number; remaining?: number; resetMs?: number; usedUpUntil?: number; warned?: number };

const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

export class Budget {
  private readonly accounts = new Map<string, Account>();

  constructor(private readonly now: () => number) {}

  private account(owner: string, resource: string): Account {
    const key = `${owner.toLowerCase()}\u0000${resource}`;
    let a = this.accounts.get(key);
    if (!a) {
      a = {};
      this.accounts.set(key, a);
    }
    return a;
  }

  /** An answer's headers (lowercased names): what is left, and the one warning once under a tenth. */
  seen(owner: string, resource: string, headers: Map<string, string>): void {
    const limit = num(headers.get("x-ratelimit-limit"));
    const remaining = num(headers.get("x-ratelimit-remaining"));
    const reset = num(headers.get("x-ratelimit-reset"));
    if (limit === undefined || remaining === undefined || reset === undefined || limit === 0) return;
    const a = this.account(owner, resource);
    a.limit = limit;
    a.remaining = remaining;
    a.resetMs = reset * 1000;
    if (remaining < limit / 10 && a.warned !== a.resetMs) {
      a.warned = a.resetMs;
      console.warn(
        `github: ${remaining} of ${owner}'s ${limit} ${resource} API calls are left until ${isoS(a.resetMs)}; the hub polls GitHub ${SPREAD} times less often until then`,
      );
    }
  }

  /** GitHub refused for its rate limit: no call on the budget until the reset it names (capped), or a minute. When. */
  usedUp(owner: string, resource: string, headers: Map<string, string>): number {
    const now = this.now();
    const after = num(headers.get("retry-after"));
    const reset = num(headers.get("x-ratelimit-reset"));
    let until = after !== undefined ? now + after * 1000 : reset !== undefined ? reset * 1000 : now + LIMIT_WAIT_DEFAULT_MS;
    if (until <= now) until = now + LIMIT_WAIT_DEFAULT_MS;
    until = Math.min(until, now + LIMIT_WAIT_MAX_MS);
    const a = this.account(owner, resource);
    if (a.usedUpUntil === undefined || a.usedUpUntil < now) {
      console.warn(`github: ${owner}'s ${resource} API rate limit is used up until ${isoS(until)}; the hub's GitHub calls on it wait until then`);
    }
    a.usedUpUntil = Math.max(a.usedUpUntil ?? 0, until);
    return a.usedUpUntil;
  }

  /** When the account's limit resets, while it is used up. */
  until(owner: string, resource = "core"): number | undefined {
    const u = this.accounts.get(`${owner.toLowerCase()}\u0000${resource}`)?.usedUpUntil;
    return u !== undefined && u > this.now() ? u : undefined;
  }

  /** `ms`, or `SPREAD` times it while a budget of `owner` (any, without one) is under a tenth or used up. */
  spread(ms: number, owner?: string): number {
    const now = this.now();
    const prefix = owner === undefined ? undefined : `${owner.toLowerCase()}\u0000`;
    for (const [key, a] of this.accounts) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue;
      const low = a.remaining !== undefined && a.limit !== undefined && a.resetMs !== undefined && a.resetMs > now && a.remaining < a.limit / 10;
      if (low || (a.usedUpUntil !== undefined && a.usedUpUntil > now)) return ms * SPREAD;
    }
    return ms;
  }
}
