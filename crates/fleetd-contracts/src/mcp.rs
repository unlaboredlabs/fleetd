//! The MCP surface: the static tool table with every tool's input and output, the fleet status view and the tool
//! error shape. Inputs apply their decode defaults on deserialize.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::auth::{AgentKeyInfo, Role};
use crate::chat::{ChatMessageId, ChatRequestId};
use crate::checklist::{CHECKLIST_MAX, TodoEdit, TodoItem};
use crate::doctor::{DoctorCheck, DoctorCheckId};
use crate::effort::{ProfileRuns, ProfileSetting, ProfileSettings};
use crate::events::{HubEvent, HubEventType};
use crate::hello::ProtocolVersion;
use crate::ids::{EventSeq, MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use crate::ledger::{
    Decision, DecisionId, DecisionKey, DecisionScope, DecisionValue, DecisionWhy, HumanRequest,
    Lead, RequestState, Workstream, WorkstreamId, WorkstreamState,
};
use crate::live::{AgentLane, OrderCard, TrainLive};
use crate::memory::{MemoryCaps, MemoryFile, MemoryScope, MemoryText, MemoryTopic};
use crate::model::{ActionItem, Machine, ProjectOutcome, ProjectSummary, ThreadSummary};
use crate::people::{
    DEVICES_MAX, HubRole, Invite, InviteId, PEOPLE_MAX, Person, PersonId, PersonName,
};
use crate::prim::{
    Count, Int, IntOr, Line, List, MAX_SAFE_INT, NonEmpty, Positive, Text, True, UniqueList,
};
use crate::projects::{AddId, CloneTarget, GitHubRepos, MachineRepos, ProjectInspect};
use crate::prompts::{
    PromptDetail, PromptId, PromptRef, PromptScope, PromptSummary, PromptWarning,
    RetiredPromptOverride, SessionPrompt,
};
use crate::secrets::{SealedSecret, SecretFingerprint};
use crate::status::ProjectStatusRow;
use crate::steer::{Steer, SteerId, SteerMode, SteerTarget, SteerText};
use crate::tasks::{SlotState, Task, TaskId, TaskState};
use crate::time::{
    CategoryTotal, CiCheckStat, CommandStat, Coverage, CriticalPath, HumanWait, Insight,
    InsightRule, Period, PeriodBreakdown, ProfileTotal, RepeatStat, Span, SpanKind, TimeFilters,
    TimeScope,
};
use crate::train::{Change, ChangeState, GitHubPrUrl, GitHubRepo};
use crate::usage::UsageStatus;
use crate::wakes::{Wake, WakeCatchUp, WakeMessage, WakeSchedule, WakeState, WakeTarget};
use crate::{brand, checked};

pub type RequestId = NonEmpty;

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatus {
    pub machines: Vec<Machine>,
    pub projects: List<ProjectSummary, 0, 50>,
    /// Latest failed, waiting and usage-limited events, and PRs the merge train sent back to their authors.
    pub attention: List<HubEvent, 0, 10>,
    pub cursor: EventSeq,
    /// Absent until the hub runs the slot board (M5).
    pub slots: Option<SlotState>,
    /// Each project's chat: whether its lead waits on you, whether it works. Absent from hubs without chat.
    pub chats: Option<List<crate::chat::ProjectChatState, 0, 50>>,
    /// When to notify the human; absent from older hubs.
    pub notify: Option<NotifyPolicy>,
}

/// Declares an output struct with the fields every tool result carries: `next`, a hint for the next call, and
/// `truncated`, whether lists were trimmed to their limits.
macro_rules! output {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[skip_serializing_none]
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase")]
        $(#[$meta])*
        pub struct $name {
            $($(#[$fmeta])* pub $field: $ty,)*
            pub next: Option<String>,
            pub truncated: Option<bool>,
        }
    };
}

/// Declares an input struct.
macro_rules! input {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[skip_serializing_none]
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase")]
        $(#[$meta])*
        pub struct $name {
            $($(#[$fmeta])* pub $field: $ty,)*
        }
    };
}

// fleetd_status
input!(FleetdStatusInput {});
output!(FleetdStatusOutput {
    #[serde(flatten)]
    status: FleetStatus,
});

// project_get: with machineId and projectId, that project's outcome; without projectId, the projects (on machineId,
// matching query).
input!(
    #[serde(remote = "Self")]
    ProjectGetInput {
        machine_id: Option<MachineId>,
        project_id: Option<ProjectId>,
        /// Without projectId: only projects whose title or path contains it.
        query: Option<String>,
    }
);
checked!(ProjectGetInput, |input| {
    if input.project_id.is_some() && input.machine_id.is_none() {
        return Err("projectId goes with its machineId".into());
    }
    Ok(())
});
/// The projects, or one project's outcome (its fields at the top level).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGetOutput {
    /// Without projectId: the projects.
    pub projects: Option<Vec<ProjectSummary>>,
    #[serde(flatten)]
    pub outcome: Option<ProjectOutcome>,
}

// thread_tail
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TailKind {
    Message,
    Action,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TailRole {
    User,
    Assistant,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TailMessage {
    pub at: Timestamp,
    pub role: TailRole,
    pub text: Text<0, 2000>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TailAction {
    pub at: Timestamp,
    pub action: ActionItem,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TailItem {
    Message(TailMessage),
    Action(TailAction),
}

input!(ThreadTailInput {
    machine_id: MachineId,
    thread_id: ThreadId,
    #[serde(default)]
    n: IntOr<1, 50, 10>,
    kinds: Option<Vec<TailKind>>,
});
output!(ThreadTailOutput {
    /// Newest first.
    items: List<TailItem, 0, 50>,
    thread: ThreadSummary,
});

// actions_list
input!(ActionsListInput {
    machine_id: MachineId,
    thread_id: ThreadId,
    #[serde(default)]
    limit: IntOr<1, 50, 50>,
    failed_only: Option<bool>,
});
output!(ActionsListOutput {
    /// Newest first.
    actions: List<ActionItem, 0, 50>,
});

// events_wait
input!(EventsWaitInput {
    /// Absent means start at the current end.
    cursor: Option<EventSeq>,
    types: Option<Vec<HubEventType>>,
    machine_id: Option<MachineId>,
    #[serde(default)]
    timeout_sec: IntOr<0, 50, 50>,
});
output!(EventsWaitOutput {
    events: List<HubEvent, 0, 100>,
    cursor: EventSeq,
    more: bool,
});

// events_list: one project's events, newest first, a page at a time back through the log's 30 days (the app's
// Activity). `before: s` pages back from `s`; events_wait follows what comes next.
input!(EventsListInput {
    project_ref: ProjectRef,
    before: Option<EventSeq>,
    /// Only these types; absent: every type.
    types: Option<Vec<HubEventType>>,
    /// Also the hub's own events, which name no machine or project (a device paired).
    hub_wide: Option<bool>,
    #[serde(default)]
    limit: IntOr<1, 100, 50>,
});
output!(EventsListOutput {
    /// Newest first.
    events: List<HubEvent, 0, 100>,
    /// More events before the last one of this page.
    more: bool,
});

fn default_true() -> bool {
    true
}

// wake_set
input!(WakeSetInput {
    target: WakeTarget,
    schedule: WakeSchedule,
    message: WakeMessage,
    #[serde(default = "default_true")]
    once: bool,
    #[serde(default)]
    catch_up: WakeCatchUp,
    client_request_id: RequestId,
});
output!(WakeSetOutput {
    wake_id: NonEmpty,
    next_run_at: Timestamp
});

// wake_list
input!(WakeListInput { machine_id: Option<MachineId>, thread_id: Option<ThreadId>, state: Option<WakeState> });
output!(WakeListOutput { wakes: Vec<Wake> });

// wake_cancel
input!(WakeCancelInput { wake_id: NonEmpty });
output!(WakeCancelOutput { ok: True });

// lead_start
input!(LeadStartInput {
    machine_id: MachineId,
    project_id: ProjectId,
    /// Start a fresh lead thread from the current digest (sessionGeneration goes up); the old one stays as history.
    fresh: Option<bool>,
});
output!(LeadStartOutput {
    #[serde(flatten)]
    lead: Lead,
});

// project_set: a project's settings. `mediumAllowed` (default on): whether its lead may run a task on the medium
// profile; off runs every task on high.
input!(ProjectSetInput {
    machine_id: MachineId,
    project_id: ProjectId,
    medium_allowed: bool,
});
output!(ProjectSetOutput {
    medium_allowed: bool
});

// profiles_get, profiles_set: the model and effort behind each task profile, fleet-wide (Administration › Hub settings)
// and as a project's override (its settings). Unset everywhere, a profile runs on the runner's own.
input!(ProfilesGetInput {
    /// A project: its override too, and what its agents run on. Absent: the fleet's.
    project_ref: Option<ProjectRef>,
});
input!(
    #[serde(remote = "Self")]
    ProfilesSetInput {
        /// A project's override. Absent: the fleet's, which needs an admin key.
        project_ref: Option<ProjectRef>,
        /// Replaces the profile's setting at that scope; `{}` unsets it. A refusal goes once the model is set again:
        /// to keep it while changing only the effort, pass back the `refused` profiles_get read with the same model.
        high: Option<ProfileSetting>,
        medium: Option<ProfileSetting>,
    }
);
checked!(ProfilesSetInput, |input| {
    if input.high.is_none() && input.medium.is_none() {
        return Err("expected high, medium or both".into());
    }
    Ok(())
});
/// The profiles' settings at the fleet and, when asked, a project, and what new agents run on.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesView {
    pub fleet: ProfileSettings,
    /// The project's override; absent without projectRef.
    pub project: Option<ProfileSettings>,
    /// What a new agent of each profile runs on: the project's setting, else the fleet's, else the runner's own.
    /// The lead, every review and claude's helper calls run high.
    pub runs: ProfileRuns,
    /// The runner's own: what a profile set nowhere runs on.
    pub defaults: ProfileRuns,
}
output!(ProfilesGetOutput {
    #[serde(flatten)]
    view: ProfilesView,
});
output!(ProfilesSetOutput {
    #[serde(flatten)]
    view: ProfilesView,
});

brand!(
    /// "F" plus a positive integer, unique per hub: a file uploaded with attachment_put.
    AttachmentId, name = "AttachmentId", pattern = r"^F[1-9][0-9]*$"
);

brand!(
    /// "U" plus 32 hex digits: a file still being uploaded with attachment_part.
    UploadId, name = "UploadId", pattern = r"^U[0-9a-f]{32}$"
);

/// Most attachments an order or a note may carry.
pub const ATTACHMENTS_MAX: usize = 20;
/// Attachments an order or a note may carry.
pub type Attachments = UniqueList<AttachmentId, 0, ATTACHMENTS_MAX>;

/// Largest attachment, decoded.
pub const ATTACHMENT_MAX_BYTES: usize = 25 * 1024 * 1024;
/// The piece of a file the app sends per attachment_part call, decoded: its base64 fits one app call.
pub const ATTACHMENT_PART_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum AttachmentMime {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/gif")]
    Gif,
    #[serde(rename = "text/plain")]
    Text,
    #[serde(rename = "application/pdf")]
    Pdf,
}

/// Something an order or note points at: a file of the project, another order, or a PR. The hub renders these into
/// the lead's wake as a "References:" block.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum IntakeRef {
    /// Repo-relative.
    File {
        path: Text<1, 1000>,
    },
    Order {
        workstream_id: WorkstreamId,
    },
    Pr {
        url: GitHubPrUrl,
    },
}

pub type IntakeRefs = List<IntakeRef, 0, 20>;

// attachment_part: one piece of a file too large for one call, in order. The first piece (no uploadId) starts an
// upload; each next one passes the uploadId it returned and offset, the bytes sent so far. attachment_put with the
// uploadId and the last piece stores the file. An upload untouched for an hour is deleted.
input!(AttachmentPartInput {
    upload_id: Option<UploadId>,
    /// With uploadId: the bytes sent so far, which must match the hub's count.
    offset: Option<Count>,
    /// Standard base64.
    data_b64: NonEmpty,
});
output!(AttachmentPartOutput {
    upload_id: UploadId,
    /// Received so far.
    bytes: Count,
});

// attachment_put: upload one file for a later chat_send or steer_send. Unreferenced uploads are deleted after 24 h.
input!(AttachmentPutInput {
    name: Line<1, 120>,
    mime: AttachmentMime,
    /// Standard base64: the whole file, or with uploadId its last piece. At most 25 MiB decoded, all pieces together.
    data_b64: NonEmpty,
    /// The pieces sent with attachment_part, which come before dataB64.
    upload_id: Option<UploadId>,
});
output!(AttachmentPutOutput {
    attachment_id: AttachmentId,
    bytes: Count,
    sha256: Text<64, 64>,
});

// attachment_get: one file of a project's chat or orders, to show it (an image in a chat message): at most 25 MiB,
// the attachment_put cap. Read on the project's machine; the file must belong to that project, or the caller uploaded
// it.
input!(AttachmentGetInput {
    project_ref: ProjectRef,
    attachment_id: AttachmentId,
});
output!(AttachmentGetOutput {
    attachment_id: AttachmentId,
    name: Line<1, 120>,
    mime: AttachmentMime,
    bytes: Count,
    /// Standard base64.
    data_b64: String,
});

// project_files: a project's files for @-mentions, best fuzzy match first.
input!(ProjectFilesInput {
    machine_id: MachineId,
    project_id: ProjectId,
    #[serde(default)]
    query: Text<0, 200>,
    #[serde(default)]
    limit: IntOr<1, 50, 20>,
});
output!(ProjectFilesOutput {
    /// Repo-relative.
    paths: List<Text<1, 1000>, 0, 50>,
});

// orders_board: open orders (and those done since `includeDoneSince`) joined with their agents, PRs and asks, plus the
// trains of their repos.
input!(OrdersBoardInput { project_ref: Option<ProjectRef>, include_done_since: Option<Timestamp> });
output!(OrdersBoardOutput {
    /// By phase, then most recently updated.
    orders: List<OrderCard, 0, 60>,
    trains: List<TrainLive, 0, 10>,
    at: Timestamp,
});

// order_get: one order with its record, finished agents, open requests, decisions and steers.
input!(OrderGetInput {
    workstream_id: WorkstreamId
});
output!(OrderGetOutput {
    order: OrderCard,
    /// Its record: the brief and its done-when. Absent from older hubs.
    workstream: Option<Workstream>,
    /// Its project's lead (shared by every order of the project); absent when the project has none.
    lead: Option<AgentLane>,
    /// Newest first.
    done_lanes: List<AgentLane, 0, 30>,
    /// Its open secret and approval requests.
    requests: List<HumanRequest, 0, 20>,
    /// Active decisions scoped to it. Absent from older hubs.
    decisions: Option<List<Decision, 0, 50>>,
    /// Its steers (to the lead or one of its tasks) with their receipts, newest first. Absent from older hubs.
    steers: Option<List<Steer, 0, 20>>,
});

// steer_send: a person steers an order's lead or one task. `queue` (Enter) lands at the agent's next tool boundary;
// `now` (⌘Enter) stops its current step. No wake debounce, no digest.
input!(SteerSendInput {
    target: SteerTarget,
    text: SteerText,
    #[serde(default)]
    mode: SteerMode,
    refs: Option<IntakeRefs>,
    attachments: Option<Attachments>,
    client_request_id: RequestId,
});
output!(SteerSendOutput {
    #[serde(flatten)]
    steer: Steer,
});

// steer_withdraw: drop a steer that is still queued. Refused once it was delivered.
input!(SteerWithdrawInput { steer_id: SteerId });
output!(SteerWithdrawOutput {
    #[serde(flatten)]
    steer: Steer,
});

// project_stop: the safety valve. Interrupts the lead's turn, stops every running and queued agent of the project and
// its open orders, withdraws what waits on a person, and tells the lead in its chat. Merged PRs stay; the lead and the
// chat stay. Idempotent.
input!(ProjectStopInput {
    project_ref: ProjectRef,
    reason: Option<Text<1, 200>>,
});
output!(ProjectStopOutput {
    /// Orders this call stopped.
    stopped: Count,
    /// Tasks this call cancelled.
    cancelled: Count,
    /// The system line it wrote into the chat.
    message: crate::chat::ChatMessage,
});

// chat_stop: the chat's Stop, the same stop as project_stop: the lead's turn and the project's agents stop, and one
// line in the chat says what stopped ("Stopped the lead and 2 agents."). The same clientRequestId returns that line.
input!(ChatStopInput {
    project_ref: ProjectRef,
    client_request_id: RequestId,
});
output!(ChatStopOutput {
    /// Something was running and stopped: the lead's turn or an agent.
    stopped: bool,
    /// The system line it wrote into the chat.
    message: crate::chat::ChatMessage,
});

// time_spans: stored spans of a scope, oldest first, paged by id. `rule` lists the spans a finding links to.
input!(TimeSpansInput {
    scope: TimeScope,
    since: Timestamp,
    until: Option<Timestamp>,
    kinds: Option<List<SpanKind, 1, 64>>,
    rule: Option<InsightRule>,
    after_id: Option<Count>,
    #[serde(default)]
    limit: IntOr<1, 500, 200>,
});
output!(TimeSpansOutput {
    spans: List<Span, 0, 500>,
    /// Absent when there are no more.
    next_after_id: Option<Count>,
    coverage: Coverage,
});

// time_breakdown: where a scope's time went. Agent time is exclusive and adds up across parallel lanes; wall time
// is the scope's span.
input!(TimeBreakdownInput {
    scope: TimeScope,
    since: Timestamp,
    until: Option<Timestamp>,
    compare: Option<Period>,
    #[serde(default)]
    filters: TimeFilters,
});
output!(TimeBreakdownOutput {
    wall_ms: Count,
    agent_ms: Count,
    by_category: List<CategoryTotal, 0, 8>,
    /// High first; absent when no task or lead span is in the period.
    by_profile: Option<List<ProfileTotal, 0, 2>>,
    top_commands: List<CommandStat, 0, 20>,
    repeated: List<RepeatStat, 0, 10>,
    ci_checks: List<CiCheckStat, 0, 20>,
    human_wait: HumanWait,
    /// Order scope only.
    critical_path: Option<CriticalPath>,
    retention_days: Int<1, 365>,
    /// The hub's span tables on disk.
    stored_bytes: Count,
    coverage: Coverage,
    compare: Option<PeriodBreakdown>,
});

// time_insights: the deterministic rules over a scope, strongest first.
input!(TimeInsightsInput {
    scope: TimeScope,
    since: Timestamp,
    until: Option<Timestamp>,
    compare: Option<Period>,
});
output!(TimeInsightsOutput { insights: List<Insight, 0, 30> });

// time_retention_set: how many days the hub keeps spans. Roll-ups and critical paths stay 400 days.
input!(TimeRetentionSetInput { retention_days: Int<1, 365> });
output!(TimeRetentionSetOutput { retention_days: Int<1, 365> });

// metrics_get: the factory metrics of one project's repos, or the whole fleet's deduped by repo: merged per day,
// order to merged, the person's minutes per merged PR and the share through fleetd, by calendar day in `tz`.
input!(MetricsGetInput {
    /// Absent: every project you can read, each repo counted once.
    project_ref: Option<ProjectRef>,
    since: Timestamp,
    /// Absent: now.
    until: Option<Timestamp>,
    tz: crate::wakes::TimeZone,
    /// Add the previous period of the same length's days (the tiles always carry its figures).
    #[serde(default)]
    compare: bool,
});
output!(MetricsGetOutput {
    since: Timestamp,
    until: Timestamp,
    tiles: crate::metrics::MetricsTiles,
    /// Every calendar day of the range in `tz`, oldest first, empty days included.
    days: List<crate::metrics::MetricsDay, 0, 400>,
    /// Landed changes in the range, newest first; `truncated` when there were more than fit.
    merges: List<crate::metrics::MetricsMerge, 0, 1000>,
    merges_total: Count,
    /// Without projectRef: one row per repo.
    repos: Option<List<crate::metrics::MetricsRepoRow, 0, 200>>,
    coverage: crate::metrics::MetricsCoverage,
    compare: Option<crate::metrics::MetricsComparePeriod>,
});

// metrics_retention_set: how many days the hub keeps landed changes and the person's touches.
input!(MetricsRetentionSetInput {
    retention_days: crate::metrics::MetricsRetentionDays
});
output!(MetricsRetentionSetOutput {
    retention_days: crate::metrics::MetricsRetentionDays
});

// thread_window: the items and messages around one item of a session, oldest first (for "click to transcript").
input!(ThreadWindowInput {
    machine_id: MachineId,
    thread_id: ThreadId,
    /// A span's `itemId`.
    item_id: NonEmpty,
    #[serde(default)]
    before: IntOr<0, 25, 10>,
    #[serde(default)]
    after: IntOr<0, 25, 10>,
});
output!(ThreadWindowOutput {
    items: List<TailItem, 0, 51>,
    /// The index of `itemId` in `items`; absent when the node no longer has it.
    focus: Option<Count>,
});

// workstream_list
input!(WorkstreamListInput {
    machine_id: Option<MachineId>,
    project_id: Option<ProjectId>,
    state: Option<WorkstreamState>,
    #[serde(default)]
    limit: IntOr<1, 100, 50>,
});
output!(WorkstreamListOutput {
    /// Newest first.
    workstreams: List<Workstream, 0, 100>,
});

// requests_list: secret and approval requests, newest first.
input!(RequestsListInput {
    project_ref: Option<ProjectRef>,
    /// Absent: every state.
    state: Option<RequestState>,
    #[serde(default)]
    limit: IntOr<1, 100, 50>,
});
output!(RequestsListOutput {
    requests: List<HumanRequest, 0, 100>,
});

// decisions_search
input!(DecisionsSearchInput {
    query: Text<1, 200>,
    /// Absent: every scope.
    scope: Option<DecisionScope>,
    #[serde(default)]
    limit: IntOr<1, 50, 10>,
});
output!(DecisionsSearchOutput {
    /// Best match first; active decisions only.
    decisions: List<Decision, 0, 50>,
});

// decisions_record: the hub fills the decision's source and by from the caller (human device or agent key).
input!(DecisionsRecordInput { key: DecisionKey, value: DecisionValue, why: Option<DecisionWhy>, scope: DecisionScope });
output!(DecisionsRecordOutput { decision: Decision });

// decisions_list: the panel's Decisions tab. Every project- and workstream-scoped decision in a project, live and
// overturned, newest first.
input!(DecisionsListInput {
    project_ref: ProjectRef,
    #[serde(default)]
    limit: IntOr<1, 500, 200>,
});
output!(DecisionsListOutput {
    /// Every state: active, superseded and retired.
    decisions: List<Decision, 0, 500>,
    /// The order each workstream-scoped decision belongs to, by its title.
    orders: List<DecisionOrder, 0, 500>,
});

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOrder {
    pub workstream_id: WorkstreamId,
    pub title: Text<0, 200>,
}

// decisions_overturn: a person takes an active decision back (no value) or replaces its value. Human keys only; the
// project's lead reads the change at its next wake.
input!(DecisionsOverturnInput {
    decision_id: DecisionId,
    /// Absent: revoke, and the key goes unanswered again. Present: a new decision on the same key and scope.
    value: Option<DecisionValue>,
    why: DecisionWhy,
});
output!(DecisionsOverturnOutput {
    /// The decision overturned: retired, or superseded by `decision`.
    overturned: Decision,
    /// The replacement, when a value was given.
    decision: Option<Decision>,
});

// tasks_list
input!(TasksListInput {
    project_ref: Option<ProjectRef>,
    state: Option<TaskState>,
    #[serde(default)]
    limit: IntOr<1, 100, 50>,
});
output!(TasksListOutput {
    /// Newest first.
    tasks: List<Task, 0, 100>,
});

// task_get
input!(TaskGetInput { task_id: TaskId });
output!(TaskGetOutput { task: Task });

// cap_set: the fleet cap, a machine's max agents, a project's max agents, or any of them. Lowering stops nothing;
// raising starts queued agents at once.
input!(CapSetMachine {
    machine_id: MachineId,
    /// 1 up to the fleet cap: the most agents that run on the machine at once, in place of what it is measured to fit.
    max_agents: Option<Int<1, 1000>>,
    /// Drop the setting: the machine runs what it is measured to fit again.
    auto: Option<bool>,
});
input!(CapSetProject {
    project_ref: ProjectRef,
    /// 1 up to the fleet cap: the project's own max, which no later fleet or machine cap changes.
    max_agents: Option<Int<1, 1000>>,
    /// Drop the project's own max: it follows the default again, its machine's cap within the fleet cap.
    follow_default: Option<bool>,
    /// Lowering: tell the agents above the new max to push their work in progress and wait; they resume when a slot
    /// frees. Without it they finish their current work.
    pause_extras: Option<bool>,
});
input!(
    #[serde(remote = "Self")]
    CapSetInput {
        /// The fleet cap: agents running at once across every project. Needs an admin key.
        cap: Option<Int<1, 1000>>,
        /// A machine's max agents. Needs an admin key.
        machine: Option<CapSetMachine>,
        project: Option<CapSetProject>,
    }
);
checked!(CapSetInput, |input| {
    if input.cap.is_none() && input.machine.is_none() && input.project.is_none() {
        return Err("expected cap, machine, project or more".into());
    }
    if let Some(m) = &input.machine
        && m.max_agents.is_some() == (m.auto == Some(true))
    {
        return Err("expected machine.maxAgents or machine.auto: true".into());
    }
    if let Some(p) = &input.project
        && p.max_agents.is_some() == (p.follow_default == Some(true))
    {
        return Err("expected project.maxAgents or project.followDefault: true".into());
    }
    Ok(())
});
output!(CapSetOutput {
    slots: SlotState,
    /// The agents `pauseExtras` paused.
    paused: Option<List<TaskId, 0, 1000>>,
});

// changes_list
input!(ChangesListInput {
    project_ref: Option<ProjectRef>,
    repo: Option<GitHubRepo>,
    state: Option<ChangeState>,
    #[serde(default)]
    limit: IntOr<1, 100, 50>,
});
output!(ChangesListOutput {
    /// Newest first.
    changes: List<Change, 0, 100>,
});

// usage_status: per machine, the login kind, breaker, parked counts, the latest limit events and the probe counter.
input!(UsageStatusInput { machine_id: Option<MachineId> });
output!(UsageStatusOutput { machines: Vec<UsageStatus> });

// usage_resume: closes the machine's breaker and sends "continue" to everything parked there.
input!(UsageResumeInput {
    machine_id: MachineId
});
output!(UsageResumeOutput {
    /// Parked threads sent "continue".
    resumed: Count,
    status: UsageStatus,
});

// secret_submit: human keys only. The hub relays the sealed value to the sink's node and waits for its fingerprint.
input!(SecretSubmitInput {
    request_id: ChatRequestId,
    /// Sealed in the desktop app to the sink machine's `box_pub_key` (see Machine).
    sealed: SealedSecret,
});
output!(SecretSubmitOutput {
    request_id: ChatRequestId,
    fingerprint: SecretFingerprint
});

// approval_answer: the human approves or denies a chat's `command_approval` item. Human keys only (the handler
// checks). Returns the request as answered; the item's new state arrives as a `chat.message` event.
input!(ApprovalAnswerInput {
    request_id: crate::chat::ChatRequestId,
    decision: crate::chat::ApprovalDecision,
    /// A denial's reason, passed to the lead.
    message: Option<Text<1, 500>>,
});
output!(ApprovalAnswerOutput {
    request: HumanRequest,
});

// doctor_list: the latest result of every check this key may read; rerun runs them all now first.
input!(DoctorListInput { machine_id: Option<MachineId>, rerun: Option<bool> });
output!(DoctorListOutput {
    /// Hub checks first, then each machine's, in a fixed order.
    checks: List<DoctorCheck, 0, 500>,
    /// When these results were taken.
    checked_at: Timestamp,
});

// doctor_fix: runs a check's automatic fix, then that check again. A manual fix is refused with its command.
input!(DoctorFixInput {
    check_id: DoctorCheckId
});
output!(DoctorFixOutput {
    /// What the fix did, in plain words.
    ran: String,
    /// The check, run again after the fix.
    check: DoctorCheck,
});

input!(QuietWindow {
    from: Timestamp,
    to: Timestamp
});
input!(
    /// When a client may interrupt the human with an event marked `attention`. Quiet windows are absolute times the
    /// hub computes from `policy.quiet_hours` in `policy.tz`: the one under way (if any) and the next.
    NotifyPolicy {
    /// At most one notification per this many seconds; what arrives meanwhile is folded into the next.
    coalesce_sec: Int<1, MAX_SAFE_INT>,
    /// Only "urgent" events notify inside these; empty when quiet hours are off. Ask again after the last one ends
    /// or on decision.recorded.
    quiet: List<QuietWindow, 0, 2>,
});

brand!(
    /// An absolute directory on the machine, without `.`, `..` or empty segments (one trailing `/` is allowed).
    WorkspacePath,
    check = is_workspace_path,
    expected = "an absolute directory such as /home/me/src/app, without . or .. segments",
    pattern = r"^/."
);

fn is_workspace_path(s: &str) -> bool {
    let trimmed = s.strip_suffix('/').unwrap_or(s);
    s.starts_with('/')
        && crate::prim::js_len(s) <= 1000
        && !s.chars().any(char::is_control)
        && trimmed.len() > 1
        && trimmed[1..]
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

// project_discover: repos to add: git checkouts on each worker, and `gh repo list` for the user and their orgs.
input!(ProjectDiscoverInput {
    /// Scan only this machine; absent: every machine.
    machine_id: Option<MachineId>,
    /// Include `gh repo list` (default true).
    github: Option<bool>,
});
output!(ProjectDiscoverOutput {
    machines: Vec<MachineRepos>,
    github: GitHubRepos,
    /// The machine a clone goes to by default: online, runner ready, fewest running threads. Absent: none is.
    best: Option<MachineId>,
});

// project_add: adds a project from a directory on a machine (`path`), or by cloning a GitHub repository onto one
// (`url`). A path is added at once; a clone answers with `addId` and streams `project.clone_progress`, then
// `project.added` or `project.add_failed`. The same directory again returns its project. `dryRun` adds nothing: it
// answers the facts (default branch, CI and merge rules, what the lead will need) and, for a url, where it would clone.
input!(
    #[serde(remote = "Self")]
    ProjectAddInput {
    /// Absent: the best worker (see `project_discover.best`).
    machine_id: Option<MachineId>,
    path: Option<WorkspacePath>,
    /// A GitHub URL, `git@github.com:o/r.git`, or `owner/repo`.
    url: Option<Text<1, 300>>,
    /// With `url`: clone here instead of `<cloneRoot>/<name>`.
    dest: Option<WorkspacePath>,
    /// With `url`: when the destination is already a checkout of the same repository, add it instead of failing.
    use_existing: Option<bool>,
    /// Absent means the directory's name.
    title: Option<Text<1, 200>>,
    dry_run: Option<bool>,
});
checked!(ProjectAddInput, |input| {
    match (&input.path, &input.url) {
        (Some(_), Some(_)) => return Err("give path or url, not both".into()),
        (None, None) => {
            return Err(
                "give path (a directory on the machine) or url (a GitHub repository)".into(),
            );
        }
        (Some(_), None) if input.dest.is_some() || input.use_existing.is_some() => {
            return Err("dest and useExisting go with url only".into());
        }
        _ => {}
    }
    Ok(())
});
output!(ProjectAddOutput {
    machine_id: MachineId,
    /// The project's directory (the clone's destination for a url).
    path: String,
    /// Absent while a clone runs: `project.added` carries it.
    project_id: Option<ProjectId>,
    /// False when the directory was already a project (it is renamed when a title is given), and in a dry run.
    created: bool,
    /// A clone was started: its `project.clone_progress`, `project.added` and `project.add_failed` events carry it.
    add_id: Option<AddId>,
    /// For a path, at once; for a clone, on `project.added`; for a dry run, the repository's facts.
    inspect: Option<ProjectInspect>,
    /// A dry run with url: where it would clone, and whether that folder already holds a checkout.
    clone: Option<CloneTarget>,
});

// project_remove: stops the project's agent processes and forgets it. Its files and branches stay; its worktrees too,
// unless removeWorktrees.
input!(ProjectRemoveInput {
    machine_id: MachineId,
    project_id: ProjectId,
    /// Also force-remove the fleetd worktrees its agents worked in, uncommitted changes and all, once its agents have
    /// stopped. Their branches and the checkout stay as they are.
    remove_worktrees: Option<bool>,
});
output!(ProjectRemoveOutput { ok: True });

// project_settings_get, project_settings_set, project_env_set: a project's own settings (Settings › Projects).
input!(ProjectSettingsGetInput {
    machine_id: MachineId,
    project_id: ProjectId,
    /// The repo whose setup and preview to read (its own, else the project's); absent: the project's.
    repo: Option<crate::repos::RepoName>,
});
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub machine_id: MachineId,
    pub project_id: ProjectId,
    pub title: String,
    pub workspace_root: String,
    /// The repo `setup` and `preview` are for; absent when they are the project's, and from older hubs.
    pub repo: Option<crate::repos::RepoName>,
    /// True: a finished task's worktree stays on the machine. False (the default): a reader's goes when it finishes
    /// and a writer's once its PR merges.
    pub keep_worktrees: bool,
    /// Its agents' variables, by name. A secret's value is never here.
    pub env: Vec<crate::project_settings::ProjectEnvVar>,
    /// What runs in each new worktree before its agent starts; no commands when none are set.
    pub setup: crate::project_settings::WorktreeSetup,
    /// How the merge train treats the checks of the project's repo; none set by default.
    #[serde(default)]
    pub train: crate::project_settings::TrainSettings,
    /// How to run a preview someone asks for (Try it); absent when none is set, and from older hubs.
    pub preview: Option<crate::preview::PreviewConfig>,
    /// From the node, now: absent while it is offline or too old to say.
    pub worktrees: Option<crate::project_settings::ProjectWorktrees>,
    /// Why `worktrees` is absent.
    pub worktrees_unknown: Option<String>,
}
output!(ProjectSettingsGetOutput {
    settings: ProjectSettings
});
input!(
    #[serde(remote = "Self")]
    ProjectSettingsSetInput {
        machine_id: MachineId,
        project_id: ProjectId,
        /// The repo whose own setup and preview to set, an empty one giving it the project's; absent: the
        /// project's. Title, keepWorktrees and train are the project's either way.
        repo: Option<crate::repos::RepoName>,
        /// The project's name in fleetd; its folder keeps its own.
        title: Option<Line<1, 200>>,
        keep_worktrees: Option<bool>,
        /// Replaces the project's setup commands and their settings; no commands turns setup off.
        setup: Option<crate::project_settings::WorktreeSetup>,
        /// Replaces how the merge train treats the repo's checks: the checks it also waits for, and those left for
        /// after the merge.
        train: Option<crate::project_settings::TrainSettings>,
        /// Replaces how a preview runs; one with no target turns Try it off for the project.
        preview: Option<crate::preview::PreviewConfig>,
    }
);
checked!(ProjectSettingsSetInput, |input| {
    if input.title.is_none()
        && input.keep_worktrees.is_none()
        && input.setup.is_none()
        && input.train.is_none()
        && input.preview.is_none()
    {
        return Err("expected title, keepWorktrees, setup, train, preview or more".into());
    }
    Ok(())
});
output!(ProjectSettingsSetOutput {
    settings: ProjectSettings
});
input!(
    #[serde(remote = "Self")]
    ProjectEnvSetInput {
        machine_id: MachineId,
        project_id: ProjectId,
        /// Variables to add or replace; a secret replaces a plain one of the same name and the other way round.
        #[serde(default)]
        set: List<crate::project_settings::EnvVarSet, 0, 100>,
        #[serde(default)]
        remove: UniqueList<crate::project_settings::EnvVarName, 0, 100>,
    }
);
checked!(ProjectEnvSetInput, |input| {
    if input.set.is_empty() && input.remove.is_empty() {
        return Err("expected set, remove or both".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    for name in input.set.iter().map(|v| v.name()) {
        if !seen.insert(name.as_str()) {
            return Err(format!("{name} is set twice"));
        }
        if input.remove.iter().any(|r| r == name) {
            return Err(format!("{name} is both set and removed"));
        }
    }
    if let Some(name) = input
        .set
        .iter()
        .map(|v| v.name())
        .find(|n| crate::project_settings::env_name_reserved(n.as_str()))
    {
        return Err(format!(
            "{name} is fleetd's or claude's own: a project can't set it"
        ));
    }
    Ok(())
});
output!(ProjectEnvSetOutput {
    env: Vec<crate::project_settings::ProjectEnvVar>
});

// mcp_servers_get, mcp_server_set, mcp_server_remove, mcp_settings_set, mcp_server_test: the MCP servers fleetd gives
// its agents (Settings › MCP servers, and each project's MCP section).
input!(McpServersGetInput {
    /// Also this project's own servers.
    project: Option<ProjectRef>,
});
output!(McpServersGetOutput {
    /// Every project's, by name.
    global: Vec<crate::mcp_servers::McpServer>,
    /// The asked project's own, by name; each replaces a global one of the same name there.
    #[serde(default)]
    project: Vec<crate::mcp_servers::McpServer>,
    /// Agents also get the person's own MCP servers from their claude setup (on by default).
    user_servers: bool,
});
input!(
    #[serde(remote = "Self")]
    McpServerSetInput {
        scope: crate::mcp_servers::McpScope,
        name: crate::mcp_servers::McpServerName,
        enabled: bool,
        roles: crate::mcp_servers::McpRoles,
        transport: crate::mcp_servers::McpTransport,
        /// A stdio server's env, the whole list: a value saved before and not here is removed.
        #[serde(default)]
        env: List<crate::mcp_servers::McpValueSet, 0, 50>,
        /// An HTTP or SSE server's headers, the whole list.
        #[serde(default)]
        headers: List<crate::mcp_servers::McpValueSet, 0, 50>,
    }
);
checked!(McpServerSetInput, |input| {
    if crate::mcp_servers::mcp_name_reserved(input.name.as_str()) {
        return Err("fleetd is fleetd's own tools server: pick another name".into());
    }
    if input.transport.is_stdio() && !input.headers.is_empty() {
        return Err("a stdio server takes env, not headers".into());
    }
    if !input.transport.is_stdio() && !input.env.is_empty() {
        return Err("an HTTP or SSE server takes headers, not env".into());
    }
    for list in [&input.env, &input.headers] {
        let mut seen = std::collections::BTreeSet::new();
        for name in list.iter().map(|v| v.name()) {
            if !seen.insert(name.to_ascii_lowercase()) {
                return Err(format!("{name} is set twice"));
            }
        }
    }
    for name in input.env.iter().map(|v| v.name()) {
        crate::project_settings::EnvVarName::new(name.as_str())
            .map_err(|_| format!("{name} is not an environment variable name"))?;
    }
    // A line break would end the header: claude's connection and the test both break on it.
    for v in input.headers.iter() {
        if let crate::mcp_servers::McpValueSet::Plain { name, value } = v
            && value.contains(['\r', '\n'])
        {
            return Err(format!("the header {name} holds a line break"));
        }
    }
    for v in input.env.iter().chain(input.headers.iter()) {
        if let crate::mcp_servers::McpValueSet::Secret { name, sealed } = v {
            if sealed.is_empty() {
                return Err(format!("{name} is sealed to no machine"));
            }
            let mut machines = std::collections::BTreeSet::new();
            if !sealed
                .iter()
                .all(|s| machines.insert(s.machine_id.as_str()))
            {
                return Err(format!("{name} is sealed to a machine twice"));
            }
        }
    }
    Ok(())
});
output!(McpServerSetOutput {
    server: crate::mcp_servers::McpServer,
    /// Machines whose node doesn't hold all of its secrets (offline when it was saved): their agents go without it
    /// until it is saved again while they are online.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    missing_on: Vec<MachineId>,
});
input!(McpServerRemoveInput {
    scope: crate::mcp_servers::McpScope,
    name: crate::mcp_servers::McpServerName,
});
output!(McpServerRemoveOutput { ok: True });
input!(McpSettingsSetInput {
    /// Agents also get the person's own MCP servers from their claude setup.
    user_servers: bool,
});
output!(McpSettingsSetOutput { user_servers: bool });
input!(McpServerTestInput {
    scope: crate::mcp_servers::McpScope,
    name: crate::mcp_servers::McpServerName,
    /// Where to test a global server; default: the first machine online. A project server is tested on its machine.
    machine_id: Option<MachineId>,
});
output!(McpServerTestOutput {
    machine_id: MachineId,
    result: crate::mcp_servers::McpTestResult,
});

// prompt_get, prompt_set, session_prompt_get: every prompt fleetd sends a model.
input!(PromptGetInput {
    /// Absent: list every prompt.
    id: Option<PromptId>,
    /// The texts in effect for this project; absent: hub-wide.
    project_ref: Option<ProjectRef>,
});
output!(PromptGetOutput {
    /// Without an id: every prompt.
    prompts: Option<Vec<PromptSummary>>,
    /// Without an id: your edits to prompts a release retired, hub-wide ones and the asked project's.
    orphans: Option<Vec<RetiredPromptOverride>>,
    /// With an id: that prompt.
    prompt: Option<PromptDetail>,
});
input!(PromptSetInput {
    id: PromptId,
    scope: PromptScope,
    /// Required with scope project.
    project_ref: Option<ProjectRef>,
    /// The text to save. May be empty only for `instructions`. Required unless `reset` is true.
    text: Option<String>,
    /// True deletes your text at this scope (or your edit to a prompt fleetd retired), so the next level applies.
    /// Only an explicit reset does that: a missing text is an error, never a reset.
    reset: Option<bool>,
    /// The default ref the text was edited from (`prompt_get` default.ref); absent: the one shipped now.
    base: Option<PromptRef>,
    /// Return the warnings without saving; with reset, the ref that would be in effect, without resetting.
    dry_run: Option<bool>,
});
output!(PromptSetOutput {
    r#ref: PromptRef,
    /// What the edit may break; it is saved anyway.
    warnings: Vec<PromptWarning>,
});
input!(SessionPromptGetInput {
    machine_id: MachineId,
    thread_id: ThreadId
});
output!(SessionPromptGetOutput {
    session: SessionPrompt
});

// memory_get, memory_set, memory_undo: what the leads remember (Settings > Memory). Writes are human keys only.
input!(MemoryGetInput {
    /// Also that project's MEMORY.md and topic files; absent: user.md only.
    project_ref: Option<ProjectRef>,
});
output!(MemoryGetOutput {
    user: MemoryFile,
    /// With projectRef: MEMORY.md first, then the topic files by name.
    files: Option<Vec<MemoryFile>>,
    /// With projectRef: the project's files together, and their cap.
    project_chars: Option<Count>,
    project_cap: Option<Count>,
    /// The hub's caps. Absent from older hubs.
    caps: Option<MemoryCaps>,
});
input!(
    #[serde(remote = "Self")]
    MemorySetInput {
        scope: MemoryScope,
        /// Required with scope project.
        project_ref: Option<ProjectRef>,
        /// Project scope: a topic file; absent, MEMORY.md.
        topic: Option<MemoryTopic>,
        /// The whole file. Empty deletes it (a topic's index line too).
        text: MemoryText,
    }
);
checked!(MemorySetInput, |input| {
    match (input.scope, &input.project_ref, &input.topic) {
        (MemoryScope::Project, None, _) => Err("scope project needs projectRef".into()),
        (MemoryScope::User, _, Some(_)) => Err("user.md has no topics".into()),
        _ => Ok(()),
    }
});
output!(MemorySetOutput { file: MemoryFile });
input!(MemoryUndoInput {
    project_ref: ProjectRef,
    /// The chat line that said "Remembered: …".
    message_id: ChatMessageId,
});
output!(MemoryUndoOutput { ok: True });

// memory_caps_set: the caps every memory write is held to, hub-wide. Admin on every machine.
input!(MemoryCapsSetInput {
    #[serde(flatten)]
    caps: MemoryCaps,
});
output!(MemoryCapsSetOutput {
    #[serde(flatten)]
    caps: MemoryCaps,
});

// automation_list, automation_create, automation_update, automation_pause, automation_rotate, automation_delete,
// automation_run, automation_runs: a project's automations (Settings > Automations). A webhook URL holds its secret and
// is in the output only when it is made (create or update with webhook true) or rotated; the hub keeps a hash of it.
input!(AutomationListInput {
    project_ref: ProjectRef
});
output!(AutomationListOutput {
    automations: crate::automations::Automations
});
input!(AutomationCreateInput {
    project_ref: ProjectRef,
    name: crate::automations::AutomationName,
    prompt: crate::automations::AutomationPrompt,
    schedule: Option<crate::automations::AutomationSchedule>,
    /// Give it a webhook URL.
    #[serde(default)]
    webhook: bool,
    client_request_id: RequestId,
});
output!(AutomationCreateOutput {
    automation: crate::automations::Automation,
    /// Shown once: POST to it to start a run with the body as context.
    webhook_url: Option<String>,
});
input!(AutomationUpdateInput {
    automation_id: crate::automations::AutomationId,
    name: Option<crate::automations::AutomationName>,
    prompt: Option<crate::automations::AutomationPrompt>,
    schedule: Option<crate::automations::AutomationSchedule>,
    /// true: take its schedule off.
    remove_schedule: Option<bool>,
    /// true adds a webhook URL (kept if it has one); false removes it.
    webhook: Option<bool>,
});
output!(AutomationUpdateOutput {
    automation: crate::automations::Automation,
    /// Only when this update made its webhook URL.
    webhook_url: Option<String>,
});
input!(AutomationPauseInput {
    automation_id: crate::automations::AutomationId,
    paused: bool,
});
output!(AutomationPauseOutput {
    automation: crate::automations::Automation
});
// A new webhook URL; the old one stops working at once.
input!(AutomationRotateInput {
    automation_id: crate::automations::AutomationId
});
output!(AutomationRotateOutput {
    automation: crate::automations::Automation,
    webhook_url: String,
});
input!(AutomationDeleteInput {
    automation_id: crate::automations::AutomationId
});
output!(AutomationDeleteOutput { ok: True });
// Run now.
input!(AutomationRunInput {
    automation_id: crate::automations::AutomationId
});
output!(AutomationRunOutput {
    run: crate::automations::AutomationRun
});
input!(AutomationRunsInput {
    automation_id: crate::automations::AutomationId,
    limit: IntOr<1, 100, 30>,
});
output!(AutomationRunsOutput {
    runs: crate::automations::AutomationRuns
});

// checklist_get: a project's checklist, which its lead keeps with `checklist` (the panel's Checklist tab).
input!(ChecklistGetInput {
    project_ref: ProjectRef
});
output!(ChecklistGetOutput {
    project_ref: ProjectRef,
    /// In the lead's order.
    items: List<TodoItem, 0, CHECKLIST_MAX>,
    /// The last change; absent while the lead has never set one.
    updated_at: Option<Timestamp>,
});

// checklist_remove: a person takes items off a project's checklist, one item or every done one (the Checklist tab's
// Delete and Clear done). Human keys only (the handler checks); the lead hears of it at its next wake.
input!(ChecklistRemoveInput {
    project_ref: ProjectRef,
    /// The items to take off; one already gone is skipped.
    ids: List<Positive, 1, CHECKLIST_MAX>,
});
output!(ChecklistRemoveOutput {
    project_ref: ProjectRef,
    /// The list after it, in the lead's order.
    items: List<TodoItem, 0, CHECKLIST_MAX>,
    updated_at: Option<Timestamp>,
});

// checklist_edit: a person ticks, reopens, edits, adds or removes items on a project's checklist. Human keys only (the
// handler checks); the change records who made it.
input!(ChecklistEditInput {
    project_ref: ProjectRef,
    items: List<TodoEdit, 1, CHECKLIST_MAX>,
});
output!(ChecklistEditOutput {
    project_ref: ProjectRef,
    items: List<TodoItem, 0, CHECKLIST_MAX>,
    updated_at: Option<Timestamp>,
});

// browser_sessions: a project's browser sessions, newest first, or one by sessionId (the Sessions view).
input!(BrowserSessionsInput {
    project_ref: ProjectRef,
    session_id: Option<crate::browser::BrowserSessionId>,
    #[serde(default)]
    limit: IntOr<1, 100, 50>,
});
output!(BrowserSessionsOutput {
    sessions: List<crate::browser::BrowserSession, 0, 100>,
    retention: crate::browser::BrowserRetention,
});

// browser_recording_get: one piece of a recorded session's file, from offset; read the next from offset + its bytes
// until done.
input!(BrowserRecordingGetInput {
    session_id: crate::browser::BrowserSessionId,
    file: crate::browser::RecordingFile,
    #[serde(default)]
    offset: Count,
});
output!(BrowserRecordingGetOutput {
    session_id: crate::browser::BrowserSessionId,
    file: crate::browser::RecordingFile,
    mime: Text<1, 100>,
    offset: Count,
    /// At most RECORDING_PART_BYTES decoded; empty at the end.
    data_b64: String,
    /// The whole file's size.
    bytes: Count,
    done: bool,
});

// browser_control: a person takes a live browser session over from its agent (human), or hands it back (agent).
// Human keys with operate on its machine only (the handler checks).
input!(BrowserControlInput {
    session_id: crate::browser::BrowserSessionId,
    control: crate::browser::BrowserControlTo,
});
output!(BrowserControlOutput {
    session: crate::browser::BrowserSession,
});

// browser_retention_set: how long the hub keeps browser recordings, for every project.
input!(BrowserRetentionSetInput {
    #[serde(flatten)]
    retention: crate::browser::BrowserRetention,
});
output!(BrowserRetentionSetOutput {
    retention: crate::browser::BrowserRetention,
});

// machine_roles: every machine's roles (agents, sessions), its session slots and what it can host (Settings > Machines).
input!(MachineRolesInput {});
output!(MachineRolesOutput {
    machines: List<crate::machine_roles::MachineRolesEntry, 0, 1000>,
});

// machine_roles_set: what a machine is for, and the most sessions it hosts at once. Turning agents off stops nothing:
// its running agents finish, new ones wait.
input!(
    #[serde(remote = "Self")]
    MachineRolesSetInput {
        machine_id: MachineId,
        roles: Option<List<crate::machine_roles::MachineRole, 1, 2>>,
        /// The most sessions it hosts at once, in place of what it fits.
        max_sessions: Option<crate::machine_roles::MaxSessions>,
        /// Drop the session cap: it hosts what it fits again.
        auto_sessions: Option<bool>,
    }
);
checked!(MachineRolesSetInput, |input| {
    if input.roles.is_none() && input.max_sessions.is_none() && input.auto_sessions != Some(true) {
        return Err("expected roles, maxSessions or autoSessions: true".into());
    }
    if input.max_sessions.is_some() && input.auto_sessions == Some(true) {
        return Err("expected maxSessions or autoSessions: true, not both".into());
    }
    if let Some(roles) = &input.roles
        && roles.len() == 2
        && roles[0] == roles[1]
    {
        return Err("roles: each at most once".into());
    }
    Ok(())
});
output!(MachineRolesSetOutput {
    machine: crate::machine_roles::MachineRolesEntry,
});

// preview_start, preview_end, previews_list, preview_feedback: Try it (preview.rs, docs/design/try-it.md). Nothing
// runs unless a person asks: preview_start takes a person's key (admin or operate; a read key only opens a running
// one), and a lead starts one only with its own lead call, in a turn answering the person.
input!(PreviewStartInput {
    project_ref: ProjectRef,
    of: crate::preview::PreviewOf,
    target: Option<crate::preview::PreviewTarget>,
});
output!(PreviewStartOutput {
    preview: crate::preview::Preview,
});
input!(PreviewEndInput {
    preview_id: crate::preview::PreviewId,
});
output!(PreviewEndOutput {
    preview: crate::preview::Preview,
});
input!(PreviewsListInput {
    project_ref: ProjectRef,
    /// Only those of this PR or order.
    of: Option<crate::preview::PreviewOf>,
});
output!(PreviewsListOutput {
    /// Running ones first, then the newest that ended.
    previews: List<crate::preview::Preview, 0, 200>,
    /// Agents' suggestions to try a PR, for those with no preview yet.
    suggestions: List<crate::preview::PreviewSuggestion, 0, 200>,
    /// The caller's key may start previews on this project: a human key with admin or operate on its machine (D162).
    /// False: it only opens running ones. Absent from older hubs: the app offers Try it and shows a refusal.
    can_start: Option<bool>,
});
input!(PreviewFeedbackInput {
    preview_id: crate::preview::PreviewId,
    pins: List<crate::preview::PreviewPin, 1, 20>,
    /// The screenshot with its pins drawn, and any other file, from attachment_put.
    #[serde(default)]
    files: List<AttachmentId, 0, 4>,
    /// Add the last this-many seconds of the preview's session recording; absent or 0: none.
    clip_seconds: Option<Int<0, 60>>,
});
output!(PreviewFeedbackOutput {
    /// Where it went, in words: "#14's writer, at its next step", "the lead, who decides how it's fixed".
    delivered_to: Line<1, 300>,
});

// skills_list: Settings > Skills and the composer's `$`. The hub's global skills; with projectRef also the project's
// and its repo's (.agents/skills, .claude/skills), each marked when a skill of the same name outranks it.
input!(SkillsListInput {
    project_ref: Option<ProjectRef>
});
output!(SkillsListOutput {
    /// In precedence order, then by name.
    skills: List<crate::skills::SkillSummary, 0, 1000>,
    /// Why the repo's skills are missing from the list (the machine is offline, or its node can't list them).
    repo_unavailable: Option<String>,
});
// skill_get: one skill's SKILL.md (a repo one's as the checkout has it).
input!(
    #[serde(remote = "Self")]
    SkillGetInput {
        origin: crate::skills::SkillOrigin,
        /// Required for every origin but global.
        project_ref: Option<ProjectRef>,
        name: crate::skills::SkillName,
    }
);
checked!(SkillGetInput, |input| {
    if input.origin != crate::skills::SkillOrigin::Global && input.project_ref.is_none() {
        return Err("only a global skill is read without projectRef".into());
    }
    Ok(())
});
output!(SkillGetOutput {
    skill: crate::skills::SkillSummary,
    text: Text<0, { crate::skills::SKILL_TEXT_CAP }>,
});
// skill_set: creates or replaces a hub-kept skill's SKILL.md (a human key's write). Its other files stay.
input!(
    #[serde(remote = "Self")]
    SkillSetInput {
        scope: crate::skills::SkillScope,
        /// Required with scope project.
        project_ref: Option<ProjectRef>,
        name: crate::skills::SkillName,
        text: Text<1, { crate::skills::SKILL_TEXT_CAP }>,
        /// Refuse when a skill of that name is already in the scope (New).
        create: Option<bool>,
    }
);
checked!(SkillSetInput, |input| {
    if input.scope == crate::skills::SkillScope::Project && input.project_ref.is_none() {
        return Err("scope project needs projectRef".into());
    }
    Ok(())
});
output!(SkillSetOutput {
    skill: crate::skills::SkillSummary
});
// skill_delete: removes a hub-kept skill's folder (a human key's write).
input!(
    #[serde(remote = "Self")]
    SkillDeleteInput {
        scope: crate::skills::SkillScope,
        /// Required with scope project.
        project_ref: Option<ProjectRef>,
        name: crate::skills::SkillName,
    }
);
checked!(SkillDeleteInput, |input| {
    if input.scope == crate::skills::SkillScope::Project && input.project_ref.is_none() {
        return Err("scope project needs projectRef".into());
    }
    Ok(())
});
output!(SkillDeleteOutput { ok: True });
// skill_install: fetches a source (skills.sh's: owner/repo, owner/repo@skill, a GitHub URL, any git URL) on the hub
// and keeps its skills in the scope, pinned to the commit fetched (a human key's write). A skill of the same name in
// the scope is replaced.
input!(
    #[serde(remote = "Self")]
    SkillInstallInput {
        scope: crate::skills::SkillScope,
        /// Required with scope project.
        project_ref: Option<ProjectRef>,
        source: Line<1, 500>,
        /// Only this skill of the source; absent, every skill it has.
        skill: Option<crate::skills::SkillName>,
    }
);
checked!(SkillInstallInput, |input| {
    if input.scope == crate::skills::SkillScope::Project && input.project_ref.is_none() {
        return Err("scope project needs projectRef".into());
    }
    Ok(())
});
output!(SkillInstallOutput {
    installed: List<crate::skills::SkillSummary, 1, { crate::skills::SCOPE_CAP }>,
});
// skill_update: fetches an installed skill's source again, at the newest commit of the ref it follows, and moves its
// pin (a human key's write). Nothing updates on its own.
input!(
    #[serde(remote = "Self")]
    SkillUpdateInput {
        scope: crate::skills::SkillScope,
        /// Required with scope project.
        project_ref: Option<ProjectRef>,
        name: crate::skills::SkillName,
    }
);
checked!(SkillUpdateInput, |input| {
    if input.scope == crate::skills::SkillScope::Project && input.project_ref.is_none() {
        return Err("scope project needs projectRef".into());
    }
    Ok(())
});
output!(SkillUpdateOutput {
    skill: crate::skills::SkillSummary,
    /// The pin moved: the source had a newer commit.
    updated: bool,
});

// status_get: without projectRef, one row per project the key reads, for the Status screen; with it, that project's
// row.
input!(StatusGetInput {
    project_ref: Option<ProjectRef>
});
output!(StatusGetOutput {
    /// Without projectRef: by title.
    rows: Option<List<ProjectStatusRow, 0, 200>>,
    /// With projectRef.
    row: Option<ProjectStatusRow>,
});

// chat_send: writes to a project's lead. Delivered at once: a new turn when the lead is idle, a steer when it is
// mid-turn, or queued while it starts. The same clientRequestId returns the same message. A human key writes as the
// human; any other key as an agent, by its name: input for the lead, never the human's answer.
input!(ChatSendInput {
    project_ref: ProjectRef,
    text: Text<1, { crate::chat::CHAT_TEXT_MAX }>,
    /// A human key only: while the lead works, stop its running step and deliver at once (steer_send's `now`). An
    /// idle lead takes it as any message.
    now: Option<bool>,
    /// From attachment_put.
    attachments: Option<Attachments>,
    /// Skills the person named with `$name`: the lead's message lists them, so it uses them.
    skills: Option<List<crate::skills::SkillName, 1, 8, true>>,
    client_request_id: RequestId,
    /// A human key: where it is written. Absent means the app.
    client: Option<crate::chat::ChatClient>,
    /// The lead's bubble this answers. `text` still opens with its one-line quote, for clients that show text as it
    /// is; the lead reads the whole bubble in its place.
    reply_to: Option<crate::chat::ChatReplyTo>,
    /// Sent from inside a fleetd session: its thread id (FLEETD_THREAD_ID), as the caller reports it. The project's own
    /// lead and tasks are refused (they use their fleetd tools), and so is a human key. It catches mistakes; the key,
    /// not this field, carries authority.
    session: Option<ThreadId>,
});
output!(ChatSendOutput {
    message: crate::chat::ChatMessage,
    /// Why the lead doesn't have it yet, with the fix; absent when it does or is starting.
    lead_waiting: Option<String>,
});

// chat_history: a page of a project's chat, oldest first within the page. Without `before` or `after`, the newest
// `limit` messages. `before: s` pages back from `s`; `after: s` reads what came after `s` (catching up after a
// reconnect, or one message from its `chat.message` event).
input!(ChatHistoryInput {
    project_ref: ProjectRef,
    before: Option<crate::chat::ChatSeq>,
    after: Option<crate::chat::ChatSeq>,
    #[serde(default)]
    limit: IntOr<1, 100, 50>,
});
output!(ChatHistoryOutput {
    messages: List<crate::chat::ChatMessage, 0, { crate::chat::CHAT_PAGE_MAX }>,
    /// More messages before the first one of this page.
    more_before: bool,
    /// More messages after the last one of this page.
    more_after: bool,
    state: crate::chat::ProjectChatState,
});

// hub_info: the hub's own fleetd build and what is in flight, so an updater can ask before it restarts the hub or a
// node.
input!(HubInfoInput {
    /// Only what runs on this machine (before restarting its node); absent: everything.
    machine_id: Option<MachineId>,
});
output!(HubInfoOutput {
    /// The hub's fleetd version, as `fleetd --version` prints it. "0.0.0" for a local build.
    version: String,
    protocol: ProtocolVersion,
    /// Absent for a local build.
    channel: Option<HubChannel>,
    started_at: Option<Timestamp>,
    /// Empty when nothing is in flight. A restart interrupts each item.
    busy: List<HubBusyItem, 0, 50>,
    /// The caller's key holds Admin on every machine, so it may change the fleet and machine caps. Absent from a hub
    /// before this, which leaves an app to try.
    admin: Option<bool>,
    /// The person the caller's human key belongs to. Absent for an agent key, and from a hub before people.
    me: Option<Person>,
    /// How many people the hub has, removed ones left out. Absent from a hub before people.
    people: Option<Count>,
});

// people_list: the hub's people, oldest first, with the devices and invites the caller may see: an owner's or admin's
// human key sees every device and open invite; anyone else sees their own devices only, and no invites.
input!(PeopleListInput {
    /// Removed people too.
    include_removed: Option<bool>,
});
output!(PeopleListOutput {
    people: List<Person, 0, PEOPLE_MAX>,
    /// Human keys, each with its person, oldest first; revoked ones left out.
    devices: List<AgentKeyInfo, 0, DEVICES_MAX>,
    /// Open invites, newest first.
    invites: List<Invite, 0, PEOPLE_MAX>,
    /// The caller's person; absent for an agent key.
    me: Option<PersonId>,
});

// invite_create: an owner or admin invites someone. Without personId it adds a person (name, role; default member);
// with it, it pairs one more device for that person. The code and link are shown only this once.
input!(InviteCreateInput {
    name: Option<PersonName>,
    role: Option<HubRole>,
    person_id: Option<PersonId>,
});
output!(InviteCreateOutput {
    invite: Invite,
    /// `XXXX-XXXX`: entered in the app's pairing screen with the hub address.
    code: String,
    /// `fleetd://pair?hub=…&code=…`.
    link: String,
    hub_url: String,
});

// invite_revoke: an owner or admin takes back an open invite. A person invited by it who never joined is removed.
input!(InviteRevokeInput {
    invite_id: InviteId
});
output!(InviteRevokeOutput { invite: Invite });

// person_set: an owner or admin renames a person or changes their role. Only an owner makes or unmakes an owner, and
// the hub always keeps one.
input!(PersonSetInput {
    person_id: PersonId,
    name: Option<PersonName>,
    role: Option<HubRole>,
});
output!(PersonSetOutput { person: Person });

// person_remove: an owner or admin removes a person: their devices are revoked and their invites closed. What they did
// keeps their name.
input!(PersonRemoveInput {
    person_id: PersonId
});
output!(PersonRemoveOutput {
    person: Person,
    /// Devices revoked.
    revoked: Count,
});

// device_revoke: a person signs out one of their own devices; an owner or admin, anyone's.
input!(DeviceRevokeInput { key_id: NonEmpty });
output!(DeviceRevokeOutput {
    device: AgentKeyInfo,
});

/// The release channel a hub's build follows: nightly when its version contains "-nightly.", stable otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum HubChannel {
    Nightly,
    Stable,
    /// A channel this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum HubBusyKind {
    /// A running task.
    Agent,
    /// A lead turn in progress.
    Lead,
    /// A merge train step: a change at the head of its train.
    Train,
    /// An approval being answered.
    Approval,
    /// A project being cloned.
    Clone,
    /// A kind this build doesn't know (a newer hub): show the item's text. Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// One thing in flight on the hub.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HubBusyItem {
    pub kind: HubBusyKind,
    /// What it is, for a person: "T19 writing app-main in fleetd (12 m)".
    pub text: Text<1, 280>,
    /// Where it runs, when on one machine.
    pub machine_id: Option<MachineId>,
    pub project_ref: Option<ProjectRef>,
    /// When it started.
    pub since: Option<Timestamp>,
}

// hub_update: updates the hub to the newest build of its channel, then every connected node, without waiting for work
// to finish: what a restart cuts off carries on by itself. Admin on every machine, a human key only. Answers at once
// with the run; hub_update_status follows it. A run already going is returned, not started again.
input!(HubUpdateInput {
    /// Absent: the channel the hub's build came from.
    channel: Option<HubChannel>,
});
output!(HubUpdateOutput {
    /// The update going now or the last one; absent when the hub never updated itself.
    run: Option<UpdateRun>,
});
// hub_update_status: the update going now, or the last one.
input!(HubUpdateStatusInput {});

/// Updates past this many parts (the hub, then a node and Claude Code per machine) are not followed part by part.
pub const UPDATE_PARTS_MAX: usize = 401;

/// One hub update, from its start to the last node's result.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRun {
    pub id: Text<1, 64>,
    pub channel: HubChannel,
    /// The build it updates to: the channel's newest fleetd. Absent until the hub read the channel.
    pub to: Option<Text<1, 200>>,
    pub started_at: Timestamp,
    /// Set once every part has its result.
    pub finished_at: Option<Timestamp>,
    /// The hub first, then per machine, by name, its node and its Claude Code.
    pub parts: List<UpdatePart, 1, UPDATE_PARTS_MAX>,
}

/// The hub, or one machine's node or Claude Code, in an update.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePart {
    pub part: UpdatePartKind,
    /// A node's machine.
    pub machine_id: Option<MachineId>,
    /// For a person: "the hub", or the machine's name.
    pub name: Text<1, 200>,
    /// The version it ran when the update started.
    pub from: Text<0, 200>,
    /// The version it goes to when not the run's `to`: Claude Code's, the one the new fleetd was tested with.
    pub to: Option<Text<1, 200>>,
    pub state: UpdateState,
    /// Where it failed or was put back.
    pub stage: Option<UpdateStage>,
    /// One plain sentence: what happened, or why not, with what to do.
    pub message: Option<Text<0, 500>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum UpdatePartKind {
    Hub,
    Node,
    /// Claude Code on a machine, brought to the version the new fleetd was tested with once its node runs it.
    /// Sessions already running finish on the version they started with; new ones start on the new one.
    Claude,
    /// A part this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum UpdateState {
    /// Its turn hasn't come: a node waits for the hub.
    Waiting,
    /// Reading the channel and downloading the new binary.
    Downloading,
    /// The new binary is in place and the service restarts; a health check follows.
    Restarting,
    /// Runs the new build.
    Done,
    /// Already ran the channel's newest build.
    Current,
    /// Not updated, and nothing changed: the download, the checksum or the install failed.
    Failed,
    /// The new build didn't come up healthy, so the previous one was put back.
    RolledBack,
    /// Not tried: offline, or its fleetd is too old to update from the hub (`message` says how).
    Skipped,
    /// A state this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl UpdateState {
    /// The part has its result.
    pub fn settled(self) -> bool {
        !matches!(self, Self::Waiting | Self::Downloading | Self::Restarting)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum UpdateStage {
    /// Reading the channel or downloading the binary.
    Download,
    /// The download didn't match the release's SHA256SUMS.
    Checksum,
    /// Putting the new binary in place.
    Install,
    /// Restarting the service.
    Restart,
    /// The restarted service didn't come up healthy on the new build.
    Health,
    /// A stage this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

// agents_list: every agent of the projects the key may read: running, queued or waiting tasks, and each project's
// lead. Agents that ended since `endedSince` are added. Working first, then most recently started.
input!(AgentsListInput {
    project_ref: Option<ProjectRef>,
    ended_since: Option<Timestamp>,
});
output!(AgentsListOutput {
    agents: List<crate::agents::AgentRow, 0, { crate::agents::AGENTS_MAX }>,
    at: Timestamp,
});

// agent_work: a page of one agent's recent steps and text, oldest first within the page. Without `before`, the newest
// `limit` steps; `before` pages back. Read from what the hub follows of the session (its newest 200 messages and 200
// steps), so a long session's oldest steps are not here. Secrets are replaced by `[secret]`.
input!(AgentWorkInput {
    machine_id: MachineId,
    thread_id: ThreadId,
    before: Option<crate::agents::WorkCursor>,
    #[serde(default)]
    limit: IntOr<1, 40, 20>,
});
output!(AgentWorkOutput {
    steps: List<crate::agents::WorkStep, 0, { crate::agents::WORK_PAGE_MAX }>,
    /// Pass back as `before` for the page before this one; absent when there is nothing older.
    before: Option<crate::agents::WorkCursor>,
    /// A run of it is active now.
    running: bool,
});

// pr_list: a page of a project's PRs, open first, then most recently updated: every PR, or with `closedSince` the open
// ones and those closed or merged since. `cursor` (a page's `nextCursor`) reads the page after it.
input!(PrListInput {
    project_ref: ProjectRef,
    closed_since: Option<Timestamp>,
    cursor: Option<crate::prs::PrListCursor>,
});
output!(PrListOutput {
    prs: List<crate::prs::PrRow, 0, { crate::prs::PR_LIST_MAX }>,
    /// There are more rows: pass it as cursor for the next page.
    next_cursor: Option<crate::prs::PrListCursor>,
    /// GitHub couldn't be reached: the list holds only the PRs fleetd records, without checks. Why, and what to do.
    github_error: Option<Text<0, 300>>,
    at: Timestamp,
});

// pr_get: one PR in detail: its description, checks, reviews with findings, merge-queue state and history, and the
// agent that wrote it. Files come from pr_files and their diffs from pr_diff.
input!(PrGetInput {
    repo: GitHubRepo,
    number: Positive,
});
output!(PrGetOutput {
    pr: crate::prs::PrRow,
    /// The PR's description, at most 8000 characters. Secrets are replaced by `[secret]`.
    body: Text<0, 8000>,
    base_branch: Option<NonEmpty>,
    head_sha: Option<crate::verification::CommitSha>,
    additions: Option<Count>,
    deletions: Option<Count>,
    changed_files: Option<Count>,
    checks: List<crate::prs::PrCheck, 0, 60>,
    /// Newest first: agent verdicts and people's reviews.
    reviews: List<crate::prs::PrReviewEntry, 0, 30>,
    /// Its moves through the merge queue, newest first.
    history: List<crate::prs::PrQueueStep, 0, 30>,
    links: crate::prs::PrLinks,
    github_error: Option<Text<0, 300>>,
});

// pr_files: a page of a PR's changed files.
input!(PrFilesInput {
    repo: GitHubRepo,
    number: Positive,
    #[serde(default)]
    offset: IntOr<0, 3000, 0>,
});
output!(PrFilesOutput {
    files: List<crate::prs::PrFile, 0, { crate::prs::PR_FILES_PAGE }>,
    /// Changed files in the PR.
    total: Count,
    /// Pass back as `offset` for the next page; absent on the last.
    next_offset: Option<Count>,
    /// The head these files are of.
    head_sha: Option<crate::verification::CommitSha>,
});

// pr_diff: a page of one changed file's diff.
input!(PrDiffInput {
    repo: GitHubRepo,
    number: Positive,
    path: Text<1, 1000>,
    #[serde(default)]
    offset: IntOr<0, 1000000, 0>,
    #[serde(default)]
    limit: IntOr<1, 400, 200>,
});
output!(PrDiffOutput {
    lines: List<crate::prs::DiffLine, 0, { crate::prs::PR_DIFF_PAGE_MAX }>,
    /// Lines in the file's diff.
    total: Count,
    /// Pass back as `offset` for the next page; absent on the last.
    next_offset: Option<Count>,
    /// GitHub shows no diff for this file (binary, or too large).
    no_diff: Option<bool>,
    head_sha: Option<crate::verification::CommitSha>,
});

// work_claim: before a code change in a repo fleetd manages, says what it is and checks it against the work in flight
// on the repo's base (agents, the merge train, other people's sessions) in one call. Claimed: the claim is held 12 h
// from its last renewal (work_claim again on its branch). Taken: the same issue, PR or branch is someone
// else's. Possible duplicate: call again with `notDuplicateOf` (the ids) and `notDuplicateWhy` if it is different
// work. The caller's own active claim on the same branch is renewed and updated instead of claimed twice. A human
// key's claim is a person's; any other key's is an agent key's, since a fleetd agent may load the person's MCP config.
input!(
    #[serde(remote = "Self")]
    WorkClaimInput {
        /// The repo's origin remote, in any form: "git@github.com:acme/shop.git", "https://gitlab.example.com/g/shop",
        /// "/srv/git/shop.git". Give it or projectRef.
        repo: Option<Line<1, 500>>,
        project_ref: Option<ProjectRef>,
        /// The branch the work lands on. Absent: the project's, else that of a project on the repo, else "main".
        base: Option<crate::work::BranchName>,
        /// One line: what the change does.
        title: Line<1, 120>,
        keys: Option<List<crate::work::WorkKey, 0, { crate::work::CLAIM_KEYS_MAX }>>,
        /// Files or globs it will touch.
        paths: Option<List<crate::work::WorkPath, 0, { crate::work::CLAIM_PATHS_MAX }>>,
        /// The branch the work is on.
        branch: Option<crate::work::BranchName>,
        /// `git config user.email`, for knowing its pushes.
        author_email: Option<Line<1, 200>>,
        /// What the branch has changed so far, against the base and uncommitted.
        changed: Option<List<crate::work::WorkPath, 0, { crate::work::OBSERVED_PATHS_MAX }>>,
        head_sha: Option<crate::verification::CommitSha>,
        /// Ids from a possible_duplicate answer that this work is not.
        not_duplicate_of: Option<List<Line<1, 300>, 1, 10>>,
        /// Why not: needed with notDuplicateOf, and logged.
        not_duplicate_why: Option<Line<1, 300>>,
        /// A human key only: claim it even though it is taken, with a link to what holds it.
        anyway: Option<bool>,
    }
);
checked!(WorkClaimInput, |input| {
    if input.repo.is_none() && input.project_ref.is_none() {
        return Err("give repo (its origin remote) or projectRef".into());
    }
    if input.not_duplicate_of.is_some() && input.not_duplicate_why.is_none() {
        return Err(
            "notDuplicateOf needs notDuplicateWhy: one line on why it is different work".into(),
        );
    }
    Ok(())
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkClaimStatus {
    Claimed,
    /// The caller's own claim on the branch, renewed and updated.
    Renewed,
    /// Someone else holds the same issue, PR or branch. Not claimed.
    Taken,
    /// Likely the same as work in flight. Not claimed; `notDuplicateOf` says it is different.
    PossibleDuplicate,
    /// The branch is a fleetd task's own, and an agent key asked: the task's agent on its own work, which fleetd
    /// already tracks. Nothing is claimed; go on.
    Yours,
}

output!(WorkClaimOutput {
    status: WorkClaimStatus,
    /// Claimed or renewed.
    claim: Option<crate::work::Claim>,
    /// Work in flight it may repeat, strongest first.
    matches: List<crate::work::WorkMatch, 0, 10>,
    /// "claimed C7", "taken by T12 (an agent of devbox/shop): dark mode toggle".
    message: String,
    /// No project is bound to the repo yet, so fleetd's agents' work on it may be missing from the matches.
    warning: Option<String>,
});

// work_list: the work in flight on a repo's base branch, across every project on the repo and people's own sessions:
// tasks, Changes on the merge train and claims (expired ones last, for a day), and what landed there outside the train
// in the last 24 h. It only reads.
input!(
    #[serde(remote = "Self")]
    WorkListInput {
        /// The repo's origin remote, in any form. Give it or projectRef.
        repo: Option<Line<1, 500>>,
        project_ref: Option<ProjectRef>,
        base: Option<crate::work::BranchName>,
        /// false: leave out what each writer has changed so far, which asks its machine; a claim keeps its paths.
        /// Default true.
        paths: Option<bool>,
    }
);
checked!(WorkListInput, |input| {
    if input.repo.is_none() && input.project_ref.is_none() {
        return Err("give repo (its origin remote) or projectRef".into());
    }
    Ok(())
});
output!(WorkListOutput {
    scope: crate::work::WorkScope,
    items: List<crate::work::WorkItem, 0, 100>,
    /// No project is bound to the repo yet, so fleetd's agents' work on it may be missing from the items.
    warning: Option<String>,
    /// Commits that reached the base outside the train (a PR merged by hand, a direct push) in the last 24 h, newest
    /// first.
    recent_landings: List<crate::work::RecentLanding, 0, 10>,
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkDoneOutcome {
    /// It reached the base.
    Landed,
    /// Dropped, or left to someone else.
    Dropped,
}

// work_done: ends the caller's claim: landed when the work reached the base, dropped when it won't. A human key may end
// anyone's.
input!(WorkDoneInput {
    claim_id: crate::work::ClaimId,
    outcome: WorkDoneOutcome,
    /// Landed: the commit on the base.
    landing: Option<crate::verification::CommitSha>,
    reason: Option<Line<1, 200>>,
});
output!(WorkDoneOutput {
    claim: crate::work::Claim,
});

/// Declares the static tool table: `McpToolName` with each tool's minimum grant role and its input and output types.
macro_rules! tools {
    ($($name:ident => $variant:ident, $scope:ident, $input:ty, $output:ty;)*) => {
        /// The static MCP tool list. `scope` is the minimum grant role.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "snake_case")]
        pub enum McpToolName {
            $($variant,)*
        }

        impl McpToolName {
            /// In table order, which is the order `tools/list` returns.
            pub const ALL: &'static [McpToolName] = &[$(McpToolName::$variant,)*];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(McpToolName::$variant => stringify!($name),)*
                }
            }

            pub fn parse(name: &str) -> Option<Self> {
                match name {
                    $(stringify!($name) => Some(McpToolName::$variant),)*
                    _ => None,
                }
            }

            pub fn scope(self) -> Role {
                match self {
                    $(McpToolName::$variant => Role::$scope,)*
                }
            }

            /// The input's JSON Schema, as `tools/list` advertises it.
            pub fn input_schema(self, generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                match self {
                    $(McpToolName::$variant => generator.subschema_for::<$input>(),)*
                }
            }

            pub fn output_schema(self, generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                match self {
                    $(McpToolName::$variant => generator.subschema_for::<$output>(),)*
                }
            }

            /// Decodes `input` as this tool's input, defaults applied, and re-encodes it: the input as its
            /// handler sees it. Handlers decode their typed input with `serde_json::from_value` instead.
            pub fn decode_input(self, input: serde_json::Value) -> Result<serde_json::Value, serde_json::Error> {
                match self {
                    $(McpToolName::$variant => serde_json::to_value(serde_json::from_value::<$input>(input)?),)*
                }
            }
        }

    };
}

tools! {
    fleetd_status => FleetdStatus, Read, FleetdStatusInput, FleetdStatusOutput;
    project_get => ProjectGet, Read, ProjectGetInput, ProjectGetOutput;
    thread_tail => ThreadTail, Read, ThreadTailInput, ThreadTailOutput;
    actions_list => ActionsList, Read, ActionsListInput, ActionsListOutput;
    events_wait => EventsWait, Read, EventsWaitInput, EventsWaitOutput;
    events_list => EventsList, Read, EventsListInput, EventsListOutput;
    project_discover => ProjectDiscover, Read, ProjectDiscoverInput, ProjectDiscoverOutput;
    project_add => ProjectAdd, Operate, ProjectAddInput, ProjectAddOutput;
    project_remove => ProjectRemove, Operate, ProjectRemoveInput, ProjectRemoveOutput;
    project_settings_get => ProjectSettingsGet, Read, ProjectSettingsGetInput, ProjectSettingsGetOutput;
    project_settings_set => ProjectSettingsSet, Operate, ProjectSettingsSetInput, ProjectSettingsSetOutput;
    // Human keys only (the handler checks): a person sets a project's environment.
    project_env_set => ProjectEnvSet, Operate, ProjectEnvSetInput, ProjectEnvSetOutput;
    mcp_servers_get => McpServersGet, Read, McpServersGetInput, McpServersGetOutput;
    // Human keys only (the handlers check): a person decides what commands and services agents get.
    mcp_server_set => McpServerSet, Operate, McpServerSetInput, McpServerSetOutput;
    mcp_server_remove => McpServerRemove, Operate, McpServerRemoveInput, McpServerRemoveOutput;
    mcp_settings_set => McpSettingsSet, Operate, McpSettingsSetInput, McpSettingsSetOutput;
    mcp_server_test => McpServerTest, Operate, McpServerTestInput, McpServerTestOutput;
    wake_set => WakeSet, Operate, WakeSetInput, WakeSetOutput;
    wake_list => WakeList, Read, WakeListInput, WakeListOutput;
    wake_cancel => WakeCancel, Operate, WakeCancelInput, WakeCancelOutput;
    lead_start => LeadStart, Operate, LeadStartInput, LeadStartOutput;
    project_set => ProjectSet, Operate, ProjectSetInput, ProjectSetOutput;
    profiles_get => ProfilesGet, Read, ProfilesGetInput, ProfilesGetOutput;
    // Operate on the project for its override; the fleet's needs admin on every machine (the handler checks).
    profiles_set => ProfilesSet, Operate, ProfilesSetInput, ProfilesSetOutput;
    workstream_list => WorkstreamList, Read, WorkstreamListInput, WorkstreamListOutput;
    requests_list => RequestsList, Read, RequestsListInput, RequestsListOutput;
    decisions_search => DecisionsSearch, Read, DecisionsSearchInput, DecisionsSearchOutput;
    decisions_record => DecisionsRecord, Operate, DecisionsRecordInput, DecisionsRecordOutput;
    decisions_list => DecisionsList, Read, DecisionsListInput, DecisionsListOutput;
    // Human keys only (the handler checks).
    decisions_overturn => DecisionsOverturn, Operate, DecisionsOverturnInput, DecisionsOverturnOutput;
    tasks_list => TasksList, Read, TasksListInput, TasksListOutput;
    task_get => TaskGet, Read, TaskGetInput, TaskGetOutput;
    cap_set => CapSet, Operate, CapSetInput, CapSetOutput;
    usage_status => UsageStatus, Read, UsageStatusInput, UsageStatusOutput;
    usage_resume => UsageResume, Operate, UsageResumeInput, UsageResumeOutput;
    changes_list => ChangesList, Read, ChangesListInput, ChangesListOutput;
    secret_submit => SecretSubmit, Operate, SecretSubmitInput, SecretSubmitOutput;
    // Human keys only (the handler checks).
    approval_answer => ApprovalAnswer, Operate, ApprovalAnswerInput, ApprovalAnswerOutput;
    doctor_list => DoctorList, Read, DoctorListInput, DoctorListOutput;
    // Admin keys, or a person's paired device (a human key) with operate on the machine; the handler checks which.
    doctor_fix => DoctorFix, Operate, DoctorFixInput, DoctorFixOutput;
    attachment_part => AttachmentPart, Operate, AttachmentPartInput, AttachmentPartOutput;
    attachment_put => AttachmentPut, Operate, AttachmentPutInput, AttachmentPutOutput;
    attachment_get => AttachmentGet, Read, AttachmentGetInput, AttachmentGetOutput;
    project_files => ProjectFiles, Read, ProjectFilesInput, ProjectFilesOutput;
    orders_board => OrdersBoard, Read, OrdersBoardInput, OrdersBoardOutput;
    order_get => OrderGet, Read, OrderGetInput, OrderGetOutput;
    prompt_get => PromptGet, Read, PromptGetInput, PromptGetOutput;
    // Global: admin on every machine; project: admin on its machine; or a person's device (a human key)
    // with operate there. The handler checks which.
    prompt_set => PromptSet, Operate, PromptSetInput, PromptSetOutput;
    session_prompt_get => SessionPromptGet, Read, SessionPromptGetInput, SessionPromptGetOutput;
    memory_get => MemoryGet, Read, MemoryGetInput, MemoryGetOutput;
    // Human keys only (the handlers check): agents write memory through the lead's remember.
    memory_set => MemorySet, Operate, MemorySetInput, MemorySetOutput;
    memory_undo => MemoryUndo, Operate, MemoryUndoInput, MemoryUndoOutput;
    memory_caps_set => MemoryCapsSet, Admin, MemoryCapsSetInput, MemoryCapsSetOutput;
    automation_list => AutomationList, Read, AutomationListInput, AutomationListOutput;
    automation_create => AutomationCreate, Operate, AutomationCreateInput, AutomationCreateOutput;
    automation_update => AutomationUpdate, Operate, AutomationUpdateInput, AutomationUpdateOutput;
    automation_pause => AutomationPause, Operate, AutomationPauseInput, AutomationPauseOutput;
    automation_rotate => AutomationRotate, Operate, AutomationRotateInput, AutomationRotateOutput;
    automation_delete => AutomationDelete, Operate, AutomationDeleteInput, AutomationDeleteOutput;
    automation_run => AutomationRun, Operate, AutomationRunInput, AutomationRunOutput;
    automation_runs => AutomationRuns, Read, AutomationRunsInput, AutomationRunsOutput;
    checklist_get => ChecklistGet, Read, ChecklistGetInput, ChecklistGetOutput;
    // Human keys only (the handler checks).
    checklist_remove => ChecklistRemove, Operate, ChecklistRemoveInput, ChecklistRemoveOutput;
    // Human keys only (the handler checks).
    checklist_edit => ChecklistEdit, Operate, ChecklistEditInput, ChecklistEditOutput;
    browser_sessions => BrowserSessions, Read, BrowserSessionsInput, BrowserSessionsOutput;
    browser_recording_get => BrowserRecordingGet, Read, BrowserRecordingGetInput, BrowserRecordingGetOutput;
    // Human keys only (the handler checks).
    browser_control => BrowserControl, Operate, BrowserControlInput, BrowserControlOutput;
    browser_retention_set => BrowserRetentionSet, Admin, BrowserRetentionSetInput, BrowserRetentionSetOutput;
    machine_roles => MachineRoles, Read, MachineRolesInput, MachineRolesOutput;
    machine_roles_set => MachineRolesSet, Admin, MachineRolesSetInput, MachineRolesSetOutput;
    // Human keys only (the handlers check), except previews_list.
    preview_start => PreviewStart, Operate, PreviewStartInput, PreviewStartOutput;
    preview_end => PreviewEnd, Operate, PreviewEndInput, PreviewEndOutput;
    previews_list => PreviewsList, Read, PreviewsListInput, PreviewsListOutput;
    preview_feedback => PreviewFeedback, Operate, PreviewFeedbackInput, PreviewFeedbackOutput;
    skills_list => SkillsList, Read, SkillsListInput, SkillsListOutput;
    skill_get => SkillGet, Read, SkillGetInput, SkillGetOutput;
    // Human keys only (the handlers check): a lead installs with its own skill_install.
    skill_set => SkillSet, Operate, SkillSetInput, SkillSetOutput;
    skill_delete => SkillDelete, Operate, SkillDeleteInput, SkillDeleteOutput;
    skill_install => SkillInstall, Operate, SkillInstallInput, SkillInstallOutput;
    skill_update => SkillUpdate, Operate, SkillUpdateInput, SkillUpdateOutput;
    time_spans => TimeSpans, Read, TimeSpansInput, TimeSpansOutput;
    time_breakdown => TimeBreakdown, Read, TimeBreakdownInput, TimeBreakdownOutput;
    time_insights => TimeInsights, Read, TimeInsightsInput, TimeInsightsOutput;
    time_retention_set => TimeRetentionSet, Admin, TimeRetentionSetInput, TimeRetentionSetOutput;
    metrics_get => MetricsGet, Read, MetricsGetInput, MetricsGetOutput;
    metrics_retention_set => MetricsRetentionSet, Admin, MetricsRetentionSetInput, MetricsRetentionSetOutput;
    thread_window => ThreadWindow, Read, ThreadWindowInput, ThreadWindowOutput;
    status_get => StatusGet, Read, StatusGetInput, StatusGetOutput;
    // Human keys only (the handler checks); the lead steers its tasks with `fleetd task message`.
    steer_send => SteerSend, Operate, SteerSendInput, SteerSendOutput;
    steer_withdraw => SteerWithdraw, Operate, SteerWithdrawInput, SteerWithdrawOutput;
    chat_send => ChatSend, Operate, ChatSendInput, ChatSendOutput;
    chat_history => ChatHistory, Read, ChatHistoryInput, ChatHistoryOutput;
    // Human keys only (the handlers check).
    project_stop => ProjectStop, Operate, ProjectStopInput, ProjectStopOutput;
    hub_info => HubInfo, Read, HubInfoInput, HubInfoOutput;
    // Human keys with Admin on every machine only (the handler checks).
    hub_update => HubUpdate, Admin, HubUpdateInput, HubUpdateOutput;
    hub_update_status => HubUpdateStatus, Read, HubUpdateStatusInput, HubUpdateOutput;
    people_list => PeopleList, Read, PeopleListInput, PeopleListOutput;
    // Owners' and admins' human keys only (the handlers check).
    invite_create => InviteCreate, Admin, InviteCreateInput, InviteCreateOutput;
    invite_revoke => InviteRevoke, Admin, InviteRevokeInput, InviteRevokeOutput;
    person_set => PersonSet, Admin, PersonSetInput, PersonSetOutput;
    person_remove => PersonRemove, Admin, PersonRemoveInput, PersonRemoveOutput;
    // Human keys only: a person's own devices, or anyone's for an owner or admin (the handler checks).
    device_revoke => DeviceRevoke, Operate, DeviceRevokeInput, DeviceRevokeOutput;
    agents_list => AgentsList, Read, AgentsListInput, AgentsListOutput;
    agent_work => AgentWork, Read, AgentWorkInput, AgentWorkOutput;
    pr_list => PrList, Read, PrListInput, PrListOutput;
    pr_get => PrGet, Read, PrGetInput, PrGetOutput;
    pr_files => PrFiles, Read, PrFilesInput, PrFilesOutput;
    pr_diff => PrDiff, Read, PrDiffInput, PrDiffOutput;
    chat_stop => ChatStop, Operate, ChatStopInput, ChatStopOutput;
    work_claim => WorkClaim, Operate, WorkClaimInput, WorkClaimOutput;
    work_list => WorkList, Read, WorkListInput, WorkListOutput;
    work_done => WorkDone, Operate, WorkDoneInput, WorkDoneOutput;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MachineOffline,
    NotFound,
    Forbidden,
    Invalid,
    // The hub or the machine's node failed the request; `message` says how, `fix` what to do. A plain comment, so the
    // schema keeps one string enum.
    Failed,
}

/// Sent as an MCP tool error result whose text is this JSON.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct McpToolError {
    pub code: ErrorCode,
    pub message: String,
    /// What to do next.
    pub fix: Option<String>,
}

impl McpToolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            fix: None,
        }
    }
    pub fn with_fix(mut self, fix: impl Into<String>) -> Self {
        self.fix = Some(fix.into());
        self
    }
}

impl std::fmt::Display for McpToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)?;
        if let Some(fix) = &self.fix {
            write!(f, " ({fix})")?;
        }
        Ok(())
    }
}

impl std::error::Error for McpToolError {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn decode<T: serde::de::DeserializeOwned>(
        value: serde_json::Value,
    ) -> Result<T, serde_json::Error> {
        serde_json::from_value(value)
    }

    #[test]
    fn inputs_fill_documented_defaults() {
        let tail: ThreadTailInput =
            decode(json!({ "machineId": "devbox", "threadId": "t1" })).unwrap();
        assert_eq!(tail.n.get(), 10);
        assert_eq!(
            decode::<EventsWaitInput>(json!({}))
                .unwrap()
                .timeout_sec
                .get(),
            50
        );
        let wake = json!({ "target": { "machineId": "devbox", "threadId": "t1" }, "schedule": { "kind": "at", "at": "2026-10-17T10:00:00.000Z", "tz": "UTC" }, "message": "x", "clientRequestId": "r1" });
        let wake: WakeSetInput = decode(wake).unwrap();
        assert!(wake.once);
        assert_eq!(wake.catch_up, WakeCatchUp::FireOnce);
    }

    #[test]
    fn project_settings_take_an_optional_repo() {
        let r = json!({ "machineId": "devbox", "projectId": "p1" });
        let get: ProjectSettingsGetInput = decode(r.clone()).unwrap();
        assert_eq!(get.repo, None);
        let mut in_repo = r.clone();
        in_repo["repo"] = json!("api");
        let get: ProjectSettingsGetInput = decode(in_repo.clone()).unwrap();
        assert_eq!(get.repo.as_ref().map(|r| r.as_str()), Some("api"));
        in_repo["repo"] = json!("Api");
        assert!(decode::<ProjectSettingsGetInput>(in_repo).is_err());
        let set = json!({ "machineId": "devbox", "projectId": "p1", "repo": "api", "keepWorktrees": true });
        let set: ProjectSettingsSetInput = decode(set).unwrap();
        assert_eq!(set.repo.as_ref().map(|r| r.as_str()), Some("api"));
        // A repo alone sets nothing.
        assert!(
            decode::<ProjectSettingsSetInput>(
                json!({ "machineId": "devbox", "projectId": "p1", "repo": "api" })
            )
            .is_err()
        );
    }

    #[test]
    fn inputs_refuse_values_past_their_bounds() {
        assert!(
            decode::<ThreadTailInput>(json!({ "machineId": "devbox", "threadId": "t1", "n": 51 }))
                .is_err()
        );
        assert!(decode::<EventsWaitInput>(json!({ "timeoutSec": 51 })).is_err());
        assert!(decode::<CapSetInput>(json!({})).is_err());
        assert!(decode::<CapSetInput>(json!({ "cap": 1001 })).is_err());
        assert!(decode::<CapSetInput>(json!({ "cap": 40 })).is_ok());
        let project = |mut p: serde_json::Value| {
            p["projectRef"] = json!({ "machineId": "lab-a", "projectId": "p1" });
            decode::<CapSetInput>(json!({ "project": p }))
        };
        assert!(project(json!({ "maxAgents": 4 })).is_ok());
        assert!(project(json!({ "followDefault": true })).is_ok());
        assert!(project(json!({})).is_err());
        assert!(project(json!({ "followDefault": false })).is_err());
        assert!(project(json!({ "maxAgents": 4, "followDefault": true })).is_err());
        let machine = |mut m: serde_json::Value| {
            m["machineId"] = json!("devbox");
            decode::<CapSetInput>(json!({ "machine": m }))
        };
        assert!(machine(json!({ "maxAgents": 40 })).is_ok());
        assert!(machine(json!({ "auto": true })).is_ok());
        assert!(machine(json!({})).is_err());
        assert!(machine(json!({ "auto": false })).is_err());
        assert!(machine(json!({ "maxAgents": 40, "auto": true })).is_err());
        assert!(machine(json!({ "maxAgents": 1001 })).is_err());
    }

    #[test]
    fn hub_info_round_trips_and_reads_a_newer_hubs_values() {
        let output = json!({
            "version": "0.0.0-nightly.202610221107+333368c", "protocol": 1, "channel": "nightly",
            "startedAt": "2026-10-22T11:07:00.000Z",
            "busy": [
                { "kind": "agent", "text": "T19 writing app-main in fleetd (12 m)", "machineId": "devbox",
                  "projectRef": { "machineId": "devbox", "projectId": "p1" }, "since": "2026-10-22T11:10:00.000Z" },
                { "kind": "train", "text": "PR #251 at the head of unlaboredlabs/fleetd's train" },
            ],
        });
        let info: HubInfoOutput = decode(output.clone()).unwrap();
        assert_eq!(info.busy[0].kind, HubBusyKind::Agent);
        assert_eq!(serde_json::to_value(&info).unwrap(), output);

        let minimal: HubInfoOutput =
            decode(json!({ "version": "0.0.0", "protocol": 1, "busy": [] })).unwrap();
        assert_eq!((minimal.channel, minimal.started_at), (None, None));
        let newer: HubInfoOutput = decode(json!({
            "version": "1.4.0", "protocol": 1, "channel": "beta", "uptimeSec": 4,
            "busy": [{ "kind": "migration", "text": "migrating the ledger" }],
        }))
        .unwrap();
        assert_eq!(newer.channel, Some(HubChannel::Unknown));
        assert_eq!(newer.busy[0].kind, HubBusyKind::Unknown);
        assert!(
            decode::<HubInfoInput>(json!({}))
                .unwrap()
                .machine_id
                .is_none()
        );
        assert!(decode::<HubInfoInput>(json!({ "machineId": "devbox" })).is_ok());
    }
}
