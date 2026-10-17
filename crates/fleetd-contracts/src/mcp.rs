//! The MCP surface: the static tool table with every tool's input and output, the fleet status view and the tool
//! error shape. Inputs apply the TS decode defaults (`intDefault`, `withDecodingDefaultKey`) on deserialize.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::auth::Role;
use crate::checked;
use crate::doctor::{DoctorCheck, DoctorCheckId};
use crate::effort::Effort;
use crate::events::{HubEvent, HubEventType};
use crate::ids::{EventSeq, MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use crate::ledger::{
    Ask, AskId, AskState, Batch, BatchId, Decision, DecisionId, DecisionKey, DecisionScope,
    DecisionSource, DecisionValue, DecisionWhy, IntakeText, Lead, PlaybookName, PlaybookRef,
    Serves, Workstream, WorkstreamId, WorkstreamState,
};
use crate::model::{
    ActionItem, Machine, ProjectOutcome, ProjectSummary, RuntimeMode, ThreadSummary,
};
use crate::playbooks::IntakeEcho;
use crate::prim::{Count, Int, IntOr, List, MAX_SAFE_INT, NonEmpty, Positive, Text, True};
use crate::retro::{RetroProposal, RetroProposalState, RetroRun};
use crate::secrets::{SealedSecret, SecretFingerprint};
use crate::subscriptions::{Subscription, SubscriptionMachines, SubscriptionTypes, WebhookUrl};
use crate::tasks::{SlotState, Task, TaskId, TaskState};
use crate::train::{Change, ChangeState, GitHubRepo, TrainState};
use crate::usage::UsageStatus;
use crate::verification::{Claim, ClaimOutcome, Eta, Incident, IncidentClass};
use crate::wakes::{Wake, WakeCatchUp, WakeMessage, WakeSchedule, WakeState, WakeTarget};

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

// projects_list
input!(ProjectsListInput { machine_id: Option<MachineId>, query: Option<String> });
output!(ProjectsListOutput { projects: Vec<ProjectSummary> });

// project_get
input!(ProjectGetInput {
    machine_id: MachineId,
    project_id: ProjectId
});
pub type ProjectGetOutput = ProjectOutcome;

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

// thread_launch
input!(ThreadLaunchInput {
    machine_id: MachineId,
    project_id: ProjectId,
    prompt: NonEmpty,
    model: NonEmpty,
    effort: Effort,
    #[serde(default)]
    runtime_mode: RuntimeMode,
    title: Option<String>,
    client_request_id: RequestId,
});
output!(ThreadLaunchOutput {
    thread_id: ThreadId
});

// thread_send
input!(ThreadSendInput {
    machine_id: MachineId,
    thread_id: ThreadId,
    message: NonEmpty,
    client_request_id: RequestId
});
output!(ThreadSendOutput {
    run_id: Option<String>,
    /// True when the machine is offline and the message waits in the hub's queue.
    queued: bool,
    /// When a queued message expires undelivered.
    queued_until: Option<Timestamp>,
});

// thread_interrupt
input!(ThreadInterruptInput {
    machine_id: MachineId,
    thread_id: ThreadId,
    client_request_id: RequestId
});
output!(ThreadInterruptOutput { ok: True });

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

// subscription_set
input!(SubscriptionSetInput {
    url: WebhookUrl,
    #[serde(default)]
    types: SubscriptionTypes,
    #[serde(default)]
    machines: SubscriptionMachines,
    client_request_id: RequestId,
});
output!(SubscriptionSetOutput {
    subscription_id: NonEmpty,
    /// The webhook signing secret. Shown only here; store it now.
    secret: NonEmpty,
});

// subscription_list
input!(SubscriptionListInput {});
output!(SubscriptionListOutput { subscriptions: Vec<Subscription> });

// subscription_delete
input!(SubscriptionDeleteInput {
    subscription_id: NonEmpty
});
output!(SubscriptionDeleteOutput { ok: True });

// lead_start, lead_restart
input!(LeadStartInput {
    machine_id: MachineId,
    project_id: ProjectId,
    /// Saved as the project's lead model and effort for this and later (re)starts; absent keeps the saved or hub
    /// default.
    model: Option<NonEmpty>,
    effort: Option<Effort>,
});
output!(LeadStartOutput {
    #[serde(flatten)]
    lead: Lead,
});
pub type LeadRestartInput = LeadStartInput;
pub type LeadRestartOutput = LeadStartOutput;

// intake_submit
input!(
    #[serde(remote = "Self")]
    IntakeSubmitInput {
        /// With projectId, or neither: then the router picks the project unless the text starts with `@<project>`.
        machine_id: Option<MachineId>,
        project_id: Option<ProjectId>,
        text: IntakeText,
        /// Skips the router for the template, like a `fix:` or `research:` prefix.
        template: Option<PlaybookName>,
        client_request_id: RequestId,
    }
);
checked!(IntakeSubmitInput, |input| {
    if input.machine_id.is_none() != input.project_id.is_none() {
        return Err("give machineId and projectId together, or neither".into());
    }
    Ok(())
});
output!(
    #[serde(remote = "Self")]
    IntakeSubmitOutput {
        workstream_id: Option<WorkstreamId>,
        /// The router could not place the intent: the human picks the project by answering this ask.
        ask_id: Option<AskId>,
        /// Present with workstreamId.
        echo: Option<IntakeEcho>,
    }
);
checked!(IntakeSubmitOutput, |output| {
    if output.workstream_id.is_none() == output.ask_id.is_none() {
        return Err("exactly one of workstreamId and askId".into());
    }
    Ok(())
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

// workstream_get
input!(WorkstreamGetInput {
    workstream_id: WorkstreamId
});
output!(WorkstreamGetOutput {
    workstream: Workstream,
    /// Its open asks.
    asks: List<Ask, 0, 50>,
    /// Active decisions scoped to it.
    decisions: List<Decision, 0, 50>,
    /// Absent without a raw estimate in the brief.
    eta: Option<Eta>,
    /// Its claims, newest first.
    claims: Option<List<Claim, 0, 20>>,
});

// workstream_spawn: what a finish-all lead's `fleetd workstream spawn` does, for an outside orchestrator.
input!(WorkstreamSpawnInput {
    machine_id: MachineId,
    project_id: ProjectId,
    text: IntakeText,
    serves: Serves,
    template: Option<PlaybookName>,
});
output!(WorkstreamSpawnOutput {
    workstream_id: WorkstreamId,
    /// The project's open finish-all workstream it is a child of.
    parent: WorkstreamId,
    playbook: Option<PlaybookRef>,
});

// inventory: what a finish-all lead's `fleetd inventory` returns.
input!(InventoryInput {
    machine_id: MachineId,
    project_id: ProjectId
});
output!(InventoryOutput {
    /// The ranked list, one item per line.
    text: String,
    /// Items with a value source that no open child serves yet.
    spawnable: Count,
    /// The project's finish-all workstream went (or stayed) idle: nothing left with a value source.
    idle: bool,
});

fn default_open() -> AskState {
    AskState::Open
}

// asks_list
input!(AsksListInput {
    #[serde(default = "default_open")]
    state: AskState,
    batch_id: Option<BatchId>,
});
output!(AsksListOutput {
    /// Newest first.
    batches: List<Batch, 0, 20>,
    /// The asks in those batches, by batch then number.
    asks: List<Ask, 0, 100>,
});

// inbox_reply
input!(InboxReplyInput {
    /// Terse reply such as "1 go 2 nvm 3 recs fine"; a leading "#B<n>" picks the batch.
    raw: Text<1, 4000>,
    /// Absent: the latest open batch.
    batch_id: Option<BatchId>,
});

/// answered: a Decision was written. later: moved to the next batch. retired: "forget Dn". pref: "pref:" recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InboxReplyOutcome {
    Answered,
    Withdrawn,
    Later,
    Retired,
    Pref,
}

input!(InboxReplyApplied {
    /// The batch item number; absent for "pref:" and "forget".
    number: Option<Positive>,
    ask_id: Option<AskId>,
    outcome: InboxReplyOutcome,
    value: Option<String>,
    decision_id: Option<DecisionId>,
    /// The written decision's source and by, filled by the hub from the caller (human device or agent key).
    source: Option<DecisionSource>,
    by: Option<String>,
});
output!(InboxReplyOutput {
    /// False: nothing changed; see `hint`.
    parsed: bool,
    batch_id: Option<BatchId>,
    /// E.g. "Logged: 1 → go (D12), 2 → dropped".
    echo: Option<String>,
    applied: Vec<InboxReplyApplied>,
    /// How to fix an unparseable reply.
    hint: Option<String>,
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

// digest_get
input!(DigestGetInput {});
output!(DigestGetOutput {
    text: String,
    at: Timestamp
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

// cap_set: the global cap, a project's share, or both.
input!(CapSetShare { project_ref: ProjectRef, share: Int<0, 1000> });
input!(
    #[serde(remote = "Self")]
    CapSetInput { cap: Option<Int<1, 1000>>, share: Option<CapSetShare> }
);
checked!(CapSetInput, |input| {
    if input.cap.is_none() && input.share.is_none() {
        return Err("expected cap, share or both".into());
    }
    Ok(())
});
output!(CapSetOutput { slots: SlotState });

// claims_list
input!(ClaimsListInput {
    workstream_id: Option<WorkstreamId>,
    project_ref: Option<ProjectRef>,
    outcome: Option<ClaimOutcome>,
    #[serde(default)]
    limit: IntOr<1, 100, 20>,
});
output!(ClaimsListOutput {
    /// Newest first.
    claims: List<Claim, 0, 100>,
});

// incidents_list
input!(IncidentsListInput {
    project_ref: Option<ProjectRef>,
    workstream_id: Option<WorkstreamId>,
    class: Option<IncidentClass>,
    #[serde(default)]
    limit: IntOr<1, 100, 20>,
    /// M12: the span `counts` covers, ending now.
    #[serde(default)]
    window_days: IntOr<1, 30, 7>,
});
input!(IncidentCount { class: IncidentClass, count: Int<1, MAX_SAFE_INT> });
output!(IncidentsListOutput {
    /// Newest first.
    incidents: List<Incident, 0, 100>,
    /// M12: incidents per class since `counts_since`, under the same filters; classes with none are left out. Most
    /// first.
    counts: Vec<IncidentCount>,
    counts_since: Timestamp,
});

// retro_proposals, retro_run (M12)
input!(RetroProposalsInput {
    state: Option<RetroProposalState>,
    #[serde(default)]
    limit: IntOr<1, 100, 20>,
});
output!(RetroProposalsOutput {
    /// Newest first.
    proposals: List<RetroProposal, 0, 100>,
    /// The global Decision policy.retro.apply is true: wording changes apply on their own and gate changes are asked.
    apply: bool,
    last_run: Option<RetroRun>,
});
input!(RetroRunInput {
    #[serde(default)]
    window_days: IntOr<1, 28, 14>,
    /// Propose only, even when policy.retro.apply is true.
    advise: Option<bool>,
});
output!(RetroRunOutput { run: RetroRun, proposals: List<RetroProposal, 0, 10> });

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

// train_get
input!(TrainGetInput { repo: GitHubRepo });
output!(TrainGetOutput { train: TrainState });

// train_freeze: records or retires the repo's `policy.freeze.<repo>` decision.
input!(TrainFreezeInput { repo: GitHubRepo, frozen: bool, reason: Option<Text<1, 200>> });
output!(TrainFreezeOutput { train: TrainState });

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
    ask_id: AskId,
    /// Sealed in the desktop app to the sink machine's `box_pub_key` (see Machine).
    sealed: SealedSecret,
});
output!(SecretSubmitOutput {
    ask_id: AskId,
    fingerprint: SecretFingerprint
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

// attention_policy: when a client may interrupt the human with an event marked `attention`. Quiet windows are
// absolute times the hub computes from `policy.quiet_hours` in `policy.tz`: the one under way (if any) and the next.
input!(AttentionPolicyInput {});
input!(QuietWindow {
    from: Timestamp,
    to: Timestamp
});
output!(AttentionPolicyOutput {
    /// At most one notification per this many seconds; what arrives meanwhile is folded into the next.
    coalesce_sec: Int<1, MAX_SAFE_INT>,
    /// Only "urgent" events notify inside these; empty when quiet hours are off. Ask again after the last one ends.
    quiet: List<QuietWindow, 0, 2>,
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
            /// In the TS table's order, which is the order `tools/list` returns.
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

            /// Decodes `input` as this tool's input, defaults applied, and re-encodes it: what the TS decoder
            /// hands its handler. Handlers decode their typed input with `serde_json::from_value` instead.
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
    projects_list => ProjectsList, Read, ProjectsListInput, ProjectsListOutput;
    project_get => ProjectGet, Read, ProjectGetInput, ProjectGetOutput;
    thread_tail => ThreadTail, Read, ThreadTailInput, ThreadTailOutput;
    actions_list => ActionsList, Read, ActionsListInput, ActionsListOutput;
    events_wait => EventsWait, Read, EventsWaitInput, EventsWaitOutput;
    thread_launch => ThreadLaunch, Operate, ThreadLaunchInput, ThreadLaunchOutput;
    thread_send => ThreadSend, Operate, ThreadSendInput, ThreadSendOutput;
    thread_interrupt => ThreadInterrupt, Operate, ThreadInterruptInput, ThreadInterruptOutput;
    wake_set => WakeSet, Operate, WakeSetInput, WakeSetOutput;
    wake_list => WakeList, Read, WakeListInput, WakeListOutput;
    wake_cancel => WakeCancel, Operate, WakeCancelInput, WakeCancelOutput;
    subscription_set => SubscriptionSet, Operate, SubscriptionSetInput, SubscriptionSetOutput;
    subscription_list => SubscriptionList, Read, SubscriptionListInput, SubscriptionListOutput;
    subscription_delete => SubscriptionDelete, Operate, SubscriptionDeleteInput, SubscriptionDeleteOutput;
    lead_start => LeadStart, Operate, LeadStartInput, LeadStartOutput;
    lead_restart => LeadRestart, Operate, LeadRestartInput, LeadRestartOutput;
    intake_submit => IntakeSubmit, Operate, IntakeSubmitInput, IntakeSubmitOutput;
    workstream_list => WorkstreamList, Read, WorkstreamListInput, WorkstreamListOutput;
    workstream_get => WorkstreamGet, Read, WorkstreamGetInput, WorkstreamGetOutput;
    workstream_spawn => WorkstreamSpawn, Operate, WorkstreamSpawnInput, WorkstreamSpawnOutput;
    inventory => Inventory, Read, InventoryInput, InventoryOutput;
    asks_list => AsksList, Read, AsksListInput, AsksListOutput;
    inbox_reply => InboxReply, Operate, InboxReplyInput, InboxReplyOutput;
    decisions_search => DecisionsSearch, Read, DecisionsSearchInput, DecisionsSearchOutput;
    decisions_record => DecisionsRecord, Operate, DecisionsRecordInput, DecisionsRecordOutput;
    digest_get => DigestGet, Read, DigestGetInput, DigestGetOutput;
    tasks_list => TasksList, Read, TasksListInput, TasksListOutput;
    task_get => TaskGet, Read, TaskGetInput, TaskGetOutput;
    cap_set => CapSet, Admin, CapSetInput, CapSetOutput;
    usage_status => UsageStatus, Read, UsageStatusInput, UsageStatusOutput;
    usage_resume => UsageResume, Operate, UsageResumeInput, UsageResumeOutput;
    claims_list => ClaimsList, Read, ClaimsListInput, ClaimsListOutput;
    incidents_list => IncidentsList, Read, IncidentsListInput, IncidentsListOutput;
    retro_proposals => RetroProposals, Read, RetroProposalsInput, RetroProposalsOutput;
    // Admin on every machine: a retro reads every project's incidents and changes hub-wide playbooks.
    retro_run => RetroRun, Admin, RetroRunInput, RetroRunOutput;
    changes_list => ChangesList, Read, ChangesListInput, ChangesListOutput;
    train_get => TrainGet, Read, TrainGetInput, TrainGetOutput;
    train_freeze => TrainFreeze, Operate, TrainFreezeInput, TrainFreezeOutput;
    secret_submit => SecretSubmit, Operate, SecretSubmitInput, SecretSubmitOutput;
    doctor_list => DoctorList, Read, DoctorListInput, DoctorListOutput;
    attention_policy => AttentionPolicy, Read, AttentionPolicyInput, AttentionPolicyOutput;
    // Admin keys, or a person's paired device (a human key) with operate on the machine; the handler checks which.
    doctor_fix => DoctorFix, Operate, DoctorFixInput, DoctorFixOutput;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MachineOffline,
    NotFound,
    Forbidden,
    Invalid,
    T3Error,
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
            decode(json!({ "machineId": "forge", "threadId": "t1" })).unwrap();
        assert_eq!(tail.n.get(), 10);
        assert_eq!(
            decode::<EventsWaitInput>(json!({}))
                .unwrap()
                .timeout_sec
                .get(),
            50
        );
        let launch = json!({ "machineId": "forge", "projectId": "p1", "prompt": "hi", "model": "claude-haiku-5-5", "effort": "low", "clientRequestId": "r1" });
        assert_eq!(
            decode::<ThreadLaunchInput>(launch).unwrap().runtime_mode,
            RuntimeMode::FullAccess
        );
        let wake = json!({ "target": { "machineId": "forge", "threadId": "t1" }, "schedule": { "kind": "at", "at": "2026-10-17T10:00:00.000Z", "tz": "UTC" }, "message": "x", "clientRequestId": "r1" });
        let wake: WakeSetInput = decode(wake).unwrap();
        assert!(wake.once);
        assert_eq!(wake.catch_up, WakeCatchUp::FireOnce);
        let sub: SubscriptionSetInput =
            decode(json!({ "url": "https://example.com", "clientRequestId": "r1" })).unwrap();
        assert_eq!(serde_json::to_value(&sub).unwrap()["types"], "*");
        assert_eq!(serde_json::to_value(&sub).unwrap()["machines"], "*");
        assert_eq!(
            decode::<AsksListInput>(json!({})).unwrap().state,
            AskState::Open
        );
        let decoded = McpToolName::IncidentsList.decode_input(json!({})).unwrap();
        assert_eq!(decoded, json!({ "limit": 20, "windowDays": 7 }));
    }

    #[test]
    fn inputs_refuse_values_past_their_bounds() {
        assert!(
            decode::<ThreadTailInput>(json!({ "machineId": "forge", "threadId": "t1", "n": 51 }))
                .is_err()
        );
        assert!(decode::<EventsWaitInput>(json!({ "timeoutSec": 51 })).is_err());
        assert!(
            decode::<SubscriptionSetInput>(
                json!({ "url": "https://example.com", "types": ["nope"], "clientRequestId": "r1" })
            )
            .is_err()
        );
        assert!(decode::<CapSetInput>(json!({})).is_err());
        assert!(decode::<CapSetInput>(json!({ "cap": 1001 })).is_err());
        assert!(decode::<CapSetInput>(json!({ "cap": 40 })).is_ok());
    }

    #[test]
    fn intake_takes_machine_and_project_together_or_neither() {
        let base = json!({ "text": "fix the login bug", "clientRequestId": "r1" });
        assert!(decode::<IntakeSubmitInput>(base.clone()).is_ok());
        let mut both = base.clone();
        both["machineId"] = "forge".into();
        both["projectId"] = "p1".into();
        assert!(decode::<IntakeSubmitInput>(both).is_ok());
        let mut one = base.clone();
        one["machineId"] = "forge".into();
        assert!(decode::<IntakeSubmitInput>(one).is_err());
        let mut chore = base;
        chore["template"] = "chore".into();
        assert!(decode::<IntakeSubmitInput>(chore).is_err());
    }

    #[test]
    fn the_tool_table_matches_ts_names_and_scopes() {
        assert_eq!(McpToolName::ALL.len(), 43);
        for tool in McpToolName::ALL {
            assert_eq!(McpToolName::parse(tool.as_str()), Some(*tool));
            assert_eq!(serde_json::to_value(tool).unwrap(), tool.as_str());
        }
        assert_eq!(McpToolName::CapSet.scope(), Role::Admin);
        assert_eq!(McpToolName::RetroRun.scope(), Role::Admin);
        assert_eq!(McpToolName::DoctorFix.scope(), Role::Operate);
        assert_eq!(McpToolName::FleetdStatus.scope(), Role::Read);
        assert_eq!(McpToolName::parse("push_subscribe"), None);
    }

    #[test]
    fn results_flatten_their_record() {
        let output = json!({ "machines": [], "projects": [], "attention": [], "cursor": 3, "next": "events_wait" });
        let status: FleetdStatusOutput = decode(output.clone()).unwrap();
        assert_eq!(serde_json::to_value(&status).unwrap(), output);
    }
}
