// Usage limits from what the node reports about a failed run: its failure class, reset time and model.
// The node's runner decides them; this only maps them. Pure.
import type { HubEvent } from "../../shared/contracts.ts";
import { isoMs, parseMs } from "../store/time.ts";

export type UsageClass = "usage_limit" | "rate_limit" | "pool_exhausted";

export type LimitInput = {
  /** The node's failure class (`usage_limit`, `rate_limit`, `pool_exhausted`, `other`, ...). */
  errorClass?: string;
  /** The node's reset time for the limit. */
  resetAt?: string;
  /** When the run failed; fallback resets count from here. */
  at: string;
  /** The session's model. */
  model?: string;
  /** The model the failure names, which wins over the session's: only a gateway's words name one. */
  failureModel?: string;
};

export type Limit = {
  class: UsageClass;
  /** The reset the node read off the failure; absent when it named none, and for pool_exhausted. */
  resumeAt?: string;
  model?: string;
  /** A proxy in front of the login decided it. */
  proxy: boolean;
};

/** The limit behind a failure, or undefined for an ordinary failure. A reset not after the failure counts as none. */
export function classifyLimit(input: LimitInput): Limit | undefined {
  const failureModel = input.failureModel ? input.failureModel : undefined;
  const model = failureModel ?? (input.model ? input.model : undefined);
  const proxy = failureModel !== undefined;
  const withModel = (l: Limit): Limit => (model !== undefined ? { ...l, model } : l);
  let cls: UsageClass;
  switch (input.errorClass) {
    case "pool_exhausted":
      return withModel({ class: "pool_exhausted", proxy });
    case "usage_limit":
    case "rate_limit":
      cls = input.errorClass;
      break;
    default:
      return undefined;
  }
  const atMs = parseMs(input.at) ?? 0;
  const reset = input.resetAt === undefined ? undefined : parseMs(input.resetAt);
  const limit: Limit = { class: cls, proxy };
  if (reset !== undefined && reset > atMs) limit.resumeAt = isoMs(reset);
  return withModel(limit);
}

/** The event data fields the executor adds to thread.usage_limited. */
export function limitData(limit: Limit): Record<string, unknown> {
  const data: Record<string, unknown> = { usageClass: limit.class };
  if (limit.resumeAt !== undefined) data.resumeAt = limit.resumeAt;
  if (limit.model !== undefined) data.model = limit.model;
  if (limit.proxy) data.proxy = true;
  return data;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A thread.usage_limited event's limit: what the executor stamped on it, else classified again from its error. */
export function limitOfEvent(event: HubEvent): Limit | undefined {
  if (event.type !== "thread.usage_limited") return undefined;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const cls = data.usageClass;
  if (cls === "usage_limit" || cls === "rate_limit" || cls === "pool_exhausted") {
    const limit: Limit = { class: cls, proxy: data.proxy === true };
    if (str(data.resumeAt) !== undefined) limit.resumeAt = str(data.resumeAt);
    if (str(data.model) !== undefined) limit.model = str(data.model);
    return limit;
  }
  // Events from before M4 carry no usageClass, and were all usage limits.
  const resetAt = str(data.usageLimitResetAt);
  return classifyLimit({ errorClass: "usage_limit", at: event.at, ...(resetAt !== undefined ? { resetAt } : {}) });
}

/** What a task or lead record shows while parked. */
export type UsageParked = { class: UsageClass; since: string; resumeAt?: string; checkAt?: string; proxy?: boolean };

export function parkedOf(event: HubEvent): UsageParked | undefined {
  const limit = limitOfEvent(event);
  if (!limit) return undefined;
  return {
    class: limit.class,
    since: event.at,
    ...(limit.resumeAt !== undefined ? { resumeAt: limit.resumeAt } : {}),
    ...(limit.proxy ? { proxy: true } : {}),
  };
}
