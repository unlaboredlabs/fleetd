//! The MCP surface: the static tool table with every tool's input and output, the fleet status view and the tool
//! error shape. Inputs apply their decode defaults on deserialize.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::auth::Role;
use crate::chat::ChatRequestId;
use crate::doctor::{DoctorCheck, DoctorCheckId};
use crate::events::{HubEvent, HubEventType};
use crate::hello::ProtocolVersion;
use crate::ids::{EventSeq, MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use crate::ledger::{
    Decision, DecisionKey, DecisionScope, DecisionValue, DecisionWhy, HumanRequest, IntakeText,
    Lead, RequestState, Workstream, WorkstreamId, WorkstreamState,
};
use crate::live::{AgentLane, OrderCard, TrainLive};
use crate::model::{ActionItem, Machine, ProjectOutcome, ProjectSummary, ThreadSummary};
use crate::plan::PlanView;
use crate::prim::{
    Count, Int, IntOr, Line, List, MAX_SAFE_INT, NonEmpty, Positive, Text, True, UniqueList,
};
use crate::projects::{AddId, CloneTarget, GitHubRepos, MachineRepos, ProjectInspect};
use crate::prompts::{
    PromptDetail, PromptId, PromptRef, PromptScope, PromptSummary, PromptWarning,
    RetiredPromptOverride, SessionPrompt,
};
use crate::secrets::{SealedSecret, SecretFingerprint};
use crate::status::{ProgressPoint, ProjectStatusRow};
use crate::steer::{Steer, SteerId, SteerMode, SteerTarget};
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

brand!(
    /// "F" plus a positive integer, unique per hub: a file uploaded with attachment_put.
    AttachmentId, name = "AttachmentId", pattern = r"^F[1-9][0-9]*$"
);

/// Attachments an order or a note may carry.
pub type Attachments = UniqueList<AttachmentId, 0, 8>;

/// Largest attachment, decoded.
pub const ATTACHMENT_MAX_BYTES: usize = 5 * 1024 * 1024;

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

// attachment_put: upload one file for a later chat_send or steer_send. Unreferenced uploads are deleted after 24 h.
input!(AttachmentPutInput {
    name: Line<1, 120>,
    mime: AttachmentMime,
    /// Standard base64; at most 5 MiB decoded.
    data_b64: NonEmpty,
});
output!(AttachmentPutOutput {
    attachment_id: AttachmentId,
    bytes: Count,
    sha256: Text<64, 64>,
});

// attachment_get: one file of a project's chat or orders, to show it (an image in a chat message): at most 5 MiB, the
// attachment_put cap. Read on the project's machine; the file must belong to that project, or the caller uploaded it.
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
    text: IntakeText,
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

// cap_set: the fleet cap, a project's max agents, or both. Lowering stops nothing; raising starts queued agents at once.
input!(CapSetProject {
    project_ref: ProjectRef,
    /// 1 up to the fleet cap.
    max_agents: Int<1, 1000>,
    /// Lowering: tell the agents above the new max to push their work in progress and wait; they resume when a slot
    /// frees. Without it they finish their current work.
    pause_extras: Option<bool>,
});
input!(
    #[serde(remote = "Self")]
    CapSetInput {
        /// The fleet cap: agents running at once across every project. Needs an admin key.
        cap: Option<Int<1, 1000>>,
        project: Option<CapSetProject>,
    }
);
checked!(CapSetInput, |input| {
    if input.cap.is_none() && input.project.is_none() {
        return Err("expected cap, project or both".into());
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

// project_remove: stops the project's claude processes and forgets it. Its files, branches and worktrees stay.
input!(ProjectRemoveInput {
    machine_id: MachineId,
    project_id: ProjectId
});
output!(ProjectRemoveOutput { ok: True });

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
    /// Return the warnings without saving.
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

// status_get: without projectRef, one row per project the key reads, for the Status screen; with it, that project's
// row and the series behind its bar.
input!(StatusGetInput {
    project_ref: Option<ProjectRef>
});
output!(StatusGetOutput {
    /// Without projectRef: by title.
    rows: Option<List<ProjectStatusRow, 0, 200>>,
    /// With projectRef.
    row: Option<ProjectStatusRow>,
    /// With projectRef: the bar over time, oldest first: why it fell (`drop`) and when it held on paused work
    /// (`paused`).
    series: Option<List<ProgressPoint, 0, 48>>,
});

// plan_get: one project's plan, or one order's items.
input!(
    #[serde(remote = "Self")]
    PlanGetInput {
        project_ref: Option<ProjectRef>,
        workstream_id: Option<WorkstreamId>,
    }
);
checked!(PlanGetInput, |input| {
    if input.project_ref.is_some() == input.workstream_id.is_some() {
        return Err("give projectRef or workstreamId".into());
    }
    Ok(())
});
output!(PlanGetOutput {
    #[serde(flatten)]
    plan: PlanView,
});

// chat_send: writes to a project's lead. Delivered at once: a new turn when the lead is idle, a steer when it is
// mid-turn, or queued while it starts. The same clientRequestId returns the same message. A human key writes as the
// human; any other key as an agent, by its name: input for the lead, never the human's answer.
input!(ChatSendInput {
    project_ref: ProjectRef,
    text: Text<1, 20000>,
    /// From attachment_put.
    attachments: Option<Attachments>,
    client_request_id: RequestId,
    /// A human key: where it is written. Absent means the app.
    client: Option<crate::chat::ChatClient>,
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

// pr_list: a project's PRs: open ones, and those closed or merged since `closedSince` (default: the last 7 days).
// Open first, then most recently updated.
input!(PrListInput {
    project_ref: ProjectRef,
    closed_since: Option<Timestamp>,
});
output!(PrListOutput {
    prs: List<crate::prs::PrRow, 0, { crate::prs::PR_LIST_MAX }>,
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
    project_discover => ProjectDiscover, Read, ProjectDiscoverInput, ProjectDiscoverOutput;
    project_add => ProjectAdd, Operate, ProjectAddInput, ProjectAddOutput;
    project_remove => ProjectRemove, Operate, ProjectRemoveInput, ProjectRemoveOutput;
    wake_set => WakeSet, Operate, WakeSetInput, WakeSetOutput;
    wake_list => WakeList, Read, WakeListInput, WakeListOutput;
    wake_cancel => WakeCancel, Operate, WakeCancelInput, WakeCancelOutput;
    lead_start => LeadStart, Operate, LeadStartInput, LeadStartOutput;
    project_set => ProjectSet, Operate, ProjectSetInput, ProjectSetOutput;
    workstream_list => WorkstreamList, Read, WorkstreamListInput, WorkstreamListOutput;
    requests_list => RequestsList, Read, RequestsListInput, RequestsListOutput;
    decisions_search => DecisionsSearch, Read, DecisionsSearchInput, DecisionsSearchOutput;
    decisions_record => DecisionsRecord, Operate, DecisionsRecordInput, DecisionsRecordOutput;
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
    time_spans => TimeSpans, Read, TimeSpansInput, TimeSpansOutput;
    time_breakdown => TimeBreakdown, Read, TimeBreakdownInput, TimeBreakdownOutput;
    time_insights => TimeInsights, Read, TimeInsightsInput, TimeInsightsOutput;
    time_retention_set => TimeRetentionSet, Admin, TimeRetentionSetInput, TimeRetentionSetOutput;
    thread_window => ThreadWindow, Read, ThreadWindowInput, ThreadWindowOutput;
    status_get => StatusGet, Read, StatusGetInput, StatusGetOutput;
    plan_get => PlanGet, Read, PlanGetInput, PlanGetOutput;
    // Human keys only (the handler checks); the lead steers its tasks with `fleetd task message`.
    steer_send => SteerSend, Operate, SteerSendInput, SteerSendOutput;
    steer_withdraw => SteerWithdraw, Operate, SteerWithdrawInput, SteerWithdrawOutput;
    chat_send => ChatSend, Operate, ChatSendInput, ChatSendOutput;
    chat_history => ChatHistory, Read, ChatHistoryInput, ChatHistoryOutput;
    // Human keys only (the handlers check).
    project_stop => ProjectStop, Operate, ProjectStopInput, ProjectStopOutput;
    hub_info => HubInfo, Read, HubInfoInput, HubInfoOutput;
    agents_list => AgentsList, Read, AgentsListInput, AgentsListOutput;
    agent_work => AgentWork, Read, AgentWorkInput, AgentWorkOutput;
    pr_list => PrList, Read, PrListInput, PrListOutput;
    pr_get => PrGet, Read, PrGetInput, PrGetOutput;
    pr_files => PrFiles, Read, PrFilesInput, PrFilesOutput;
    pr_diff => PrDiff, Read, PrDiffInput, PrDiffOutput;
    chat_stop => ChatStop, Operate, ChatStopInput, ChatStopOutput;
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
    fn inputs_refuse_values_past_their_bounds() {
        assert!(
            decode::<ThreadTailInput>(json!({ "machineId": "devbox", "threadId": "t1", "n": 51 }))
                .is_err()
        );
        assert!(decode::<EventsWaitInput>(json!({ "timeoutSec": 51 })).is_err());
        assert!(decode::<CapSetInput>(json!({})).is_err());
        assert!(decode::<CapSetInput>(json!({ "cap": 1001 })).is_err());
        assert!(decode::<CapSetInput>(json!({ "cap": 40 })).is_ok());
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
