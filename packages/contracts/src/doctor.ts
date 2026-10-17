import { Schema } from "effect";
import { MachineId } from "./ids.ts";

// The doctor (M11): every setup check, live, each with a plain message and at most one fix.

/** Stable per check: `hub/<name>` or `<machineId>/<name>`, e.g. `hub/gh_auth`, `lab-a/disk`. */
export const DoctorCheckId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,32}\/[a-z0-9_]{1,40}$/u)).annotate({ identifier: "DoctorCheckId" });
export type DoctorCheckId = typeof DoctorCheckId.Type;

/** `unknown`: the hub could not look (machine offline, nothing to read). */
export const DoctorStatus = Schema.Literals(["ok", "warn", "fail", "unknown"]).annotate({ identifier: "DoctorStatus" });
export type DoctorStatus = typeof DoctorStatus.Type;

/** `auto`: doctor_fix runs it. `manual`: a person runs `command` (where the label says). */
export const DoctorFix = Schema.Struct({
  kind: Schema.Literals(["auto", "manual"]),
  label: Schema.String.check(Schema.isMaxLength(200)),
  command: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
}).annotate({ identifier: "DoctorFix" });
export type DoctorFix = typeof DoctorFix.Type;

export const DoctorCheck = Schema.Struct({
  id: DoctorCheckId,
  scope: Schema.Literals(["hub", "machine"]),
  /** Set when scope is machine. */
  machineId: Schema.optionalKey(MachineId),
  status: DoctorStatus,
  /** Plain language. */
  message: Schema.String.check(Schema.isMaxLength(500)),
  /** Absent when there is nothing to do. */
  fix: Schema.optionalKey(DoctorFix),
}).annotate({ identifier: "DoctorCheck" });
export type DoctorCheck = typeof DoctorCheck.Type;
