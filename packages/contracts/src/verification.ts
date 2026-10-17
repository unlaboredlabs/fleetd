import { Schema } from "effect";
import { ProjectRef, Timestamp } from "./ids.ts";
import { CheckSpec, MetricValues, WorkstreamId } from "./ledger.ts";
import { TaskId } from "./tasks.ts";

// M6 objects: claims and their check results, review verdicts, calibrated ETAs and incidents.

const text = (max: number) => Schema.NonEmptyString.check(Schema.isMaxLength(max));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Minutes = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const ClaimId = Schema.String.check(Schema.isPattern(/^C[1-9][0-9]*$/u)).pipe(
  Schema.brand("ClaimId"),
  Schema.annotate({ identifier: "ClaimId" }),
);
export type ClaimId = typeof ClaimId.Type;

export const IncidentId = Schema.String.check(Schema.isPattern(/^I[1-9][0-9]*$/u)).pipe(
  Schema.brand("IncidentId"),
  Schema.annotate({ identifier: "IncidentId" }),
);
export type IncidentId = typeof IncidentId.Type;

/** A full lowercase commit SHA (SHA-1 or SHA-256), so the same head always compares equal. */
export const CommitSha = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)).annotate({
  identifier: "CommitSha",
  description: "Full lowercase hex commit SHA, 40 or 64 characters",
});

/** `error` (the check could not run) counts as not passing. */
export const CheckOutcome = Schema.Literals(["pass", "fail", "error"]);
export type CheckOutcome = typeof CheckOutcome.Type;

export const CheckResult = Schema.Struct({
  /** 0-based index into the brief's doneWhen. */
  checkIndex: Count,
  spec: CheckSpec,
  result: CheckOutcome,
  /** Output tail, HTTP status and body excerpt, verdict summary, or the fix when `error`. */
  evidence: Schema.String.check(Schema.isMaxLength(2000)),
  /** Only for `cmd` checks, which the node runs. */
  exitCode: Schema.optionalKey(Schema.Int),
  ranBy: Schema.Literals(["hub", "node", "judge", "human"]),
  at: Timestamp,
}).annotate({ identifier: "CheckResult" });
export type CheckResult = typeof CheckResult.Type;

export const Claim = Schema.Struct({
  claimId: ClaimId,
  workstreamId: WorkstreamId,
  /** "lead:<machineId>/<projectId>", an agent keyId or "human". */
  by: Schema.String,
  at: Timestamp,
  /** In check index order. */
  results: Schema.Array(CheckResult).check(Schema.isMaxLength(20)),
  /** `pass` only when every check passed. */
  outcome: Schema.Literals(["pass", "fail"]),
}).annotate({ identifier: "Claim" });
export type Claim = typeof Claim.Type;

/** `fleetd review verdict`, the last step of every review task. */
export const ReviewVerdict = Schema.Struct({
  taskId: TaskId,
  prHeadSha: CommitSha,
  blocking: Count,
  nonBlocking: Count,
  summary: text(1000),
  /** M9: a research workstream's judge reports its metric for the baseline and the candidate; the hub computes the verdict. */
  metricValues: Schema.optionalKey(MetricValues),
}).annotate({ identifier: "ReviewVerdict" });
export type ReviewVerdict = typeof ReviewVerdict.Type;

/** The brief's raw estimate corrected by the tier's measured actual/raw ratio. */
export const Eta = Schema.Struct({
  rawMinutes: Minutes,
  calibratedMinutes: Minutes,
  /** Median actual/raw over the tier's last 20 done workstreams; the 5.0 prior below 5 samples. */
  ratio: Schema.Finite.check(Schema.isGreaterThan(0)),
  samples: Count,
  /** From 10 samples on. */
  p80Minutes: Schema.optionalKey(Minutes),
}).annotate({ identifier: "Eta" });
export type Eta = typeof Eta.Type;

/**
 * `policy_bypass`: a PR on a watched repo was merged by something other than the train. M12: `re_ask`, a human was
 * asked about a key that already had an active Decision; `override`, a human replaced a lead's Decision with another
 * value; `playbook_reverted`, a retro wording change missed its metric and was rolled back.
 */
export const IncidentClass = Schema.Literals([
  "false_claim",
  "estimate_miss",
  "polish_loop",
  "misfiled_ask",
  "out_of_area",
  "stall",
  "policy_bypass",
  "re_ask",
  "override",
  "playbook_reverted",
]);
export type IncidentClass = typeof IncidentClass.Type;

/** Recorded by the hub, never by an agent. */
export const Incident = Schema.Struct({
  incidentId: IncidentId,
  class: IncidentClass,
  projectRef: ProjectRef,
  workstreamId: Schema.optionalKey(WorkstreamId),
  taskId: Schema.optionalKey(TaskId),
  /** Plain-language lines: claim ids with their failing checks, ratios, SHAs. */
  evidence: Schema.Array(text(2000)).check(Schema.isMaxLength(20)),
  at: Timestamp,
}).annotate({ identifier: "Incident" });
export type Incident = typeof Incident.Type;
