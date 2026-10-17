import { Schema } from "effect";
import { Timestamp } from "./ids.ts";
import { AskId, PlaybookName, PlaybookRef } from "./ledger.ts";
import { IncidentId } from "./verification.ts";

// M12: the retro job's playbook changes, the fixed metrics they are judged by, and its runs.

const text = (max: number) => Schema.NonEmptyString.check(Schema.isMaxLength(max));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The fixed metric list, defined in code: incident counts per class, and agent-minutes per done workstream. A
 * proposal names one; the retro cannot add or change them.
 */
export const RetroMetricClass = Schema.Literals([
  "false_claim",
  "estimate_miss",
  "polish_loop",
  "misfiled_ask",
  "out_of_area",
  "stall",
  "policy_bypass",
  "re_ask",
  "override",
  "agent_minutes_per_done",
]);
export type RetroMetricClass = typeof RetroMetricClass.Type;

export const RetroMetric = Schema.Struct({
  class: RetroMetricClass,
  op: Schema.Literal("decrease"),
  /** Measured over this many days after the change, against the same span before it. */
  windowDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 28 })),
}).annotate({ identifier: "RetroMetric" });
export type RetroMetric = typeof RetroMetric.Type;

export const PlaybookChangeKind = Schema.Literals(["wording", "gate"]);
export type PlaybookChangeKind = typeof PlaybookChangeKind.Type;

/** One change the retro's `claude -p` run proposes; the hub validates it and classifies its kind itself. */
export const PlaybookChange = Schema.Struct({
  playbook: PlaybookName,
  /** Unified diff of the playbook file, frontmatter or body. */
  diff: text(8000),
  kind: PlaybookChangeKind,
  fixesIncidents: Schema.Array(IncidentId).check(Schema.isMaxLength(20)),
  metric: RetroMetric,
  expected: text(300),
}).annotate({ identifier: "PlaybookChange" });
export type PlaybookChange = typeof PlaybookChange.Type;

/** A metric's values over one window; agent-minutes is null when no workstream finished in it. */
export const RetroSnapshot = Schema.Struct({
  target: Schema.NullOr(Schema.Finite),
  false_claim: Count,
  estimate_miss: Count,
  polish_loop: Count,
  agent_minutes_per_done: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "RetroSnapshot" });
export type RetroSnapshot = typeof RetroSnapshot.Type;

export const RetroProposalId = Schema.String.check(Schema.isPattern(/^R[1-9][0-9]*$/u)).pipe(
  Schema.brand("RetroProposalId"),
  Schema.annotate({ identifier: "RetroProposalId" }),
);
export type RetroProposalId = typeof RetroProposalId.Type;

/**
 * suggested: advise-only, nothing applies. pending: a gate change waiting for the weekly Ask; asked: in it.
 * measuring: a wording change applied, its window running; then kept or reverted. applied: a gate change a person
 * approved. rejected: a person said no. stale: the playbook changed under it, so its diff no longer applies.
 */
export const RetroProposalState = Schema.Literals(["suggested", "pending", "asked", "measuring", "kept", "reverted", "applied", "rejected", "stale"]);
export type RetroProposalState = typeof RetroProposalState.Type;

export const RetroProposal = Schema.Struct({
  proposalId: RetroProposalId,
  /** The retro run that proposed it. */
  run: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  at: Timestamp,
  playbook: PlaybookName,
  /** Decided by the hub from the fields the diff touches. */
  kind: PlaybookChangeKind,
  /** What the model said it was. */
  claimedKind: PlaybookChangeKind,
  diff: text(8000),
  /** Frontmatter fields the diff changes, plus "body". */
  fields: Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
  fixesIncidents: Schema.Array(IncidentId).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  metric: RetroMetric,
  expected: text(300),
  state: RetroProposalState,
  /** The gate Ask, key `playbook.<name>.<hash>`. */
  askId: Schema.optionalKey(AskId),
  /** The version it applied and the one it replaced. */
  ref: Schema.optionalKey(PlaybookRef),
  previousRef: Schema.optionalKey(PlaybookRef),
  appliedAt: Schema.optionalKey(Timestamp),
  /** When a wording change's window ends and its metric is computed. */
  dueAt: Schema.optionalKey(Timestamp),
  /** The window before it applied; `measured` is the window after. */
  baseline: Schema.optionalKey(RetroSnapshot),
  measured: Schema.optionalKey(RetroSnapshot),
  note: Schema.optionalKey(text(500)),
}).annotate({ identifier: "RetroProposal" });
export type RetroProposal = typeof RetroProposal.Type;

/** A `claude -p` one-shot the hub ran for itself, counted as orchestrator usage. */
export const OrchestratorRun = Schema.Struct({
  kind: Schema.Literal("orchestrator"),
  model: Schema.String,
  durationMs: Count,
  ok: Schema.Boolean,
  inputTokens: Schema.optionalKey(Count),
  outputTokens: Schema.optionalKey(Count),
  error: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "OrchestratorRun" });
export type OrchestratorRun = typeof OrchestratorRun.Type;

export const RetroTrigger = Schema.Literals(["weekly", "threshold", "manual"]);
export type RetroTrigger = typeof RetroTrigger.Type;

export const RetroRun = Schema.Struct({
  run: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  at: Timestamp,
  trigger: RetroTrigger,
  /** Nothing it proposed applies: `--advise`, or `policy.retro.apply` is not true. */
  advise: Schema.Boolean,
  windowDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 28 })),
  /** Incidents in the window it was given. */
  incidents: Count,
  proposals: Schema.Array(RetroProposalId).check(Schema.isMaxLength(10)),
  /** Changes the hub refused, with why. */
  dropped: Schema.Array(Schema.Struct({ index: Count, playbook: Schema.optionalKey(Schema.String), reason: text(500) })).check(Schema.isMaxLength(20)),
  /** Absent when there was nothing to look at and no turn ran. */
  usage: Schema.optionalKey(OrchestratorRun),
}).annotate({ identifier: "RetroRun" });
export type RetroRun = typeof RetroRun.Type;
