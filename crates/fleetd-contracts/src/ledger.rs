//! M3 ledger objects: leads, workstreams and briefs, asks and batches, decisions.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectRef, ThreadId, Timestamp};
use crate::prim::{
    Count, Finite, Int, Line, List, NonEmpty, NonNegative, Positive, PositiveNumber, Text,
    is_http_url, js_len,
};
use crate::secrets::{SecretFingerprint, SecretSink};
use crate::usage::UsageParked;
use crate::{brand, checked};

brand!(
    /// "W" plus a positive integer, unique per hub, e.g. "W12".
    WorkstreamId, name = "WorkstreamId", pattern = r"^W[1-9][0-9]*$"
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
    /// The current lead thread on the project's machine; earlier ones stay on the node as history.
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

/// What a finish-all child serves, as `workstream spawn --serves` takes it.
pub const SERVES_FIX: &str =
    "say what this serves: serves done:<n> | issue:<ref> | defect:<text> | decision:<key>";

static SERVES_DONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:0|[1-9][0-9]*)$").unwrap());
static SERVES_ISSUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#[1-9][0-9]*$").unwrap());

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
        "decision" => js_len(reference) <= 80 && DECISION_KEY.is_match(reference),
        _ => false,
    }
}

brand!(
    /// The item a finish-all child works on: `done:<n>` (0-based index into the brief's doneWhen, same as
    /// CheckResult.checkIndex), `issue:<url|#n>`, `defect:<one line, at most 200>` or `decision:<key>`.
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
    /// The brief's rule.
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
    /// How big a research spend the lead allows, relative like plan sizes; never a time guess.
    pub size: Option<Tier>,
    /// Older briefs only; a lead now gives `size`.
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
    /// At least one.
    pub done_when: List<CheckSpec, 1, 20>,
    pub tier: Tier,
    pub budget: Option<BriefBudget>,
    pub estimate: Option<Estimate>,
    /// Research: what the candidate is compared against, and how both are measured.
    pub baseline: Option<Text<1, 1000>>,
    /// Research: the one number the judge reports for baseline and candidate, e.g. "p50 cold start in ms".
    pub metric: Option<Line<1, 200>>,
    /// Research: the rule the verdict is computed from.
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
    pub state: WorkstreamState,
    pub headline: Option<Headline>,
    pub headline_at: Option<Timestamp>,
    /// Hub-filled, outside the frozen brief. Set when it starts running with a raw estimate.
    pub estimate_actual: Option<WorkstreamEstimateActual>,
    /// Pinned at creation; the brief validates against this version. Absent on workstreams from before M9.
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
    /// The earlier active decision on the same key and scope that this one replaced.
    pub supersedes: Option<DecisionId>,
    pub state: DecisionState,
    pub at: Timestamp,
}

// Asks

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

/// A retro playbook change that relaxes a gate (fewer reviewers, a weaker or removed check, a looser rule). The retro is
/// gone: only an older approval carries one, and the app still shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookGateChange {
    /// The retro proposal, R<n>.
    pub proposal_id: Line<1, 20>,
    pub playbook: Line<1, 40>,
    /// The change in plain words, rendered by the hub for the person: "Bugfixes, medium-size work: reviewers 1 → 0".
    /// The app shows it as the item's label; `diff` only behind expand or copy.
    pub summary: Text<1, 500>,
    /// The exact unified diff that applies on approve.
    pub diff: Text<1, 8000>,
}

/// Stored with the approval and never changed: the human approves exactly these bytes.
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

/// An approval raised by a session's tool permission prompt instead of a gated command: answering it answers the prompt
/// on the project's node. Its machine is the request's project's.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolPermission {
    pub thread_id: ThreadId,
    pub request_id: NonEmpty,
    pub tool_name: NonEmpty,
    /// The command, the path, or the tool's own description.
    pub summary: Text<0, 2000>,
}

/// What a lead needs a person for that chat can't carry safely: a secret value (entered in a masked field and sealed to
/// the sink's node, never in a transcript), or an approval of a risky command (a gated run, or a session's tool
/// prompt). The lead asks everything else in chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    Secret,
    Approval,
}

/// The state names of the chat items that show it (`SecretRequestState`, `CommandApprovalState`). secret: open →
/// stored | withdrawn. approval: open → approved → ran | failed, or open → denied; an approval the node could not run
/// goes back to open with the reason in `evidence`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestState {
    Open,
    Stored,
    Withdrawn,
    Approved,
    Denied,
    Ran,
    Failed,
}

impl RequestState {
    pub fn as_str(self) -> &'static str {
        match self {
            RequestState::Open => "open",
            RequestState::Stored => "stored",
            RequestState::Withdrawn => "withdrawn",
            RequestState::Approved => "approved",
            RequestState::Denied => "denied",
            RequestState::Ran => "ran",
            RequestState::Failed => "failed",
        }
    }

    /// Nothing more happens to it.
    pub fn is_final(self) -> bool {
        !matches!(self, RequestState::Open | RequestState::Approved)
    }
}

/// A secret request: the secret's name and where the node writes it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequest {
    /// The secret's name, a dotted slug such as "stripe.test_key".
    pub key: DecisionKey,
    pub sink: SecretSink,
    /// An env: sink's variable, when not the one the key names (`secret_env_name`).
    pub env_name: Option<EnvName>,
    /// Set once the node has written the sink; the value itself never reaches the hub in plain text.
    pub fingerprint: Option<SecretFingerprint>,
}

/// One human request, as stored and as every client shows it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct HumanRequest {
    pub request_id: crate::chat::ChatRequestId,
    pub project_ref: ProjectRef,
    pub workstream_id: Option<WorkstreamId>,
    pub kind: RequestKind,
    /// One line on why the lead needs it.
    pub text: Text<1, 500>,
    pub state: RequestState,
    /// secret only.
    pub secret: Option<SecretRequest>,
    /// approval of a gated run: exactly the bytes the node runs.
    pub gated: Option<GatedRunSpec>,
    /// approval of a session's tool prompt, instead of a gated run.
    pub permission: Option<ToolPermission>,
    /// approval of a retro playbook change (an older approval only), instead of a gated run or a tool prompt.
    pub playbook: Option<PlaybookGateChange>,
    /// What happened, in one line: "fingerprint ab12cd34", "exit 0 on devbox, approved by human:desk", or why it did
    /// not run (and so is open again).
    pub evidence: Option<Text<0, 2000>>,
    /// An approval that ran: its exit code (absent when a signal or the timeout ended it) and the end of its output,
    /// with every injected secret value scrubbed.
    pub exit_code: Option<i64>,
    pub output_tail: Option<Text<0, 2000>>,
    pub created_at: Timestamp,
    pub answered_at: Option<Timestamp>,
    /// "human:<device>".
    pub answered_by: Option<String>,
}
checked!(HumanRequest, |r| request_kind_rule(r));

/// Each kind carries its own fields only: a secret its `secret`; an approval exactly one of `gated`, `permission` and
/// `playbook`.
pub fn request_kind_rule(r: &HumanRequest) -> Result<(), String> {
    match r.kind {
        RequestKind::Secret => {
            if r.secret.is_none()
                || r.gated.is_some()
                || r.permission.is_some()
                || r.playbook.is_some()
            {
                return Err("a secret request has a secret and nothing else".into());
            }
            if let Some(secret) = &r.secret
                && secret.env_name.is_some()
                && !secret.sink.starts_with("env:")
            {
                return Err("only an env: sink has an env name".into());
            }
        }
        RequestKind::Approval => {
            let subjects = [
                r.gated.is_some(),
                r.permission.is_some(),
                r.playbook.is_some(),
            ];
            if r.secret.is_some() || subjects.iter().filter(|s| **s).count() != 1 {
                return Err("an approval has exactly one of a gated run, a tool prompt or a playbook change".into());
            }
        }
    }
    let allowed: &[RequestState] = match r.kind {
        RequestKind::Secret => &[
            RequestState::Open,
            RequestState::Stored,
            RequestState::Withdrawn,
        ],
        RequestKind::Approval => &[
            RequestState::Open,
            RequestState::Approved,
            RequestState::Denied,
            RequestState::Ran,
            RequestState::Failed,
        ],
    };
    if !allowed.contains(&r.state) {
        return Err(format!(
            "a {:?} request is never {}",
            r.kind,
            r.state.as_str()
        ));
    }
    Ok(())
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
    fn serves_formats() {
        for ok in [
            "done:0",
            "done:12",
            "issue:#3",
            "issue:https://github.com/o/r/issues/3",
            "defect:login 500s",
            "decision:share.link",
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
            "ask:A1",
            "decision:Not A Key",
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

    fn with(mut value: Value, patch: Value) -> Value {
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        value
    }

    fn request(kind: &str, extra: Value) -> Value {
        let mut value = json!({
            "requestId": "Q1", "projectRef": { "machineId": "devbox", "projectId": "p1" }, "kind": kind,
            "text": "Need it to deploy", "state": "open", "createdAt": "2026-10-19T09:00:00.000Z",
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    }

    #[test]
    fn a_request_carries_its_own_kinds_fields_and_states_only() {
        let secret =
            json!({ "secret": { "key": "stripe.test_key", "sink": "env:devbox:/srv/app/.env" } });
        let gated = json!({ "gated": { "argv": ["./deploy.sh"], "class": "irreversible", "reason": "prod deploy", "timeoutSec": 60 } });
        assert!(accepts::<HumanRequest>(request("secret", secret.clone())));
        assert!(accepts::<HumanRequest>(request("approval", gated.clone())));
        assert!(
            !accepts::<HumanRequest>(request("secret", gated.clone())),
            "a secret has no command"
        );
        assert!(
            !accepts::<HumanRequest>(request("approval", json!({}))),
            "an approval names what it approves"
        );
        let mut stored = request("approval", gated);
        stored["state"] = "stored".into();
        assert!(
            !accepts::<HumanRequest>(stored),
            "an approval is never stored"
        );
        let mut file_env = request("secret", secret);
        file_env["secret"]["sink"] = "file:devbox:/srv/key".into();
        file_env["secret"]["envName"] = "KEY".into();
        assert!(
            !accepts::<HumanRequest>(file_env),
            "only an env: sink has an env name"
        );
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
            json!({ "doneWhen": [{ "type": "cmd", "machineId": "devbox", "argv": [], "expectExit": 0 }] })
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
}
