//! The hub's app WebSocket messages and the tool inputs/outputs the app uses, mirroring
//! `packages/contracts`. `schema_check` tests every type here against the exported JSON Schemas, so a
//! contract change that these types don't follow fails `cargo test`.
//!
//! Status enums end in an `Other` variant so a newer hub with more states doesn't break parsing. Under
//! test, structs deny unknown fields so the drift check also catches fields we don't model.

use serde::{Deserialize, Serialize};
use serde_json::Value;

macro_rules! contract {
    ($(#[$m:meta])* pub struct $name:ident { $($body:tt)* }) => {
        $(#[$m])*
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[cfg_attr(test, serde(deny_unknown_fields))]
        pub struct $name { $($body)* }
    };
}

macro_rules! literals {
    ($(#[$m:meta])* pub enum $name:ident { $($variant:ident = $lit:literal),* $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $lit)] $variant,)*
            /// A value this build doesn't know (a newer hub).
            #[serde(other)]
            Other,
        }
        impl $name {
            #[allow(dead_code)]
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $lit,)* Self::Other => "?" }
            }
        }
    };
}

// ---- App WebSocket frames -------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub enum ClientMessage {
    Auth { key: String },
    Snapshot,
    Events { cursor: u64 },
    Call { id: String, tool: String, input: Value },
    /// Redeem a device pairing token for a human key (M8); the phone PWA uses it, this app not yet.
    #[serde(rename = "device_pair")]
    DevicePair { token: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerMessage {
    Ready(Ready),
    Snapshot(FleetStatus),
    Event(HubEvent),
    Result(CallResult),
    Error(ErrorFrame),
    #[serde(rename = "device_paired")]
    DevicePaired(DevicePaired),
}

contract! { pub struct Ready { pub protocol: u64 } }

contract! { pub struct DevicePaired { pub key: String, pub key_id: String } }

contract! {
    pub struct FleetStatus {
        pub machines: Vec<Machine>,
        pub projects: Vec<ProjectSummary>,
        pub attention: Vec<HubEvent>,
        pub cursor: u64,
        /// The slot board (M5). Opaque until a screen shows it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub slots: Option<Value>,
    }
}

contract! { pub struct CallResult { pub id: String, pub output: Value } }

contract! {
    pub struct ErrorFrame {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub id: Option<String>,
        pub code: ErrorCode,
        pub message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub fix: Option<String>,
    }
}

literals! {
    pub enum ErrorCode {
        MachineOffline = "machine_offline",
        NotFound = "not_found",
        Forbidden = "forbidden",
        Invalid = "invalid",
        T3Error = "t3_error",
    }
}

// ---- Fleet model ----------------------------------------------------------------------------

contract! {
    pub struct HubEvent {
        pub seq: u64,
        pub at: String,
        /// Kept as text: new event types arrive with every milestone.
        #[serde(rename = "type")]
        pub kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub machine_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub project_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thread_id: Option<String>,
        pub summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub data: Option<Value>,
    }
}

literals! {
    pub enum MachineStatus { Online = "online", Offline = "offline", Degraded = "degraded" }
}

contract! {
    pub struct Machine {
        pub machine_id: String,
        pub name: String,
        pub tags: Vec<String>,
        pub status: MachineStatus,
        pub last_seen_at: String,
        pub t3: Option<T3Info>,
        pub node_version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub degraded_reason: Option<String>,
        /// The node's X25519 key for sealed secrets (M8).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub box_pub_key: Option<String>,
    }
}

contract! { pub struct T3Info { pub version: String, pub protocol: i64 } }

contract! { pub struct ThreadCounts { pub running: u64, pub waiting: u64, pub idle: u64, pub failed: u64 } }

contract! {
    pub struct TaskCounts { pub queued: u64, pub running: u64, pub idle: u64, pub done: u64, pub failed: u64, pub cancelled: u64 }
}

contract! {
    pub struct ProjectSummary {
        pub machine_id: String,
        pub project_id: String,
        pub title: String,
        pub workspace_root: String,
        pub threads: ThreadCounts,
        pub last_activity_at: String,
    }
}

literals! {
    pub enum ThreadStatus {
        Running = "running",
        Waiting = "waiting",
        Idle = "idle",
        Completed = "completed",
        Failed = "failed",
        Interrupted = "interrupted",
        Cancelled = "cancelled",
    }
}

contract! { pub struct ThreadError { pub class: String, pub message: String } }

contract! {
    pub struct ThreadSummary {
        pub machine_id: String,
        pub thread_id: String,
        pub project_id: String,
        pub title: String,
        pub status: ThreadStatus,
        pub headline: String,
        pub latest_message_tail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub last_error: Option<ThreadError>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub usage_limit_reset_at: Option<String>,
        pub last_progress_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        pub stale: bool,
        pub as_of: String,
    }
}

contract! { pub struct ProjectRef { pub machine_id: String, pub project_id: String } }

contract! {
    pub struct ProjectOutcome {
        pub project: ProjectSummary,
        pub threads: Vec<ThreadSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub lead: Option<Lead>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub workstreams: Option<Vec<Workstream>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub task_counts: Option<TaskCounts>,
        /// Task records as the hub sends them; the app does not show tasks yet.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tasks: Option<Vec<Value>>,
        /// Merge trains as the hub sends them; the app does not show them yet.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub trains: Option<Vec<Value>>,
        pub stale: bool,
        pub as_of: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub next: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub truncated: Option<bool>,
    }
}

// ---- Ledger ---------------------------------------------------------------------------------

literals! {
    pub enum LeadState { Starting = "starting", Idle = "idle", Working = "working", Stalled = "stalled", Stopped = "stopped" }
}

contract! {
    pub struct Lead {
        pub project_ref: ProjectRef,
        pub thread_id: String,
        pub state: LeadState,
        pub started_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub last_wake_at: Option<String>,
        pub session_generation: u64,
        /// M4: the lead thread hit a usage limit and waits for its reset.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub parked: Option<UsageParked>,
    }
}

literals! {
    pub enum UsageClass { UsageLimit = "usage_limit", RateLimit = "rate_limit", PoolExhausted = "pool_exhausted" }
}

contract! {
    pub struct UsageParked {
        pub class: UsageClass,
        pub since: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub resume_at: Option<String>,
    }
}

literals! {
    pub enum WorkstreamState {
        Draft = "draft",
        Running = "running",
        Converging = "converging",
        Verifying = "verifying",
        Done = "done",
        Idle = "idle",
        Stopped = "stopped",
        Failed = "failed",
    }
}

contract! {
    pub struct Workstream {
        pub workstream_id: String,
        pub project_ref: ProjectRef,
        pub title: String,
        pub source: IntakeSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub brief: Option<Brief>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub brief_hash: Option<String>,
        pub state: WorkstreamState,
        /// Estimate calibration (M6); not shown yet.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub estimate_actual: Option<EstimateActual>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub headline: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub headline_at: Option<String>,
        /// `<name>@<sha>`, pinned at creation (M9).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub playbook: Option<String>,
        /// The finish-all workstream that spawned this one, and what it serves there (M9).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub parent: Option<WorkstreamParent>,
        /// Research verdict outcome: go, stop or inconclusive (M9).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub outcome: Option<String>,
        /// The computed research verdict as the hub sends it; not shown yet.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub verdict: Option<Value>,
        pub created_at: String,
        pub updated_at: String,
    }
}

contract! { pub struct WorkstreamParent { pub workstream_id: String, pub serves: String } }

contract! {
    pub struct EstimateActual {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub actual_minutes: Option<f64>,
        pub ratio_at_start: f64,
    }
}

contract! { pub struct IntakeSource { pub text: String, pub channel: String, pub by: String, pub at: String } }

contract! {
    pub struct Brief {
        pub goal: String,
        pub why: String,
        pub pointers: Vec<String>,
        pub constraints: Vec<String>,
        pub done_when: Vec<CheckSpec>,
        pub tier: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub budget: Option<Budget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub estimate: Option<Estimate>,
        /// Research briefs (M9); not shown yet.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub baseline: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub metric: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub decision_rule: Option<Value>,
    }
}

contract! {
    pub struct Budget {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub agent_hours: Option<f64>,
    }
}

contract! { pub struct Estimate { pub raw_minutes: f64, pub gates: Vec<String> } }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub enum CheckSpec {
    PrMerged {
        repo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pr: Option<u64>,
    },
    CiGreen {
        repo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
    },
    Http {
        url: String,
        status: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        contains: Option<String>,
    },
    Cmd { machine_id: String, argv: Vec<String>, expect_exit: i64 },
    Test { repo: String, test_id: String },
    Judge { criteria: String },
    Human { question: String },
    /// A check type this build doesn't know.
    #[serde(other)]
    Other,
}

impl CheckSpec {
    /// One line for a done-when list.
    pub fn describe(&self) -> String {
        match self {
            CheckSpec::PrMerged { repo, pr } => match pr {
                Some(pr) => format!("PR #{pr} merged in {repo}"),
                None => format!("PR merged in {repo}"),
            },
            CheckSpec::CiGreen { repo, r#ref } => format!("CI green on {repo}{}", r#ref.as_ref().map(|r| format!(" @ {r}")).unwrap_or_default()),
            CheckSpec::Http { url, status, contains } => {
                format!("GET {url} → {status}{}", contains.as_ref().map(|c| format!(" containing \"{c}\"")).unwrap_or_default())
            }
            CheckSpec::Cmd { machine_id, argv, expect_exit } => format!("`{}` on {machine_id} exits {expect_exit}", argv.join(" ")),
            CheckSpec::Test { repo, test_id } => format!("test {test_id} passes in {repo}"),
            CheckSpec::Judge { criteria } => format!("judge: {criteria}"),
            CheckSpec::Human { question } => format!("you confirm: {question}"),
            CheckSpec::Other => "a check this app version can't show".into(),
        }
    }
}

literals! {
    pub enum AskClass { Product = "product", Money = "money", Credential = "credential", Irreversible = "irreversible" }
}

literals! {
    pub enum AskKind { Decide = "decide", Do = "do", Secret = "secret", Approve = "approve" }
}

literals! {
    pub enum AskState { Open = "open", Auto = "auto", Answered = "answered", Defaulted = "defaulted", Withdrawn = "withdrawn" }
}

contract! {
    pub struct Ask {
        pub ask_id: String,
        /// Absent only on an `intake.route.*` ask, which asks which project a new intent is for (M9).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub project_ref: Option<ProjectRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub workstream_id: Option<String>,
        pub kind: AskKind,
        pub key: String,
        pub class: AskClass,
        pub text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub options: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub recommendation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub steps: Option<Vec<Step>>,
        /// M8: a do ask's re-check, a secret ask's sink and fingerprint, an approve ask's stored command and what
        /// closed or reopened the ask.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub verify: Option<CheckSpec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub sink: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub env_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub fingerprint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub gated: Option<GatedRunSpec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub evidence: Option<String>,
        pub blocks: String,
        pub proceeded_on_rec: bool,
        pub state: AskState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub batch_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub number: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub answer: Option<AskAnswer>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub decision_id: Option<String>,
        pub created_at: String,
    }
}

literals! {
    pub enum GatedClass { Irreversible = "irreversible", Money = "money", Credential = "credential" }
}

contract! {
    /// An approve ask's stored command: the node runs exactly this after a human approves it.
    pub struct GatedRunSpec {
        pub argv: Vec<String>,
        /// Absent: the project workspace.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub cwd: Option<String>,
        pub class: GatedClass,
        pub reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub secret_env: Option<Vec<SecretEnv>>,
        pub timeout_sec: u32,
    }
}

contract! { pub struct SecretEnv { pub name: String, pub secret_key: String } }

contract! { pub struct AskAnswer { pub value: String, pub by: String, pub at: String, pub raw: String } }

contract! {
    pub struct Step {
        pub text: String,
        #[serde(rename = "where")]
        pub place: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub command: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub expect: Option<String>,
    }
}

contract! {
    pub struct Batch {
        pub batch_id: String,
        pub created_at: String,
        pub items: Vec<BatchItem>,
        pub state: String,
    }
}

contract! { pub struct BatchItem { pub number: u32, pub ask_id: String } }

// ---- Tool inputs and outputs ----------------------------------------------------------------

/// A tool the app calls: its name and input/output types.
pub trait Tool {
    const NAME: &'static str;
    type Output: serde::de::DeserializeOwned;
}

macro_rules! tool {
    ($input:ident => $output:ident, $name:literal) => {
        impl Tool for $input {
            const NAME: &'static str = $name;
            type Output = $output;
        }
    };
}

contract! { pub struct ProjectGetInput { pub machine_id: String, pub project_id: String } }
tool!(ProjectGetInput => ProjectOutcome, "project_get");

contract! {
    pub struct ThreadTailInput {
        pub machine_id: String,
        pub thread_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub n: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub kinds: Option<Vec<String>>,
    }
}
tool!(ThreadTailInput => ThreadTailOutput, "thread_tail");

contract! {
    pub struct ThreadTailOutput {
        /// Newest first.
        pub items: Vec<TailItem>,
        pub thread: ThreadSummary,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub next: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub truncated: Option<bool>,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub enum TailItem {
    Message { at: String, role: String, text: String },
    Action { at: String, action: ActionItem },
}

contract! {
    pub struct ActionItem {
        pub at: String,
        pub kind: String,
        pub status: String,
        pub summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub output_tail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub exit_code: Option<i64>,
        pub failed: bool,
    }
}

contract! {
    pub struct AsksListInput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub state: Option<AskState>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub batch_id: Option<String>,
    }
}
tool!(AsksListInput => AsksListOutput, "asks_list");

contract! {
    pub struct AsksListOutput {
        /// Newest first.
        pub batches: Vec<Batch>,
        pub asks: Vec<Ask>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub next: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub truncated: Option<bool>,
    }
}

contract! {
    pub struct InboxReplyInput {
        pub raw: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub batch_id: Option<String>,
    }
}
tool!(InboxReplyInput => InboxReplyOutput, "inbox_reply");

contract! {
    pub struct InboxReplyOutput {
        pub parsed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub batch_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub echo: Option<String>,
        pub applied: Vec<InboxReplyApplied>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub hint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub next: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub truncated: Option<bool>,
    }
}

contract! {
    pub struct InboxReplyApplied {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub number: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub ask_id: Option<String>,
        pub outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub decision_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub by: Option<String>,
    }
}
