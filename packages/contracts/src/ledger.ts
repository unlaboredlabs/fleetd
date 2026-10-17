import { Schema } from "effect";
import { MachineId, ProjectRef, ThreadId, Timestamp } from "./ids.ts";
import { SecretFingerprint, SecretSink } from "./secrets.ts";
import { isHttpUrl } from "./subscriptions.ts";
import { UsageParked } from "./usage.ts";

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
  /** M4: the lead thread hit a usage limit; derived from the usage layer when read. */
  parked: Schema.optionalKey(UsageParked),
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

/** The `type` of a CheckSpec, as playbooks name them in `requiredChecks`. */
export const CheckType = Schema.Literals(["pr_merged", "ci_green", "http", "cmd", "test", "judge", "human"]);
export type CheckType = typeof CheckType.Type;
// Fails to compile when CheckSpec gains or loses a type without CheckType following.
const checkTypesMatch: [CheckType, CheckSpec["type"]] extends [CheckSpec["type"], CheckType] ? true : never = true;
void checkTypesMatch;

/** What a write task must serve, as `--serves` takes it. */
export const SERVES_FIX = "say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | ask:<id>";

const isServes = (serves: string): boolean => {
  const [, kind = "", ref = ""] = /^(done|issue|defect|ask):(.*)$/su.exec(serves) ?? [];
  switch (kind) {
    case "done":
      return /^(?:0|[1-9][0-9]*)$/u.test(ref);
    case "issue":
      return /^#[1-9][0-9]*$/u.test(ref) || isHttpUrl(ref);
    case "defect":
      return ref.length <= 200 && ref.trim() !== "" && !/[\r\n]/u.test(ref);
    case "ask":
      return /^A[1-9][0-9]*$/u.test(ref);
    default:
      return false;
  }
};

/**
 * What a task works towards: `done:<n>` (0-based index into the brief's doneWhen, same as CheckResult.checkIndex),
 * `issue:<url|#n>`, `defect:<one line, at most 200>` or `ask:A<n>`.
 */
export const Serves = Schema.String.check(Schema.makeFilter(isServes, { expected: SERVES_FIX })).annotate({
  identifier: "Serves",
});

export const Tier = Schema.Literals(["S", "M", "L"]);
export type Tier = typeof Tier.Type;

export const Estimate = Schema.Struct({
  rawMinutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  gates: list(text(200), 20),
}).annotate({ identifier: "Estimate" });
export type Estimate = typeof Estimate.Type;

// Research briefs (M9): a pre-registered baseline and a decision rule the hub applies to the judge's numbers.

/**
 * Applied to the improvement: candidate − baseline, negated when lower is better. GO when it is at least `goAtLeast`,
 * STOP when it is below `stopBelow`, INCONCLUSIVE in between. "GO iff candidate − baseline ≥ 0.10, else STOP" is
 * `{ better: "higher", goAtLeast: 0.1, stopBelow: 0.1 }`.
 */
export const DecisionRule = Schema.Struct({
  better: Schema.Literals(["higher", "lower"]),
  goAtLeast: Schema.Finite,
  stopBelow: Schema.Finite,
})
  .check(
    Schema.makeFilter((rule) =>
      rule.stopBelow <= rule.goAtLeast ? undefined : { path: ["stopBelow"], issue: "stopBelow must not be above goAtLeast" },
    ),
  )
  .annotate({ identifier: "DecisionRule" });
export type DecisionRule = typeof DecisionRule.Type;

/** The judge's reported numbers for the brief's metric. */
export const MetricValues = Schema.Struct({ baseline: Schema.Finite, candidate: Schema.Finite }).annotate({
  identifier: "MetricValues",
});
export type MetricValues = typeof MetricValues.Type;

/** STOP is a success: the question was answered. */
export const ResearchOutcome = Schema.Literals(["go", "stop", "inconclusive"]);
export type ResearchOutcome = typeof ResearchOutcome.Type;

export const researchOutcome = (rule: DecisionRule, values: MetricValues): ResearchOutcome => {
  // Float subtraction lands just short of the line (0.6 − 0.5 is 0.0999…), so values on a line count as on it.
  const tolerance = 1e-9 * Math.max(1, Math.abs(values.baseline), Math.abs(values.candidate));
  const improvement = (values.candidate - values.baseline) * (rule.better === "lower" ? -1 : 1) + tolerance;
  if (improvement >= rule.goAtLeast) return "go";
  if (improvement < rule.stopBelow) return "stop";
  return "inconclusive";
};

/** Computed by the hub, never reported by an agent; `outcome` always follows from `rule` and `metricValues`. */
export const ResearchVerdict = Schema.Struct({
  outcome: ResearchOutcome,
  metricValues: MetricValues,
  /** The brief's frozen rule. */
  rule: DecisionRule,
  computedAt: Timestamp,
})
  .check(
    Schema.makeFilter((verdict) => {
      const expected = researchOutcome(verdict.rule, verdict.metricValues);
      return verdict.outcome === expected ? undefined : { path: ["outcome"], issue: `the rule gives ${expected} for these values` };
    }),
  )
  .annotate({ identifier: "ResearchVerdict" });
export type ResearchVerdict = typeof ResearchVerdict.Type;

// Playbooks (M9): versioned templates a workstream pins at creation.

/** The prefixes `bug:`/`fix:`, `research:` and `finish:` pick bugfix, research and finish-all. */
export const PlaybookName = Schema.Literals(["bugfix", "feature", "research", "finish-all"]);
export type PlaybookName = typeof PlaybookName.Type;

/**
 * `<name>@<sha>`: the git blob SHA of the playbook file (`git hash-object <file>`), so a user override outside git
 * pins the same way as the repo's copy.
 */
export const PlaybookRef = Schema.String.check(
  Schema.isPattern(new RegExp(`^(?:${PlaybookName.literals.join("|")})@(?:[0-9a-f]{40}|[0-9a-f]{64})$`, "u")),
).pipe(
  Schema.brand("PlaybookRef"),
  Schema.annotate({ identifier: "PlaybookRef", description: "<playbook name>@<full lowercase hex git blob SHA>" }),
);
export type PlaybookRef = typeof PlaybookRef.Type;

export const Brief = Schema.Struct({
  goal: text(1000),
  why: text(2000),
  pointers: list(text(500), 20),
  constraints: list(text(500), 20),
  /** At least one; frozen with the brief. */
  doneWhen: list(CheckSpec, 20).check(Schema.isMinLength(1)),
  tier: Tier,
  budget: Schema.optionalKey(Schema.Struct({ agentHours: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))) })),
  estimate: Schema.optionalKey(Estimate),
  /** Research: what the candidate is compared against, and how both are measured. */
  baseline: Schema.optionalKey(text(1000)),
  /** Research: the one number the judge reports for baseline and candidate, e.g. "p50 cold start in ms". */
  metric: Schema.optionalKey(text(200).check(Schema.isPattern(/^[^\r\n]*$/u))),
  /** Research: frozen with the brief, so the verdict can't move the goalposts. */
  decisionRule: Schema.optionalKey(DecisionRule),
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
  /** Hub-filled, outside the frozen brief. Set when it starts running with a raw estimate. */
  estimateActual: Schema.optionalKey(
    Schema.Struct({
      /** Wall-clock minutes from running to done; set on done. */
      actualMinutes: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
      /** The tier's calibration ratio when it started running. */
      ratioAtStart: Schema.Finite.check(Schema.isGreaterThan(0)),
    }),
  ),
  /** Pinned at creation; the brief freeze validates against this version. Absent on workstreams from before M9. */
  playbook: Schema.optionalKey(PlaybookRef),
  /** M9 finish-all: the finish-all workstream that spawned this one, and the value source it was spawned for. */
  parent: Schema.optionalKey(Schema.Struct({ workstreamId: WorkstreamId, serves: Serves })),
  /** Research workstreams, once the verdict is computed; set together with `verdict`. A STOP is done, not failed. */
  outcome: Schema.optionalKey(ResearchOutcome),
  verdict: Schema.optionalKey(ResearchVerdict),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
  .check(
    Schema.makeFilter((w) =>
      w.outcome === w.verdict?.outcome ? undefined : { path: ["outcome"], issue: "outcome and verdict come together and agree" },
    ),
  )
  .annotate({ identifier: "Workstream" });
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

/**
 * decide: a product call. do: hand steps for the human, optionally re-checked by `verify`. secret: a value the
 * browser seals to the sink's node. approve: a stored command the node runs after a human tap (`fleetd gated run`).
 */
export const AskKind = Schema.Literals(["decide", "do", "secret", "approve"]);
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

// Approve asks (M8): a command the node runs from these stored bytes, only after a human answers "go".

export const GatedClass = Schema.Literals(["irreversible", "money", "credential"]);
export type GatedClass = typeof GatedClass.Type;

/** A process environment variable name. */
export const EnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)).annotate({ identifier: "EnvName" });

/** `--secret-env NAME=<secret key>`: the node reads the value from that secret's sink; it never crosses the hub. */
export const SecretEnv = list(Schema.Struct({ name: EnvName, secretKey: DecisionKey }), 20).check(
  Schema.makeFilter((entries) => {
    const names = entries.map((entry) => entry.name);
    return new Set(names).size === names.length ? undefined : "each env name at most once";
  }),
);

/** The node runs at most 30 minutes. */
export const GATED_MAX_TIMEOUT_SEC = 1800;
export const GatedTimeoutSec = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: GATED_MAX_TIMEOUT_SEC }));

/** argv only, no shell unless argv itself invokes one; at most 64 entries like a `cmd` check. */
export const GatedArgv = list(Schema.String, 64).check(Schema.isMinLength(1));

/** Absolute; absent means the project workspace. The node refuses a cwd outside its command roots. */
export const GatedCwd = Schema.String.check(Schema.isMaxLength(1000), Schema.isPattern(/^\//u));

/** Stored with the approve ask and never changed: the human approves exactly these bytes. */
export const GatedRunSpec = Schema.Struct({
  argv: GatedArgv,
  cwd: Schema.optionalKey(GatedCwd),
  class: GatedClass,
  reason: text(500),
  secretEnv: Schema.optionalKey(SecretEnv),
  timeoutSec: GatedTimeoutSec,
}).annotate({ identifier: "GatedRunSpec" });
export type GatedRunSpec = typeof GatedRunSpec.Type;

/**
 * Each kind's required field, and no field of another kind: decide needs a recommendation, do at least one step,
 * secret a sink, approve its gated run with the ask's class.
 */
export const askKindRule = Schema.makeFilter(
  (ask: {
    readonly kind: AskKind;
    readonly class?: string;
    readonly recommendation?: string;
    readonly steps?: ReadonlyArray<unknown>;
    readonly sink?: string;
    readonly envName?: string;
    readonly fingerprint?: string;
    readonly gated?: GatedRunSpec;
    readonly verify?: unknown;
  }) => {
    if (ask.kind === "decide" && ask.recommendation === undefined) {
      return { path: ["recommendation"], issue: "a decide ask needs a recommendation" };
    }
    if (ask.kind === "do" && (ask.steps === undefined || ask.steps.length === 0)) {
      return { path: ["steps"], issue: "a do ask needs at least one step" };
    }
    if (ask.kind === "secret" && ask.sink === undefined) return { path: ["sink"], issue: "a secret ask needs a sink" };
    if (ask.kind === "approve" && ask.gated === undefined) return { path: ["gated"], issue: "an approve ask needs its gated run" };
    const only = { sink: "secret", envName: "secret", fingerprint: "secret", gated: "approve", verify: "do" } as const;
    for (const [field, kind] of Object.entries(only) as Array<[keyof typeof only, AskKind]>) {
      if (ask[field] !== undefined && ask.kind !== kind) return { path: [field], issue: `only a ${kind} ask has ${field}` };
    }
    if (ask.envName !== undefined && ask.sink !== undefined && !ask.sink.startsWith("env:")) {
      return { path: ["envName"], issue: "only an env: sink has an env name" };
    }
    if (ask.gated !== undefined && ask.class !== undefined && ask.gated.class !== ask.class) {
      return { path: ["class"], issue: "an approve ask's class is its gated run's class" };
    }
    return undefined;
  },
);

/** Asks with this key prefix ask which project an intent belongs to, so they alone have no project. */
export const UNROUTED_ASK_PREFIX = "intake.route.";

/** Only the router's fallback ask may leave out its project. */
export const askProjectRule = Schema.makeFilter((ask: { readonly projectRef?: ProjectRef; readonly key: string }) =>
  ask.projectRef === undefined && !ask.key.startsWith(UNROUTED_ASK_PREFIX)
    ? { path: ["projectRef"], issue: `only an ${UNROUTED_ASK_PREFIX}* ask may leave out projectRef` }
    : undefined,
);

export const Ask = Schema.Struct({
  askId: AskId,
  /** Absent only on an `intake.route.*` ask: the human picks the project by answering it. */
  projectRef: Schema.optionalKey(ProjectRef),
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
  /** do: the check the hub runs once the human ticks it done; a failure reopens the ask with the evidence. */
  verify: Schema.optionalKey(CheckSpec),
  /** Required for secret. */
  sink: Schema.optionalKey(SecretSink),
  /** secret with an env: sink: the variable it writes, when not the one its key names (`secretEnvName`). */
  envName: Schema.optionalKey(EnvName),
  /** secret: set when the node has written the sink. */
  fingerprint: Schema.optionalKey(SecretFingerprint),
  /** Required for approve; immutable once the ask exists. */
  gated: Schema.optionalKey(GatedRunSpec),
  /** What closed or reopened it: "fingerprint ab12cd34", a gated run's exit code and output tail, a failed verify. */
  evidence: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
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
  .check(askKindRule, askProjectRule)
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
