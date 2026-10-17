// Usage-limit classification from what T3 reports about a failed thread: its failure class and reset time, plus the
// error text the `claude` CLI or a proxy in front of it produced. Pure; the executor uses it to tell a limit from a
// failure, and the usage layer to park and pace. fleetd never asks a usage API.
import type { HubEvent, ThreadSummary, UsageClass, UsageParked } from "@fleetd/contracts";

export interface LimitInput {
  /** T3's failure class (`usage_limit`, `provider_error`, ...). */
  readonly errorClass?: string;
  readonly message: string;
  /** T3's `usageLimitResetAt`. */
  readonly resetAt?: string;
  /** When the thread failed; fallback resets count from here. */
  readonly at: string;
  readonly model?: string;
}

export interface Limit {
  readonly class: UsageClass;
  /** Absent for pool_exhausted, which waits for usage_resume. */
  readonly resumeAt?: string;
  readonly model?: string;
}

/** When nothing says when the limit resets. */
export const FALLBACK_WAIT_MS: Readonly<Record<Exclude<UsageClass, "pool_exhausted">, number>> = {
  usage_limit: 60 * 60_000,
  rate_limit: 5 * 60_000,
};

// CLIProxyAPI: a model no enabled credential offers, or every credential signed out (research 04 §2.3).
const UNKNOWN_PROVIDER = /unknown provider for model\s+["']?([^\s"'\\,}]+)/iu;
const NO_ACCOUNT = /no available account|no auth available|auth_unavailable/iu;
// CLIProxyAPI: every credential for the model is cooling down; it says when in reset_seconds.
const COOLDOWN = /model_cooldown|are cooling down/iu;
const RESET_SECONDS = /"reset_seconds"\s*:\s*(\d+)/u;
const RATE = /rate[ _-]?limit|\[429\]|\b(?:api error|status|error)\W{0,3}429\b/iu;
const USAGE = /usage limit|hit your (?:usage )?limit|(?:5-hour|weekly|session|opus) limit reached|out of extra usage/iu;
// The CLI's "Claude AI usage limit reached|<epoch seconds>".
const PIPE_EPOCH = /limit reached\|(\d{10})\b/iu;
// A proxy's "(reset after 1h2m3s)".
const RESET_AFTER = /reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?/iu;

const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

/** The first reset that lies after the failure. */
const resetOf = (input: LimitInput, cls: Exclude<UsageClass, "pool_exhausted">): string => {
  const failedMs = Date.parse(input.at);
  const after = (iso: string | undefined) => (iso !== undefined && Date.parse(iso) > failedMs ? iso : undefined);
  const epoch = PIPE_EPOCH.exec(input.message);
  const seconds = RESET_SECONDS.exec(input.message);
  const span = RESET_AFTER.exec(input.message);
  const spanMs = span === null ? 0 : (Number(span[1] ?? 0) * 3600 + Number(span[2] ?? 0) * 60 + Number(span[3] ?? 0)) * 1000;
  return (
    after(input.resetAt) ??
    after(epoch === null ? undefined : new Date(Number(epoch[1]) * 1000).toISOString()) ??
    (seconds !== null && Number(seconds[1]) > 0 ? plus(input.at, Number(seconds[1]) * 1000) : undefined) ??
    (spanMs > 0 ? plus(input.at, spanMs) : undefined) ??
    plus(input.at, FALLBACK_WAIT_MS[cls])
  );
};

/** The limit behind a failure, or undefined when it is an ordinary failure. */
export const classifyLimit = (input: LimitInput): Limit | undefined => {
  const text = input.message;
  const model = (m: string | undefined) => (m === undefined || m === "" ? {} : { model: m });
  const unknown = UNKNOWN_PROVIDER.exec(text);
  if (unknown !== null) return { class: "pool_exhausted", model: unknown[1]! };
  if (NO_ACCOUNT.test(text)) return { class: "pool_exhausted", ...model(input.model) };
  if (COOLDOWN.test(text)) return { class: "usage_limit", resumeAt: resetOf(input, "usage_limit"), ...model(input.model) };
  const cls = RATE.test(text) ? "rate_limit" : input.errorClass === "usage_limit" || USAGE.test(text) ? "usage_limit" : undefined;
  return cls === undefined ? undefined : { class: cls, resumeAt: resetOf(input, cls), ...model(input.model) };
};

/** A failed thread's limit, read off its summary. */
export const limitOfSummary = (s: ThreadSummary): Limit | undefined =>
  s.status !== "failed" || s.lastError === undefined
    ? undefined
    : classifyLimit({
        errorClass: s.lastError.class,
        message: s.lastError.message,
        at: s.lastProgressAt,
        ...(s.usageLimitResetAt === undefined ? {} : { resetAt: s.usageLimitResetAt }),
        ...(s.model === undefined ? {} : { model: s.model }),
      });

/** The event data fields the executor adds to thread.usage_limited. */
export const limitData = (limit: Limit) => ({
  usageClass: limit.class,
  ...(limit.resumeAt === undefined ? {} : { resumeAt: limit.resumeAt }),
  ...(limit.model === undefined ? {} : { model: limit.model }),
});

interface LimitedData {
  readonly usageClass?: UsageClass;
  readonly resumeAt?: string;
  readonly model?: string;
  readonly error?: { readonly class?: string; readonly message?: string };
  readonly usageLimitResetAt?: string;
}

/** A thread.usage_limited event's limit: what the executor stamped on it, else classified again from its error. */
export const limitOfEvent = (event: HubEvent): Limit | undefined => {
  if (event.type !== "thread.usage_limited") return undefined;
  const data = (event.data ?? {}) as LimitedData;
  if (data.usageClass !== undefined) {
    return {
      class: data.usageClass,
      ...(data.resumeAt === undefined ? {} : { resumeAt: data.resumeAt }),
      ...(data.model === undefined ? {} : { model: data.model }),
    };
  }
  // Events from before M4 carry only T3's class and reset; T3 marked them usage_limit.
  return (
    classifyLimit({
      errorClass: data.error?.class ?? "usage_limit",
      message: data.error?.message ?? "",
      at: event.at,
      ...(data.usageLimitResetAt === undefined ? {} : { resetAt: data.usageLimitResetAt }),
    }) ?? { class: "usage_limit", resumeAt: plus(event.at, FALLBACK_WAIT_MS.usage_limit) }
  );
};

/** What a task or lead record shows while parked. */
export const parkedOf = (event: HubEvent): UsageParked | undefined => {
  const limit = limitOfEvent(event);
  return limit === undefined ? undefined : { class: limit.class, since: event.at, ...(limit.resumeAt === undefined ? {} : { resumeAt: limit.resumeAt }) };
};
