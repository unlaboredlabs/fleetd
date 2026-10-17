import { Schema } from "effect";
import { HubEvent } from "./events.ts";
import { MachineId, Timestamp } from "./ids.ts";

// M4 usage clarity: limit classes, parked work, the per-login breaker and the usage_status view. fleetd never calls a
// model or usage API; everything here is read off T3's thread errors, its provider status and its trace file.

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * What stopped a turn. `usage_limit`: the plan's usage limit or a proxy cooldown, with a reset. `rate_limit`: a 429.
 * `pool_exhausted`: the user's proxy has no account for the model (CLIProxyAPI's 400 "unknown provider for model", or
 * its 503 "no auth available"); it needs the human, so it waits for usage_resume.
 */
export const UsageClass = Schema.Literals(["usage_limit", "rate_limit", "pool_exhausted"]).annotate({ identifier: "UsageClass" });
export type UsageClass = typeof UsageClass.Type;

/** Read from the T3 provider instance status and its env var names, never from credentials. */
export const LoginKind = Schema.Literals(["subscription", "api_key", "custom_base_url", "unknown"]).annotate({ identifier: "LoginKind" });
export type LoginKind = typeof LoginKind.Type;

/** A task or lead whose thread hit a limit; fleetd sends it one "continue" at `resumeAt`. */
export const UsageParked = Schema.Struct({
  class: UsageClass,
  since: Timestamp,
  /** Absent for pool_exhausted: it resumes on usage_resume. */
  resumeAt: Schema.optionalKey(Timestamp),
}).annotate({ identifier: "UsageParked" });
export type UsageParked = typeof UsageParked.Type;

/** Open: no new turns start on the machine's login until `until` or usage_resume. */
export const UsageBreaker = Schema.Struct({
  state: Schema.Literals(["closed", "open"]),
  class: Schema.optionalKey(UsageClass),
  since: Schema.optionalKey(Timestamp),
  /** Absent while open means until usage_resume. */
  until: Schema.optionalKey(Timestamp),
  /** The plain notice, as the usage.breaker event said it. */
  message: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "UsageBreaker" });
export type UsageBreaker = typeof UsageBreaker.Type;

/** Direct usage or reset-credit calls seen in the machine's T3 trace file. Must be 0. */
export const ProbeCounter = Schema.Struct({
  observable: Schema.Boolean,
  count: Schema.optionalKey(Count),
  /** The trace directory read, when observable. */
  source: Schema.optionalKey(Schema.String),
  /** Why it is not observable. */
  reason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "ProbeCounter" });
export type ProbeCounter = typeof ProbeCounter.Type;

export const UsageStatus = Schema.Struct({
  machineId: MachineId,
  login: LoginKind,
  breaker: UsageBreaker,
  parked: Schema.Struct({ leads: Count, tasks: Count }),
  /** The latest thread.usage_limited, usage.breaker and usage.resumed events for the machine, oldest first. */
  lastEvents: Schema.Array(HubEvent).check(Schema.isMaxLength(10)),
  probes: ProbeCounter,
}).annotate({ identifier: "UsageStatus" });
export type UsageStatus = typeof UsageStatus.Type;

/** Fields `HubEvent.data` carries on usage.breaker and usage.resumed. */
export const UsageEventData = Schema.Struct({
  class: Schema.optionalKey(UsageClass),
  until: Schema.optionalKey(Timestamp),
  model: Schema.optionalKey(Schema.String),
  parked: Schema.optionalKey(Schema.Struct({ leads: Count, tasks: Count })),
  /** usage.resumed: the breaker was open and is now closed. */
  breakerCleared: Schema.optionalKey(Schema.Boolean),
  /** usage.resumed: "reset", or who ran usage_resume. */
  by: Schema.optionalKey(Schema.String),
  /** usage.resumed: the threads sent "continue", in the order they were sent. */
  threads: Schema.optionalKey(Schema.Array(Schema.Struct({ threadId: Schema.String, kind: Schema.String, taskId: Schema.optionalKey(Schema.String) }))),
}).annotate({ identifier: "UsageEventData" });
export type UsageEventData = typeof UsageEventData.Type;
