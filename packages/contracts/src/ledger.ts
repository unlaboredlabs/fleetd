import { Schema } from "effect";
import { MachineId, ProjectRef, ThreadId, Timestamp } from "./ids.ts";
import { isHttpUrl } from "./subscriptions.ts";

// M3 ledger objects: leads, workstreams and briefs, asks and batches, decisions.

/** `prefix` plus a positive integer, unique per hub, e.g. "W12". */
const hubSerial = (prefix: string) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}[1-9][0-9]*$`, "u")));

export const WorkstreamId = hubSerial("W").pipe(Schema.brand("WorkstreamId"), Schema.annotate({ identifier: "WorkstreamId" }));
export type WorkstreamId = typeof WorkstreamId.Type;
export const AskId = hubSerial("A").pipe(Schema.brand("AskId"), Schema.annotate({ identifier: "AskId" }));
export type AskId = typeof AskId.Type;
export const BatchId = hubSerial("B").pipe(Schema.brand("BatchId"), Schema.annotate({ identifier: "BatchId" }));
export type BatchId = typeof BatchId.Type;
export const DecisionId = hubSerial("D").pipe(Schema.brand("DecisionId"), Schema.annotate({ identifier: "DecisionId" }));
export type DecisionId = typeof DecisionId.Type;

/** Lowercase dotted slug such as "api.health.path", at most 80 characters. */
export const DecisionKey = Schema.String.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z0-9]+(\.[a-z0-9_-]+)*$/u),
).pipe(
  Schema.brand("DecisionKey"),
  Schema.annotate({ identifier: "DecisionKey", description: "Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)*, at most 80" }),
);
export type DecisionKey = typeof DecisionKey.Type;

const text = (max: number) => Schema.NonEmptyString.check(Schema.isMaxLength(max));
const list = <S extends Schema.Top>(item: S, max: number) => Schema.Array(item).check(Schema.isMaxLength(max));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** One line of status, as shown next to a workstream. */
export const Headline = Schema.String.check(Schema.isMaxLength(280), Schema.isPattern(/^[^\r\n]*$/u)).annotate({
  identifier: "Headline",
});

// Leads

export const LeadState = Schema.Literals(["starting", "idle", "working", "stalled", "stopped"]);
export type LeadState = typeof LeadState.Type;

export const Lead = Schema.Struct({
  projectRef: ProjectRef,
  /** The current lead thread on the project's machine; earlier ones stay in T3 as history. */
  threadId: ThreadId,
  state: LeadState,
  startedAt: Timestamp,
  lastWakeAt: Schema.optionalKey(Timestamp),
  /** Bumped by each lead_restart. */
  sessionGeneration: Count,
}).annotate({ identifier: "Lead" });
export type Lead = typeof Lead.Type;

// Briefs and their done-when checks (runners arrive in M6)

const Repo = text(200);

export const CheckSpec = Schema.Union([
  Schema.Struct({ type: Schema.tag("pr_merged"), repo: Repo, pr: Schema.optionalKey(Positive) }),
  Schema.Struct({ type: Schema.tag("ci_green"), repo: Repo, ref: Schema.optionalKey(text(200)) }),
  Schema.Struct({
    type: Schema.tag("http"),
    url: Schema.String.check(Schema.makeFilter(isHttpUrl, { expected: "an absolute http:// or https:// URL" })),
    status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    contains: Schema.optionalKey(text(500)),
  }),
  Schema.Struct({
    type: Schema.tag("cmd"),
    machineId: MachineId,
    argv: list(Schema.String, 64).check(Schema.isMinLength(1)),
    expectExit: Schema.Int,
  }),
  Schema.Struct({ type: Schema.tag("test"), repo: Repo, testId: text(500) }),
  Schema.Struct({ type: Schema.tag("judge"), criteria: text(2000) }),
  Schema.Struct({ type: Schema.tag("human"), question: text(500) }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "CheckSpec" });
export type CheckSpec = typeof CheckSpec.Type;

export const Tier = Schema.Literals(["S", "M", "L"]);
export type Tier = typeof Tier.Type;

export const Brief = Schema.Struct({
  goal: text(1000),
  why: text(2000),
  pointers: list(text(500), 20),
  constraints: list(text(500), 20),
  /** At least one; frozen with the brief. */
  doneWhen: list(CheckSpec, 20).check(Schema.isMinLength(1)),
  tier: Tier,
  budget: Schema.optionalKey(Schema.Struct({ agentHours: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))) })),
  estimate: Schema.optionalKey(
    Schema.Struct({ rawMinutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)), gates: list(text(200), 20) }),
  ),
}).annotate({ identifier: "Brief" });
export type Brief = typeof Brief.Type;

/** sha256 of the brief's canonical JSON, lowercase hex. */
export const BriefHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).annotate({ identifier: "BriefHash" });

// Workstreams

export const WorkstreamState = Schema.Literals(["draft", "running", "converging", "verifying", "done", "idle", "stopped", "failed"]);
export type WorkstreamState = typeof WorkstreamState.Type;

export const IntakeChannel = Schema.Literals(["app", "phone", "mcp", "lead"]);
export type IntakeChannel = typeof IntakeChannel.Type;

/** The one-line intent as submitted. */
export const IntakeText = text(4000);

export const Workstream = Schema.Struct({
  workstreamId: WorkstreamId,
  projectRef: ProjectRef,
  title: Schema.String.check(Schema.isMaxLength(200)),
  source: Schema.Struct({
    text: IntakeText,
    channel: IntakeChannel,
    /** Who submitted it: an agent keyId, "human" or "lead:<machineId>/<projectId>". */
    by: Schema.String,
    at: Timestamp,
  }),
  /** Absent while draft. */
  brief: Schema.optionalKey(Brief),
  briefHash: Schema.optionalKey(BriefHash),
  state: WorkstreamState,
  headline: Schema.optionalKey(Headline),
  headlineAt: Schema.optionalKey(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).annotate({ identifier: "Workstream" });
export type Workstream = typeof Workstream.Type;

// Decisions

export const DecisionValue = text(2000);

export const DecisionScope = Schema.Union([
  Schema.Struct({ kind: Schema.tag("global") }),
  Schema.Struct({ kind: Schema.tag("project"), projectRef: ProjectRef }),
  Schema.Struct({ kind: Schema.tag("workstream"), workstreamId: WorkstreamId }),
])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "DecisionScope" });
export type DecisionScope = typeof DecisionScope.Type;

/** Filled by the hub from the caller: a human device, an agent key, or a lead-side call. */
export const DecisionSource = Schema.Literals(["human", "lead", "agent"]);
export type DecisionSource = typeof DecisionSource.Type;

export const DecisionState = Schema.Literals(["active", "superseded", "retired"]);
export type DecisionState = typeof DecisionState.Type;

export const DecisionWhy = text(2000);

export const Decision = Schema.Struct({
  decisionId: DecisionId,
  key: DecisionKey,
  scope: DecisionScope,
  value: DecisionValue,
  why: Schema.optionalKey(DecisionWhy),
  source: DecisionSource,
  /** Who recorded it: the agent key name, "lead:<machineId>/<projectId>" or "human:<device>". */
  by: Schema.optionalKey(Schema.String),
  /** The ask this answers, when it came from one. */
  askId: Schema.optionalKey(AskId),
  /** The earlier active decision on the same key and scope that this one replaced. */
  supersedes: Schema.optionalKey(DecisionId),
  state: DecisionState,
  at: Timestamp,
}).annotate({ identifier: "Decision" });
export type Decision = typeof Decision.Type;

// Asks

export const AskKind = Schema.Literals(["decide", "do"]);
export type AskKind = typeof AskKind.Type;

export const AskClass = Schema.Literals(["product", "money", "credential", "irreversible"]);
export type AskClass = typeof AskClass.Type;

export const AskState = Schema.Literals(["open", "auto", "answered", "defaulted", "withdrawn"]);
export type AskState = typeof AskState.Type;

export const AskText = text(500);

/** `<name>`-style placeholders: "<" and ">" with no space just inside, so `sort < a > b` passes. */
const PLACEHOLDER = /<[^\s<>](?:[^<>]*[^\s<>])?>/u;

/** A shell command a human runs verbatim; placeholders such as `<token>` are refused. */
export const StepCommand = text(2000).check(
  Schema.makeFilter((command) => !PLACEHOLDER.test(command), {
    expected: "an exact command with no <placeholders>; write the real value or make it a separate step",
  }),
);

export const Step = Schema.Struct({
  text: text(500),
  /** A machineId, "browser" or "phone". */
  where: Schema.Union([Schema.Literals(["browser", "phone"]), MachineId]),
  command: Schema.optionalKey(StepCommand),
  /** What the human should see when the step worked. */
  expect: Schema.optionalKey(text(500)),
}).annotate({ identifier: "Step" });
export type Step = typeof Step.Type;

/** "nothing", or the step the lead is holding back until this is answered. */
export const AskBlocks = Schema.Union([Schema.Literal("nothing"), text(200)]);

export const AskOptions = list(DecisionValue, 6);
export const AskSteps = list(Step, 20);

/** A decide needs a recommendation and a do needs at least one step. */
export const askKindRule = Schema.makeFilter(
  (ask: { readonly kind: AskKind; readonly recommendation?: string; readonly steps?: ReadonlyArray<unknown> }) => {
    if (ask.kind === "decide" && ask.recommendation === undefined) {
      return { path: ["recommendation"], issue: "a decide ask needs a recommendation" };
    }
    if (ask.kind === "do" && (ask.steps === undefined || ask.steps.length === 0)) {
      return { path: ["steps"], issue: "a do ask needs at least one step" };
    }
    return undefined;
  },
);

export const Ask = Schema.Struct({
  askId: AskId,
  projectRef: ProjectRef,
  workstreamId: Schema.optionalKey(WorkstreamId),
  kind: AskKind,
  key: DecisionKey,
  class: AskClass,
  text: AskText,
  options: Schema.optionalKey(AskOptions),
  /** Required for decide. */
  recommendation: Schema.optionalKey(DecisionValue),
  /** Required for do. */
  steps: Schema.optionalKey(AskSteps),
  blocks: AskBlocks,
  /** The lead carried on with the recommendation; the answer confirms or overrides it. */
  proceededOnRec: Schema.Boolean,
  state: AskState,
  batchId: Schema.optionalKey(BatchId),
  /** Fixed within its batch; never renumbered. */
  number: Schema.optionalKey(Positive),
  answer: Schema.optionalKey(
    Schema.Struct({
      value: Schema.String,
      by: Schema.String,
      at: Timestamp,
      /** The reply text it was parsed from. */
      raw: Schema.String,
    }),
  ),
  decisionId: Schema.optionalKey(DecisionId),
  createdAt: Timestamp,
})
  .check(askKindRule)
  .annotate({ identifier: "Ask" });
export type Ask = typeof Ask.Type;

export const BatchState = Schema.Literals(["open", "closed"]);
export type BatchState = typeof BatchState.Type;

export const Batch = Schema.Struct({
  batchId: BatchId,
  createdAt: Timestamp,
  items: Schema.Array(Schema.Struct({ number: Positive, askId: AskId })),
  state: BatchState,
}).annotate({ identifier: "Batch" });
export type Batch = typeof Batch.Type;
