import { Schema } from "effect";
import { MachineId, ThreadId, Timestamp } from "./ids.ts";

const isIanaTimeZone = (tz: string): boolean => {
  // Intl also accepts UTC offsets such as "+01:00", which are not IANA zone names.
  if (/^[+-]/u.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** IANA time zone name, e.g. "Europe/London" or "UTC", as known to the runtime's Intl data. */
export const TimeZone = Schema.String.check(
  Schema.makeFilter(isIanaTimeZone, { expected: "an IANA time zone name such as Europe/London" }),
).annotate({ identifier: "TimeZone" });
export type TimeZone = typeof TimeZone.Type;

export const WakeTarget = Schema.Struct({ machineId: MachineId, threadId: ThreadId }).annotate({ identifier: "WakeTarget" });
export type WakeTarget = typeof WakeTarget.Type;

export const WakeAt = Schema.Struct({ kind: Schema.tag("at"), at: Timestamp, tz: TimeZone });
export const WakeEvery = Schema.Struct({
  kind: Schema.tag("every"),
  everySec: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60)),
});
/** Standard 5-field cron; the hub parses it. */
export const WakeCron = Schema.Struct({ kind: Schema.tag("cron"), cron: Schema.NonEmptyString, tz: TimeZone });

export const WakeSchedule = Schema.Union([WakeAt, WakeEvery, WakeCron])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "WakeSchedule" });
export type WakeSchedule = typeof WakeSchedule.Type;

export const WakeMessage = Schema.NonEmptyString.check(Schema.isMaxLength(4000));

export const WakeCatchUp = Schema.Literals(["fire_once", "skip"]);
export type WakeCatchUp = typeof WakeCatchUp.Type;

export const WakeState = Schema.Literals(["active", "done", "cancelled"]);
export type WakeState = typeof WakeState.Type;

export const Wake = Schema.Struct({
  wakeId: Schema.NonEmptyString,
  target: WakeTarget,
  schedule: WakeSchedule,
  message: WakeMessage,
  once: Schema.Boolean,
  /** What to do with a firing missed while the hub was down. */
  catchUp: WakeCatchUp,
  /** Absent once the wake is done or cancelled. */
  nextRunAt: Schema.optionalKey(Timestamp),
  lastFiredAt: Schema.optionalKey(Timestamp),
  /** keyId of the agent key that set it. */
  createdBy: Schema.String,
  state: WakeState,
}).annotate({ identifier: "Wake" });
export type Wake = typeof Wake.Type;
