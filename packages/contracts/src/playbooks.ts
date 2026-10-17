import { Schema } from "effect";
import { ProjectRef } from "./ids.ts";
import { Brief, CheckType, PlaybookName, Tier } from "./ledger.ts";

// M9: playbook frontmatter, the research brief floor, and the intake router's answer.

const text = (max: number) => Schema.NonEmptyString.check(Schema.isMaxLength(max));
const oneLine = (max: number) => text(max).check(Schema.isPattern(/^[^\r\n]*$/u));

/** The brief's doneWhen needs at least one check whose type is in `anyOf`. */
export const RequiredCheck = Schema.Struct({
  anyOf: Schema.Array(CheckType).check(Schema.isMinLength(1), Schema.isUnique()),
  /** Names it in the refusal, e.g. "a failing repro check" gives "bugfix needs a failing repro check (type test or cmd)". */
  label: Schema.optionalKey(oneLine(100)),
}).annotate({ identifier: "RequiredCheck" });
export type RequiredCheck = typeof RequiredCheck.Type;

/** How a change of one tier is reviewed before the train merges it. */
export const ReviewRule = Schema.Struct({
  reviewers: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  verifier: Schema.Boolean,
  /** The plan is reviewed before any code is written. */
  planFirst: Schema.Boolean,
}).annotate({ identifier: "ReviewRule" });
export type ReviewRule = typeof ReviewRule.Type;

/** The YAML frontmatter of `playbooks/<name>.md`, or of its override in `~/.fleetd/hub/playbooks/`. */
export const Playbook = Schema.Struct({
  name: PlaybookName,
  /** Bumped by hand on changes to gates, checks, tiers or value-bar thresholds; the pin itself is the file's SHA. */
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Every entry must be met. */
  requiredChecks: Schema.Array(RequiredCheck).check(Schema.isMaxLength(10)),
  tierDefault: Tier,
  reviewRules: Schema.Struct({ S: ReviewRule, M: ReviewRule, L: ReviewRule }),
  valueBar: Schema.Struct({
    maxReviewRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    /** Every PR needs a `Source:` the train can resolve. */
    requireSource: Schema.Boolean,
  }),
  /** Estimate multiplier until the tier has calibration samples. */
  estimatePrior: Schema.Finite.check(Schema.isGreaterThan(0)),
  /** Injected into the lead's intake wake and digest for workstreams on this playbook. */
  leadInstructions: text(600),
}).annotate({ identifier: "Playbook" });
export type Playbook = typeof Playbook.Type;

/** What the research playbook adds to the floor, as refusal text. */
export const RESEARCH_FIELDS_FIX = "a research brief needs baseline, metric, decisionRule and budget.agentHours";

/** A Brief with the research fields present. Brief validation uses it when the workstream's playbook is research. */
export const ResearchBrief = Brief.check(
  Schema.makeFilter((brief) => {
    const missing = [
      ...(brief.baseline === undefined ? [["baseline"]] : []),
      ...(brief.metric === undefined ? [["metric"]] : []),
      ...(brief.decisionRule === undefined ? [["decisionRule"]] : []),
      ...(brief.budget?.agentHours === undefined ? [["budget", "agentHours"]] : []),
    ];
    const [first] = missing;
    return first === undefined ? undefined : { path: first, issue: `${RESEARCH_FIELDS_FIX}; missing ${missing.map((p) => p.join(".")).join(", ")}` };
  }),
).annotate({ identifier: "ResearchBrief" });
export type ResearchBrief = typeof ResearchBrief.Type;

/** The router's `claude -p` answer, which the hub then checks against the project list. */
export const RouterResult = Schema.Struct({
  projectRef: ProjectRef,
  template: PlaybookName,
  /** Shown to the human in the intake echo. */
  reason: oneLine(200),
}).annotate({ identifier: "RouterResult" });
export type RouterResult = typeof RouterResult.Type;

/** Where an intent went and why, whether the router, a prefix, `@<project>` or the caller decided it. */
export const IntakeEcho = Schema.Struct(RouterResult.fields).annotate({ identifier: "IntakeEcho" });
export type IntakeEcho = typeof IntakeEcho.Type;
