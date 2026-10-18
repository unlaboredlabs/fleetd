//! M3 ledger objects: leads, workstreams and briefs, asks and batches, decisions.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectRef, ThreadId, Timestamp};
use crate::prim::{
    Count, Finite, Int, Line, List, NonNegative, Positive, PositiveNumber, Text, js_len,
};
use crate::secrets::{SecretFingerprint, SecretSink};
use crate::subscriptions::is_http_url;
use crate::usage::UsageParked;
use crate::{brand, checked};

brand!(
    /// "W" plus a positive integer, unique per hub, e.g. "W12".
    WorkstreamId, name = "WorkstreamId", pattern = r"^W[1-9][0-9]*$"
);
brand!(
    /// "A" plus a positive integer, unique per hub.
    AskId, name = "AskId", pattern = r"^A[1-9][0-9]*$"
);
brand!(
    /// "B" plus a positive integer, unique per hub.
    BatchId, name = "BatchId", pattern = r"^B[1-9][0-9]*$"
);
brand!(
    /// "D" plus a positive integer, unique per hub.
    DecisionId, name = "DecisionId", pattern = r"^D[1-9][0-9]*$"
);

static DECISION_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9]+(\.[a-z0-9_-]+)*$").unwrap());

brand!(
    /// Lowercase dotted slug such as "api.health.path", at most 80 characters.
    DecisionKey,
    name = "DecisionKey",
    check = |s| js_len(s) <= 80 && DECISION_KEY.is_match(s),
    expected = "a lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)*, at most 80",
    pattern = r"^[a-z0-9]+(\.[a-z0-9_-]+)*$",
    description = "Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)*, at most 80"
);

/// One line of status, as shown next to a workstream.
pub type Headline = Line<0, 280>;

// Leads

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LeadState {
    Starting,
    Idle,
    Working,
    Stalled,
    Stopped,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Lead {
    pub project_ref: ProjectRef,
    /// The current lead thread on the project's machine; earlier ones stay in T3 as history.
    pub thread_id: ThreadId,
    pub state: LeadState,
    pub started_at: Timestamp,
    pub last_wake_at: Option<Timestamp>,
    /// Bumped by each lead_restart.
    pub session_generation: Count,
    /// M4: the lead thread hit a usage limit; derived from the usage layer when read.
    pub parked: Option<UsageParked>,
}

// Briefs and their done-when checks

pub type Repo = Text<1, 200>;

brand!(
    /// An absolute http:// or https:// URL.
    HttpUrl, check = |s| is_http_url(s), expected = "an absolute http:// or https:// URL"
);

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CheckSpec {
    PrMerged {
        repo: Repo,
        pr: Option<Positive>,
    },
    CiGreen {
        repo: Repo,
        r#ref: Option<Text<1, 200>>,
    },
    Http {
        url: HttpUrl,
        status: Int<100, 599>,
        contains: Option<Text<1, 500>>,
    },
    Cmd {
        machine_id: MachineId,
        argv: List<String, 1, 64>,
        expect_exit: i64,
    },
    Test {
        repo: Repo,
        test_id: Text<1, 500>,
    },
    Judge {
        criteria: Text<1, 2000>,
    },
    Human {
        question: Text<1, 500>,
    },
}

impl CheckSpec {
    pub fn check_type(&self) -> CheckType {
        match self {
            CheckSpec::PrMerged { .. } => CheckType::PrMerged,
            CheckSpec::CiGreen { .. } => CheckType::CiGreen,
            CheckSpec::Http { .. } => CheckType::Http,
            CheckSpec::Cmd { .. } => CheckType::Cmd,
            CheckSpec::Test { .. } => CheckType::Test,
            CheckSpec::Judge { .. } => CheckType::Judge,
            CheckSpec::Human { .. } => CheckType::Human,
        }
    }
}

/// The `type` of a CheckSpec, as playbooks name them in `requiredChecks`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckType {
    PrMerged,
    CiGreen,
    Http,
    Cmd,
    Test,
    Judge,
    Human,
}

impl CheckType {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckType::PrMerged => "pr_merged",
            CheckType::CiGreen => "ci_green",
            CheckType::Http => "http",
            CheckType::Cmd => "cmd",
            CheckType::Test => "test",
            CheckType::Judge => "judge",
            CheckType::Human => "human",
        }
    }
}

/// What a write task must serve, as `--serves` takes it.
pub const SERVES_FIX: &str =
    "say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | ask:<id>";

static SERVES_DONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:0|[1-9][0-9]*)$").unwrap());
static SERVES_ISSUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#[1-9][0-9]*$").unwrap());
static SERVES_ASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^A[1-9][0-9]*$").unwrap());

pub fn is_serves(serves: &str) -> bool {
    let Some((kind, reference)) = serves.split_once(':') else {
        return false;
    };
    match kind {
        "done" => SERVES_DONE.is_match(reference),
        "issue" => SERVES_ISSUE.is_match(reference) || is_http_url(reference),
        "defect" => {
            js_len(reference) <= 200
                && !reference.trim().is_empty()
                && !reference.contains(['\r', '\n'])
        }
        "ask" => SERVES_ASK.is_match(reference),
        _ => false,
    }
}

brand!(
    /// What a task works towards: `done:<n>` (0-based index into the brief's doneWhen, same as
    /// CheckResult.checkIndex), `issue:<url|#n>`, `defect:<one line, at most 200>` or `ask:A<n>`.
    Serves, name = "Serves", check = is_serves, expected = SERVES_FIX
);

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub enum Tier {
    S,
    M,
    L,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub raw_minutes: NonNegative,
    pub gates: List<Text<1, 200>, 0, 20>,
}

// Research briefs (M9): a pre-registered baseline and a decision rule the hub applies to the judge's numbers.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DecisionRuleBetter {
    Higher,
    Lower,
}

/// Applied to the improvement: candidate − baseline, negated when lower is better. GO when it is at least
/// `goAtLeast`, STOP when it is below `stopBelow`, INCONCLUSIVE in between.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct DecisionRule {
    pub better: DecisionRuleBetter,
    pub go_at_least: Finite,
    pub stop_below: Finite,
}
checked!(DecisionRule, |rule| {
    if rule.stop_below.get() <= rule.go_at_least.get() {
        Ok(())
    } else {
        Err("stopBelow must not be above goAtLeast".into())
    }
});

/// The judge's reported numbers for the brief's metric.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricValues {
    pub baseline: Finite,
    pub candidate: Finite,
}

/// STOP is a success: the question was answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ResearchOutcome {
    Go,
    Stop,
    Inconclusive,
}

impl ResearchOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ResearchOutcome::Go => "go",
            ResearchOutcome::Stop => "stop",
            ResearchOutcome::Inconclusive => "inconclusive",
        }
    }
}

pub fn research_outcome(rule: &DecisionRule, values: &MetricValues) -> ResearchOutcome {
    let (baseline, candidate) = (values.baseline.get(), values.candidate.get());
    // Float subtraction lands just short of the line (0.6 − 0.5 is 0.0999…), so values on a line count as on it.
    let tolerance = 1e-9 * 1f64.max(baseline.abs()).max(candidate.abs());
    let sign = if rule.better == DecisionRuleBetter::Lower {
        -1.0
    } else {
        1.0
    };
    let improvement = (candidate - baseline) * sign + tolerance;
    if improvement >= rule.go_at_least.get() {
        ResearchOutcome::Go
    } else if improvement < rule.stop_below.get() {
        ResearchOutcome::Stop
    } else {
        ResearchOutcome::Inconclusive
    }
}

/// Computed by the hub, never reported by an agent; `outcome` always follows from `rule` and `metricValues`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct ResearchVerdict {
    pub outcome: ResearchOutcome,
    pub metric_values: MetricValues,
    /// The brief's frozen rule.
    pub rule: DecisionRule,
    pub computed_at: Timestamp,
}
checked!(ResearchVerdict, |verdict| {
    let expected = research_outcome(&verdict.rule, &verdict.metric_values);
    if verdict.outcome == expected {
        Ok(())
    } else {
        Err(format!(
            "the rule gives {} for these values",
            expected.as_str()
        ))
    }
});

// Playbooks (M9): versioned templates a workstream pins at creation.

/// The prefixes `bug:`/`fix:`, `research:` and `finish:` pick bugfix, research and finish-all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybookName {
    Bugfix,
    Feature,
    Research,
    FinishAll,
}

impl PlaybookName {
    pub const ALL: [PlaybookName; 4] = [
        PlaybookName::Bugfix,
        PlaybookName::Feature,
        PlaybookName::Research,
        PlaybookName::FinishAll,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PlaybookName::Bugfix => "bugfix",
            PlaybookName::Feature => "feature",
            PlaybookName::Research => "research",
            PlaybookName::FinishAll => "finish-all",
        }
    }
}

brand!(
    /// `<name>@<sha>`: the git blob SHA of the playbook file (`git hash-object <file>`).
    PlaybookRef,
    name = "PlaybookRef",
    pattern = r"^(?:bugfix|feature|research|finish-all)@(?:[0-9a-f]{40}|[0-9a-f]{64})$",
    description = "<playbook name>@<full lowercase hex git blob SHA>"
);

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefBudget {
    pub agent_hours: Option<PositiveNumber>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub goal: Text<1, 1000>,
    pub why: Text<1, 2000>,
    pub pointers: List<Text<1, 500>, 0, 20>,
    pub constraints: List<Text<1, 500>, 0, 20>,
    /// At least one; frozen with the brief.
    pub done_when: List<CheckSpec, 1, 20>,
    pub tier: Tier,
    pub budget: Option<BriefBudget>,
    pub estimate: Option<Estimate>,
    /// Research: what the candidate is compared against, and how both are measured.
    pub baseline: Option<Text<1, 1000>>,
    /// Research: the one number the judge reports for baseline and candidate, e.g. "p50 cold start in ms".
    pub metric: Option<Line<1, 200>>,
    /// Research: frozen with the brief, so the verdict can't move the goalposts.
    pub decision_rule: Option<DecisionRule>,
}

/// A [`Brief`] whose `tier` may be left out, as `fleetd brief create` takes it; the playbook's `tierDefault` fills it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefDraft {
    pub goal: Text<1, 1000>,
    pub why: Text<1, 2000>,
    pub pointers: List<Text<1, 500>, 0, 20>,
    pub constraints: List<Text<1, 500>, 0, 20>,
    pub done_when: List<CheckSpec, 1, 20>,
    pub tier: Option<Tier>,
    pub budget: Option<BriefBudget>,
    pub estimate: Option<Estimate>,
    pub baseline: Option<Text<1, 1000>>,
    pub metric: Option<Line<1, 200>>,
    pub decision_rule: Option<DecisionRule>,
}

impl BriefDraft {
    pub fn into_brief(self, tier: Tier) -> Brief {
        Brief {
            goal: self.goal,
            why: self.why,
            pointers: self.pointers,
            constraints: self.constraints,
            done_when: self.done_when,
            tier: self.tier.unwrap_or(tier),
            budget: self.budget,
            estimate: self.estimate,
            baseline: self.baseline,
            metric: self.metric,
            decision_rule: self.decision_rule,
        }
    }
}

brand!(
    /// sha256 of the brief's canonical JSON, lowercase hex.
    BriefHash, name = "BriefHash", pattern = r"^[0-9a-f]{64}$"
);

// Workstreams

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkstreamState {
    Draft,
    Running,
    Converging,
    Verifying,
    Done,
    Idle,
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IntakeChannel {
    // The removed phone app wrote "phone"; old records read back as the app.
    #[serde(alias = "phone")]
    App,
    Mcp,
    Lead,
}

/// The one-line intent as submitted.
pub type IntakeText = Text<1, 4000>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamSource {
    pub text: IntakeText,
    pub channel: IntakeChannel,
    /// Who submitted it: an agent keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: String,
    pub at: Timestamp,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamEstimateActual {
    /// Wall-clock minutes from running to done; set on done.
    pub actual_minutes: Option<NonNegative>,
    /// The tier's calibration ratio when it started running.
    pub ratio_at_start: PositiveNumber,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamParent {
    pub workstream_id: WorkstreamId,
    pub serves: Serves,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct Workstream {
    pub workstream_id: WorkstreamId,
    pub project_ref: ProjectRef,
    pub title: Text<0, 200>,
    pub source: WorkstreamSource,
    /// Absent while draft.
    pub brief: Option<Brief>,
    pub brief_hash: Option<BriefHash>,
    pub state: WorkstreamState,
    pub headline: Option<Headline>,
    pub headline_at: Option<Timestamp>,
    /// Hub-filled, outside the frozen brief. Set when it starts running with a raw estimate.
    pub estimate_actual: Option<WorkstreamEstimateActual>,
    /// Pinned at creation; the brief freeze validates against this version. Absent on workstreams from before M9.
    pub playbook: Option<PlaybookRef>,
    /// M9 finish-all: the finish-all workstream that spawned this one, and the value source it was spawned for.
    pub parent: Option<WorkstreamParent>,
    /// Research workstreams, once the verdict is computed; set together with `verdict`. A STOP is done, not failed.
    pub outcome: Option<ResearchOutcome>,
    pub verdict: Option<ResearchVerdict>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
checked!(Workstream, |w| {
    if w.outcome == w.verdict.as_ref().map(|v| v.outcome) {
        Ok(())
    } else {
        Err("outcome and verdict come together and agree".into())
    }
});

// Decisions

pub type DecisionValue = Text<1, 2000>;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum DecisionScope {
    Global,
    Project { project_ref: ProjectRef },
    Workstream { workstream_id: WorkstreamId },
}

/// Filled by the hub from the caller: a human device, an agent key, or a lead-side call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DecisionSource {
    Human,
    Lead,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DecisionState {
    Active,
    Superseded,
    Retired,
}

pub type DecisionWhy = Text<1, 2000>;

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub decision_id: DecisionId,
    pub key: DecisionKey,
    pub scope: DecisionScope,
    pub value: DecisionValue,
    pub why: Option<DecisionWhy>,
    pub source: DecisionSource,
    /// Who recorded it: the agent key name, "lead:<machineId>/<projectId>" or "human:<device>".
    pub by: Option<String>,
    /// The ask this answers, when it came from one.
    pub ask_id: Option<AskId>,
    /// The earlier active decision on the same key and scope that this one replaced.
    pub supersedes: Option<DecisionId>,
    pub state: DecisionState,
    pub at: Timestamp,
}

// Asks

/// decide: a product call. do: hand steps for the human, optionally re-checked by `verify`. secret: a value the
/// desktop app seals to the sink's node. approve: a stored command the node runs after a human approves it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    Decide,
    Do,
    Secret,
    Approve,
}

impl AskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AskKind::Decide => "decide",
            AskKind::Do => "do",
            AskKind::Secret => "secret",
            AskKind::Approve => "approve",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AskClass {
    Product,
    Money,
    Credential,
    Irreversible,
}

impl AskClass {
    pub fn as_str(self) -> &'static str {
        match self {
            AskClass::Product => "product",
            AskClass::Money => "money",
            AskClass::Credential => "credential",
            AskClass::Irreversible => "irreversible",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AskState {
    Open,
    Auto,
    Answered,
    Defaulted,
    Withdrawn,
}

pub type AskText = Text<1, 500>;

/// `<name>`-style placeholders: "<" and ">" with no space just inside, so `sort < a > b` passes.
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^\s<>](?:[^<>]*[^\s<>])?>").unwrap());

brand!(
    /// A shell command a human runs verbatim; placeholders such as `<token>` are refused.
    StepCommand,
    check = |s| (1..=2000).contains(&js_len(s)) && !PLACEHOLDER.is_match(s),
    expected = "an exact command with no <placeholders>; write the real value or make it a separate step"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum StepPlace {
    Browser,
}

// A "phone" stored before the phone app's removal reads back as a machine id.
/// A machineId or "browser".
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum StepWhere {
    Place(StepPlace),
    Machine(MachineId),
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub text: Text<1, 500>,
    pub r#where: StepWhere,
    pub command: Option<StepCommand>,
    /// What the human should see when the step worked.
    pub expect: Option<Text<1, 500>>,
}

/// "nothing", or the step the lead is holding back until this is answered.
pub type AskBlocks = Text<1, 200>;

pub fn ask_blocks_nothing() -> AskBlocks {
    Text::unchecked("nothing")
}

pub type AskOptions = List<DecisionValue, 0, 6>;
pub type AskSteps = List<Step, 0, 20>;

// Approve asks (M8): a command the node runs from these stored bytes, only after a human answers "go".

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GatedClass {
    Irreversible,
    Money,
    Credential,
}

impl GatedClass {
    pub fn as_str(self) -> &'static str {
        match self {
            GatedClass::Irreversible => "irreversible",
            GatedClass::Money => "money",
            GatedClass::Credential => "credential",
        }
    }
}

brand!(
    /// A process environment variable name.
    EnvName, name = "EnvName", pattern = r"^[A-Za-z_][A-Za-z0-9_]{0,127}$"
);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretEnvEntry {
    pub name: EnvName,
    pub secret_key: DecisionKey,
}

/// `--secret-env NAME=<secret key>`: the node reads the value from that secret's sink; it never crosses the hub.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct SecretEnv(pub List<SecretEnvEntry, 0, 20>);

impl SecretEnv {
    pub fn new(entries: Vec<SecretEnvEntry>) -> Result<Self, String> {
        let list = List::new(entries)?;
        if list
            .iter()
            .enumerate()
            .any(|(i, entry)| list[..i].iter().any(|earlier| earlier.name == entry.name))
        {
            return Err("each env name at most once".into());
        }
        Ok(Self(list))
    }
}

impl std::ops::Deref for SecretEnv {
    type Target = Vec<SecretEnvEntry>;
    fn deref(&self) -> &Vec<SecretEnvEntry> {
        &self.0
    }
}

impl Serialize for SecretEnv {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

impl<'de> Deserialize<'de> for SecretEnv {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(Vec::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for SecretEnv {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "SecretEnv".into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        List::<SecretEnvEntry, 0, 20>::json_schema(generator)
    }
}

/// The node runs at most 30 minutes.
pub const GATED_MAX_TIMEOUT_SEC: i64 = 1800;
pub type GatedTimeoutSec = Int<1, GATED_MAX_TIMEOUT_SEC>;

/// argv only, no shell unless argv itself invokes one; at most 64 entries like a `cmd` check.
pub type GatedArgv = List<String, 1, 64>;

brand!(
    /// Absolute; absent means the project workspace. The node refuses a cwd outside its command roots.
    GatedCwd,
    check = |s| js_len(s) <= 1000 && s.starts_with('/'),
    expected = "an absolute path of at most 1000 characters",
    pattern = r"^/"
);

/// Stored with the approve ask and never changed: the human approves exactly these bytes.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedRunSpec {
    pub argv: GatedArgv,
    pub cwd: Option<GatedCwd>,
    pub class: GatedClass,
    pub reason: Text<1, 500>,
    pub secret_env: Option<SecretEnv>,
    pub timeout_sec: GatedTimeoutSec,
}

/// Each kind's required field, and no field of another kind: decide needs a recommendation, do at least one step,
/// secret a sink, approve its gated run with the ask's class. The bools say whether that field is present.
#[allow(clippy::too_many_arguments)]
pub fn ask_kind_rule(
    kind: AskKind,
    class: Option<&str>,
    recommendation: bool,
    steps_len: Option<usize>,
    sink: Option<&str>,
    env_name: bool,
    fingerprint: bool,
    gated: Option<&GatedRunSpec>,
    verify: bool,
) -> Result<(), String> {
    if kind == AskKind::Decide && !recommendation {
        return Err("a decide ask needs a recommendation".into());
    }
    if kind == AskKind::Do && steps_len.unwrap_or(0) == 0 {
        return Err("a do ask needs at least one step".into());
    }
    if kind == AskKind::Secret && sink.is_none() {
        return Err("a secret ask needs a sink".into());
    }
    if kind == AskKind::Approve && gated.is_none() {
        return Err("an approve ask needs its gated run".into());
    }
    let only = [
        ("sink", sink.is_some(), AskKind::Secret),
        ("envName", env_name, AskKind::Secret),
        ("fingerprint", fingerprint, AskKind::Secret),
        ("gated", gated.is_some(), AskKind::Approve),
        ("verify", verify, AskKind::Do),
    ];
    for (field, present, only_kind) in only {
        if present && kind != only_kind {
            return Err(format!("only a {} ask has {field}", only_kind.as_str()));
        }
    }
    if env_name && sink.is_some_and(|sink| !sink.starts_with("env:")) {
        return Err("only an env: sink has an env name".into());
    }
    if let (Some(gated), Some(class)) = (gated, class)
        && gated.class.as_str() != class
    {
        return Err("an approve ask's class is its gated run's class".into());
    }
    Ok(())
}

/// Asks with this key prefix ask which project an intent belongs to, so they alone have no project.
pub const UNROUTED_ASK_PREFIX: &str = "intake.route.";

/// M12: the retro's gate-change asks, `playbook.<name>.<hash>`. Playbooks are hub-wide, so these have no project either.
pub const PLAYBOOK_ASK_PREFIX: &str = "playbook.";

/// Asks that may leave out their project: the router's fallback and the retro's gate changes.
pub fn is_hub_ask_key(key: &str) -> bool {
    key.starts_with(UNROUTED_ASK_PREFIX) || key.starts_with(PLAYBOOK_ASK_PREFIX)
}

/// Only the router's fallback ask and the retro's gate asks may leave out their project.
pub fn ask_project_rule(project_ref: Option<&ProjectRef>, key: &str) -> Result<(), String> {
    if project_ref.is_none() && !is_hub_ask_key(key) {
        return Err(format!(
            "only an {UNROUTED_ASK_PREFIX}* or {PLAYBOOK_ASK_PREFIX}* ask may leave out projectRef"
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswer {
    pub value: String,
    pub by: String,
    pub at: Timestamp,
    /// The reply text it was parsed from.
    pub raw: String,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct Ask {
    pub ask_id: AskId,
    /// Absent only on an `intake.route.*` ask: the human picks the project by answering it.
    pub project_ref: Option<ProjectRef>,
    pub workstream_id: Option<WorkstreamId>,
    pub kind: AskKind,
    pub key: DecisionKey,
    pub class: AskClass,
    pub text: AskText,
    pub options: Option<AskOptions>,
    /// Required for decide.
    pub recommendation: Option<DecisionValue>,
    /// Required for do.
    pub steps: Option<AskSteps>,
    /// do: the check the hub runs once the human ticks it done; a failure reopens the ask with the evidence.
    pub verify: Option<CheckSpec>,
    /// Required for secret.
    pub sink: Option<SecretSink>,
    /// secret with an env: sink: the variable it writes, when not the one its key names (`secretEnvName`).
    pub env_name: Option<EnvName>,
    /// secret: set when the node has written the sink.
    pub fingerprint: Option<SecretFingerprint>,
    /// Required for approve; immutable once the ask exists.
    pub gated: Option<GatedRunSpec>,
    /// What closed or reopened it: "fingerprint ab12cd34", a gated run's exit code and output tail, a failed verify.
    pub evidence: Option<Text<0, 2000>>,
    pub blocks: AskBlocks,
    /// The lead carried on with the recommendation; the answer confirms or overrides it.
    pub proceeded_on_rec: bool,
    pub state: AskState,
    pub batch_id: Option<BatchId>,
    /// Fixed within its batch; never renumbered.
    pub number: Option<Positive>,
    pub answer: Option<AskAnswer>,
    pub decision_id: Option<DecisionId>,
    pub created_at: Timestamp,
}
checked!(Ask, |ask| {
    ask_kind_rule(
        ask.kind,
        Some(ask.class.as_str()),
        ask.recommendation.is_some(),
        ask.steps.as_ref().map(|steps| steps.len()),
        ask.sink.as_ref().map(|sink| sink.as_str()),
        ask.env_name.is_some(),
        ask.fingerprint.is_some(),
        ask.gated.as_ref(),
        ask.verify.is_some(),
    )?;
    ask_project_rule(ask.project_ref.as_ref(), ask.key.as_str())
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BatchState {
    Open,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub number: Positive,
    pub ask_id: AskId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub batch_id: BatchId,
    pub created_at: Timestamp,
    pub items: Vec<BatchItem>,
    pub state: BatchState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn accepts<T: serde::de::DeserializeOwned>(value: Value) -> bool {
        serde_json::from_value::<T>(value).is_ok()
    }

    #[test]
    fn decision_keys_are_lowercase_dotted_slugs_up_to_80() {
        for key in [
            "api",
            "api.health.path",
            "pref.dark_mode",
            "a1.b-2",
            &format!("a.{}", "x".repeat(78)),
        ] {
            assert!(DecisionKey::new(key).is_ok(), "{key}");
        }
        for key in [
            "",
            "Api",
            "api.",
            ".api",
            "api..path",
            "_api",
            "api-x.y",
            "api path",
            &format!("a.{}", "x".repeat(79)),
        ] {
            assert!(DecisionKey::new(key).is_err(), "{key}");
        }
    }

    #[test]
    fn hub_serial_ids_are_the_prefix_plus_a_positive_integer() {
        for id in ["W1", "W12"] {
            assert!(WorkstreamId::new(id).is_ok());
        }
        for id in ["W0", "W01", "w1", "A1", "W", "W1x"] {
            assert!(WorkstreamId::new(id).is_err(), "{id}");
        }
    }

    #[test]
    fn step_commands_refuse_placeholders_but_allow_redirects() {
        let step =
            |command: &str| json!({ "text": "run it", "where": "forge", "command": command });
        for command in [
            "export TOKEN=<token>",
            "curl <your api url>",
            "gh secret set X -b <VALUE>",
        ] {
            assert!(!accepts::<Step>(step(command)), "{command}");
        }
        for command in [
            "sort < in.txt > out.txt",
            "echo hi 2>&1",
            "diff <(ls a) <(ls b)",
            "cat <<EOF > f",
            "test 1 -lt 2",
        ] {
            assert!(accepts::<Step>(step(command)), "{command}");
        }
        assert!(accepts::<Step>(json!({ "text": "t", "where": "browser" })));
        assert!(!accepts::<Step>(json!({ "text": "t", "where": "My Mac" })));
    }

    #[test]
    fn serves_formats() {
        for ok in [
            "done:0",
            "done:12",
            "issue:#3",
            "issue:https://github.com/o/r/issues/3",
            "defect:login 500s",
            "ask:A1",
        ] {
            assert!(is_serves(ok), "{ok}");
        }
        for bad in [
            "done:01",
            "done:-1",
            "issue:#0",
            "issue:3",
            "defect:",
            "defect:   ",
            "defect:a\nb",
            "ask:A0",
            "nope:1",
            "done",
        ] {
            assert!(!is_serves(bad), "{bad}");
        }
        assert!(!is_serves(&format!("defect:{}", "x".repeat(201))));
    }

    #[test]
    fn research_outcome_counts_values_on_the_line() {
        let rule = |better: DecisionRuleBetter, go: f64, stop: f64| DecisionRule {
            better,
            go_at_least: Finite::unchecked(go),
            stop_below: Finite::unchecked(stop),
        };
        let values = |baseline: f64, candidate: f64| MetricValues {
            baseline: Finite::unchecked(baseline),
            candidate: Finite::unchecked(candidate),
        };
        // 0.6 − 0.5 is 0.0999… in floats.
        assert_eq!(
            research_outcome(
                &rule(DecisionRuleBetter::Higher, 0.1, 0.1),
                &values(0.5, 0.6)
            ),
            ResearchOutcome::Go
        );
        assert_eq!(
            research_outcome(
                &rule(DecisionRuleBetter::Higher, 0.1, 0.1),
                &values(0.5, 0.55)
            ),
            ResearchOutcome::Stop
        );
        assert_eq!(
            research_outcome(
                &rule(DecisionRuleBetter::Higher, 0.2, 0.0),
                &values(0.5, 0.6)
            ),
            ResearchOutcome::Inconclusive
        );
        // Lower is better: 100 ms down to 80 ms is an improvement of 20.
        assert_eq!(
            research_outcome(
                &rule(DecisionRuleBetter::Lower, 20.0, 0.0),
                &values(100.0, 80.0)
            ),
            ResearchOutcome::Go
        );
        assert_eq!(
            research_outcome(
                &rule(DecisionRuleBetter::Lower, 20.0, 0.0),
                &values(100.0, 120.0)
            ),
            ResearchOutcome::Stop
        );
        assert!(!accepts::<DecisionRule>(
            json!({ "better": "higher", "goAtLeast": 0.1, "stopBelow": 0.2 })
        ));
    }

    fn ask() -> Value {
        json!({
            "askId": "A1",
            "projectRef": { "machineId": "forge", "projectId": "p1" },
            "kind": "decide",
            "key": "api.health.path",
            "class": "product",
            "text": "Path?",
            "recommendation": "/healthz",
            "blocks": "nothing",
            "proceededOnRec": true,
            "state": "open",
            "createdAt": "2026-10-17T10:00:00.000Z",
        })
    }

    fn with(mut value: Value, patch: Value) -> Value {
        for (key, field) in patch.as_object().unwrap() {
            if field.is_null() {
                value.as_object_mut().unwrap().remove(key);
            } else {
                value[key] = field.clone();
            }
        }
        value
    }

    #[test]
    fn ask_records_hold_the_kind_rule_and_a_closed_class_list() {
        assert!(accepts::<Ask>(ask()));
        let no_rec = with(ask(), json!({ "recommendation": null }));
        assert!(!accepts::<Ask>(no_rec.clone()));
        assert!(accepts::<Ask>(with(
            no_rec.clone(),
            json!({ "kind": "do", "steps": [{ "text": "Tick the box", "where": "browser" }] })
        )));
        assert!(!accepts::<Ask>(with(
            no_rec,
            json!({ "kind": "do", "steps": [] })
        )));
        assert!(!accepts::<Ask>(with(ask(), json!({ "class": "naming" }))));
        // A sink only on a secret ask, and an env name only with an env: sink.
        assert!(!accepts::<Ask>(with(
            ask(),
            json!({ "sink": "env:forge:/srv/app/.env" })
        )));
        let secret = with(
            ask(),
            json!({ "kind": "secret", "recommendation": null, "sink": "file:forge:/srv/app/key" }),
        );
        assert!(accepts::<Ask>(secret.clone()));
        assert!(!accepts::<Ask>(with(
            secret,
            json!({ "envName": "API_KEY" })
        )));
    }

    #[test]
    fn ask_records_leave_out_project_only_on_hub_keys() {
        let unrouted = with(ask(), json!({ "projectRef": null }));
        assert!(!accepts::<Ask>(unrouted.clone()));
        assert!(accepts::<Ask>(with(
            unrouted,
            json!({ "key": "intake.route.tidy-the-docs-1a2b3c" })
        )));
        assert!(accepts::<Ask>(with(
            ask(),
            json!({ "key": "intake.route.tidy-the-docs-1a2b3c" })
        )));
    }

    #[test]
    fn briefs_need_a_done_when_check_and_a_tier() {
        let brief = json!({
            "goal": "g", "why": "w", "pointers": [], "constraints": [], "tier": "S",
            "doneWhen": [{ "type": "http", "url": "http://127.0.0.1:4790/health", "status": 200 }],
        });
        assert!(accepts::<Brief>(brief.clone()));
        assert!(!accepts::<Brief>(with(
            brief.clone(),
            json!({ "doneWhen": [] })
        )));
        assert!(!accepts::<Brief>(with(
            brief.clone(),
            json!({ "tier": "XL" })
        )));
        assert!(!accepts::<Brief>(with(
            brief.clone(),
            json!({ "doneWhen": [{ "type": "cmd", "machineId": "forge", "argv": [], "expectExit": 0 }] })
        )));
        assert!(!accepts::<Brief>(with(
            brief.clone(),
            json!({ "doneWhen": [{ "type": "http", "url": "file:///etc/passwd", "status": 200 }] })
        )));
        assert!(!accepts::<Brief>(with(
            brief,
            json!({ "doneWhen": [{ "type": "nope" }] })
        )));
    }

    #[test]
    fn secret_env_names_are_unique() {
        let entry = |name: &str| json!({ "name": name, "secretKey": "stripe.key" });
        assert!(accepts::<SecretEnv>(json!([entry("A"), entry("B")])));
        assert!(!accepts::<SecretEnv>(json!([entry("A"), entry("A")])));
    }

    #[test]
    fn records_from_the_phone_app_still_decode() {
        assert_eq!(
            serde_json::from_value::<IntakeChannel>(json!("phone")).unwrap(),
            IntakeChannel::App
        );
        assert_eq!(
            serde_json::to_value(IntakeChannel::App).unwrap(),
            json!("app")
        );
        assert!(accepts::<Step>(json!({ "text": "t", "where": "phone" })));
    }
}
