use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::chat::ChatRequestId;
use crate::ids::{EventSeq, MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use crate::ledger::{RequestKind, RequestState, WorkstreamId, WorkstreamState};
use crate::prim::{Count, Text};
use crate::prompts::PromptScope;
use crate::sessions::RunEnd;
use crate::train::{ChangeId, GitHubRepo};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
// Open in the app's TypeScript: a newer hub adds event types, and the app must show them generically, not choke.
#[schemars(extend("x-open" = true))]
pub enum HubEventType {
    #[serde(rename = "machine.online")]
    MachineOnline,
    #[serde(rename = "machine.offline")]
    MachineOffline,
    #[serde(rename = "machine.degraded")]
    MachineDegraded,
    /// The machine's node woke from sleep; `data.fromMs`, `data.toMs` (epoch milliseconds).
    #[serde(rename = "machine.slept")]
    MachineSlept,
    /// The machine's disk or load stopped new agents there, or no longer does; `data.paused`, and the summary says
    /// why. Agents already running keep going.
    #[serde(rename = "machine.guard")]
    MachineGuard,
    /// The node no longer has the project: the hub dropped it from its cache, and its open workstreams stop. `data.title`.
    #[serde(rename = "project.removed")]
    ProjectRemoved,
    /// A project was added from a path or a finished clone: `data` is `ProjectAddedData` (the inspect line included).
    #[serde(rename = "project.added")]
    ProjectAdded,
    /// A clone `project_add` accepted is running: `data` is `CloneProgressData`. Throttled; never stored past the
    /// event log's own retention.
    #[serde(rename = "project.clone_progress")]
    ProjectCloneProgress,
    /// A clone `project_add` accepted failed: `data` is `ProjectAddFailedData`, with the fix.
    #[serde(rename = "project.add_failed")]
    ProjectAddFailed,
    /// A writer's worktree started from a stale base because git can't fetch the project's remote, or the remote names
    /// no default branch. Once per project until a fetch works again; `data` is `tasks::FetchFailedData`.
    #[serde(rename = "project.fetch_failed")]
    ProjectFetchFailed,
    /// A project's settings changed (`project_set`): `data.mediumAllowed`.
    #[serde(rename = "project.settings")]
    ProjectSettings,
    #[serde(rename = "thread.started")]
    ThreadStarted,
    #[serde(rename = "thread.completed")]
    ThreadCompleted,
    #[serde(rename = "thread.failed")]
    ThreadFailed,
    #[serde(rename = "thread.interrupted")]
    ThreadInterrupted,
    /// Needs approval or user input.
    #[serde(rename = "thread.waiting")]
    ThreadWaiting,
    #[serde(rename = "thread.usage_limited")]
    ThreadUsageLimited,
    #[serde(rename = "wake.fired")]
    WakeFired,
    /// A wake missed while the hub was down, with catchUp "skip".
    #[serde(rename = "wake.missed")]
    WakeMissed,
    /// A queued write to an offline machine was delivered when it came back.
    #[serde(rename = "write.delivered")]
    WriteDelivered,
    /// A queued write outlived its TTL and was dropped.
    #[serde(rename = "write.expired")]
    WriteExpired,
    #[serde(rename = "workstream.created")]
    WorkstreamCreated,
    /// The brief was set and the work started.
    #[serde(rename = "workstream.running")]
    WorkstreamRunning,
    #[serde(rename = "workstream.state")]
    WorkstreamState,
    /// A lead needs a person for a secret or an approval; `data` is the request (RequestEventData).
    #[serde(rename = "request.opened")]
    RequestOpened,
    /// A request changed state (stored, declined, approved, running, done, failed, denied, or open again when it could
    /// not run); `data` as request.opened.
    #[serde(rename = "request.updated")]
    RequestUpdated,
    #[serde(rename = "decision.recorded")]
    DecisionRecorded,
    #[serde(rename = "lead.started")]
    LeadStarted,
    #[serde(rename = "lead.woken")]
    LeadWoken,
    /// `data.queuedReason`.
    #[serde(rename = "task.queued")]
    TaskQueued,
    #[serde(rename = "task.started")]
    TaskStarted,
    #[serde(rename = "task.completed")]
    TaskCompleted,
    #[serde(rename = "task.failed")]
    TaskFailed,
    #[serde(rename = "task.cancelled")]
    TaskCancelled,
    /// A project's max agents or the fleet cap changed; `data` is `tasks::AgentsCapData`, `summary` the chat's line.
    #[serde(rename = "agents.cap")]
    AgentsCap,
    /// The lead closed it. `data.workstreamId`, `data.reason` (why) and `data.by`.
    #[serde(rename = "workstream.done")]
    WorkstreamDone,
    /// `data.taskId`, `data.prHeadSha`, `data.blocking`.
    #[serde(rename = "review.verdict")]
    ReviewVerdict,
    /// `data.changeId`, `data.repo`, `data.prNumber`.
    #[serde(rename = "change.queued")]
    ChangeQueued,
    /// A clean review is bound to its current patch id. `data.changeId`.
    #[serde(rename = "change.ready")]
    ChangeReady,
    /// The PR conflicts with its base, or with the PRs ahead of it in a batch; `data.changeId`.
    #[serde(rename = "change.needs_rebase")]
    ChangeNeedsRebase,
    /// `data.changeId`, `data.checks` (failing check names), `data.logUrl`.
    #[serde(rename = "change.ci_failed")]
    ChangeCiFailed,
    /// `data.changeId`, `data.repo`, `data.prNumber`, `data.mergedSha`; `data.ci` when the repo had no CI and the
    /// train merged on fleetd's own checks.
    #[serde(rename = "pr.merged")]
    PrMerged,
    /// A PR was merged into a base the train guards without the train; `data.repo`, `data.prNumber`,
    /// `data.mergedSha`, and `data.changeId` when it had been enqueued. Newer hubs add `data.mergedAt`, `data.head`,
    /// `data.base`, `data.prCreatedAt`, `data.authorKind`, `data.mergedByKind` and `data.mergedBy` (the merger's login).
    #[serde(rename = "pr.merged_outside")]
    PrMergedOutside,
    /// Refused at enqueue; `data.prUrl`, `data.fix`.
    #[serde(rename = "change.refused")]
    ChangeRefused,
    /// M4: a machine's login hit the same limit on several threads, or its proxy has no account; dispatch there pauses.
    #[serde(rename = "usage.breaker")]
    UsageBreaker,
    /// M4: parked threads were sent "continue" at their reset or on usage_resume; `data.breakerCleared`.
    #[serde(rename = "usage.resumed")]
    UsageResumed,
    /// M11: doctor checks changed status; `data.changes` lists `{ id, from, to }` (from absent on the first run).
    #[serde(rename = "doctor.changed")]
    DoctorChanged,
    /// A device redeemed a pairing code from `fleetd pair` and got a human key; `data.keyId`, `data.deviceName`.
    #[serde(rename = "key.paired")]
    KeyPaired,
    /// A prompt override was saved or reset: `data.id`, `data.scope`, `data.projectRef`, `data.ref` (absent on reset),
    /// `data.warnings` (their codes). The text is not in the event; prompt_get reads it.
    #[serde(rename = "prompt.changed")]
    PromptChanged,
    /// This release changed the default of a prompt you overrode; yours stays in effect until you save it again or
    /// reset it: `data.id`, `data.scope`, `data.projectRef`, `data.base`, `data.current`.
    #[serde(rename = "prompt.default_changed")]
    PromptDefaultChanged,
    /// A steer was stored (or put in the offline queue). `data` is a `SteerEventData`, plus `data.text` (first 120
    /// characters), `data.mode` and `data.by`.
    #[serde(rename = "steer.queued")]
    SteerQueued,
    /// claude took the steer in; `data.how`.
    #[serde(rename = "steer.delivered")]
    SteerDelivered,
    /// The agent replied after taking it in (`data.excerpt`), or a lead call named it.
    #[serde(rename = "steer.acknowledged")]
    SteerAcknowledged,
    /// The steer's run ended with no reply after it was delivered.
    #[serde(rename = "steer.unacknowledged")]
    SteerUnacknowledged,
    #[serde(rename = "steer.withdrawn")]
    SteerWithdrawn,
    /// Refused by the node, the process exited before taking it in, or it expired in the offline queue;
    /// `data.reason`.
    #[serde(rename = "steer.failed")]
    SteerFailed,
    /// No longer sent (plans were removed); kept so an older log still reads.
    #[serde(rename = "plan.changed")]
    PlanChanged,
    /// No longer sent (plans were removed); kept so an older log still reads.
    #[serde(rename = "plan.verified")]
    PlanVerified,
    /// A merge-train Change moved between states; `data.changeId`, `data.workstreamId`, `data.repo`, `data.prNumber`,
    /// `data.from`, `data.to`.
    #[serde(rename = "change.state")]
    ChangeState,
    /// Main-branch CI of a train repo changed state; `data.repo`, `data.sha`, `data.state`, `data.failing`.
    #[serde(rename = "ci.main")]
    CiMain,
    /// A status source went quiet past its cadence; `data.source`, `data.sinceMs`, `data.reason`.
    #[serde(rename = "source.stale")]
    SourceStale,
    /// A stale source answered again; `data.source`, `data.staleMs`.
    #[serde(rename = "source.fresh")]
    SourceFresh,
    /// A project's chat got a message, or one of its messages finished streaming or had an inline item change state;
    /// `data` is `chat::ChatMessageEventData`.
    #[serde(rename = "chat.message")]
    ChatMessage,
    /// A project's chat started or stopped waiting on you, or its lead started or ended a turn; `data` is the
    /// `chat::ProjectChatState`.
    #[serde(rename = "chat.waiting")]
    ChatWaiting,
    /// The app was focused on a project's screen with recent input, for one interval; `data` is
    /// `metrics::AppPresenceData`. A human touch for the factory metrics.
    #[serde(rename = "app.presence")]
    AppPresence,
    /// A node's fetch saw a remote's default branch move; `data` is `metrics::RepoAdvancedData`.
    #[serde(rename = "repo.advanced")]
    RepoAdvanced,
    /// Work was claimed on a repo's base; `data` is `work::WorkEventData`.
    #[serde(rename = "work.claimed")]
    WorkClaimed,
    /// A claim landed, was released or expired; `data` is `work::WorkEventData`.
    #[serde(rename = "work.ended")]
    WorkEnded,
    /// A commit reached a watched base, by the train, a PR merged outside it or a direct push; `data` is
    /// `work::WorkLandedData`.
    #[serde(rename = "work.landed")]
    WorkLanded,
}

impl HubEventType {
    /// The wire name, e.g. "thread.completed".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MachineOnline => "machine.online",
            Self::MachineOffline => "machine.offline",
            Self::MachineDegraded => "machine.degraded",
            Self::MachineSlept => "machine.slept",
            Self::MachineGuard => "machine.guard",
            Self::ProjectRemoved => "project.removed",
            Self::ProjectAdded => "project.added",
            Self::ProjectCloneProgress => "project.clone_progress",
            Self::ProjectAddFailed => "project.add_failed",
            Self::ProjectFetchFailed => "project.fetch_failed",
            Self::ProjectSettings => "project.settings",
            Self::ThreadStarted => "thread.started",
            Self::ThreadCompleted => "thread.completed",
            Self::ThreadFailed => "thread.failed",
            Self::ThreadInterrupted => "thread.interrupted",
            Self::ThreadWaiting => "thread.waiting",
            Self::ThreadUsageLimited => "thread.usage_limited",
            Self::WakeFired => "wake.fired",
            Self::WakeMissed => "wake.missed",
            Self::WriteDelivered => "write.delivered",
            Self::WriteExpired => "write.expired",
            Self::WorkstreamCreated => "workstream.created",
            Self::WorkstreamRunning => "workstream.running",
            Self::WorkstreamState => "workstream.state",
            Self::RequestOpened => "request.opened",
            Self::RequestUpdated => "request.updated",
            Self::DecisionRecorded => "decision.recorded",
            Self::LeadStarted => "lead.started",
            Self::LeadWoken => "lead.woken",
            Self::TaskQueued => "task.queued",
            Self::TaskStarted => "task.started",
            Self::TaskCompleted => "task.completed",
            Self::TaskFailed => "task.failed",
            Self::TaskCancelled => "task.cancelled",
            Self::AgentsCap => "agents.cap",
            Self::WorkstreamDone => "workstream.done",
            Self::ReviewVerdict => "review.verdict",
            Self::ChangeQueued => "change.queued",
            Self::ChangeReady => "change.ready",
            Self::ChangeNeedsRebase => "change.needs_rebase",
            Self::ChangeCiFailed => "change.ci_failed",
            Self::PrMerged => "pr.merged",
            Self::PrMergedOutside => "pr.merged_outside",
            Self::ChangeRefused => "change.refused",
            Self::UsageBreaker => "usage.breaker",
            Self::UsageResumed => "usage.resumed",
            Self::DoctorChanged => "doctor.changed",
            Self::KeyPaired => "key.paired",
            Self::PromptChanged => "prompt.changed",
            Self::PromptDefaultChanged => "prompt.default_changed",
            Self::SteerQueued => "steer.queued",
            Self::SteerDelivered => "steer.delivered",
            Self::SteerAcknowledged => "steer.acknowledged",
            Self::SteerUnacknowledged => "steer.unacknowledged",
            Self::SteerWithdrawn => "steer.withdrawn",
            Self::SteerFailed => "steer.failed",
            Self::PlanChanged => "plan.changed",
            Self::PlanVerified => "plan.verified",
            Self::ChangeState => "change.state",
            Self::CiMain => "ci.main",
            Self::SourceStale => "source.stale",
            Self::SourceFresh => "source.fresh",
            Self::ChatMessage => "chat.message",
            Self::ChatWaiting => "chat.waiting",
            Self::AppPresence => "app.presence",
            Self::RepoAdvanced => "repo.advanced",
            Self::WorkClaimed => "work.claimed",
            Self::WorkEnded => "work.ended",
            Self::WorkLanded => "work.landed",
        }
    }
}

/// Whether an event needs the human now, set by the hub when it emits the event. "loud": notify, but hold it through
/// quiet hours; "urgent": notify even during quiet hours (money and irreversible). Absent: the inbox and the digest
/// are enough.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Attention {
    Loud,
    Urgent,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HubEvent {
    /// Hub-global and monotonic.
    pub seq: EventSeq,
    pub at: Timestamp,
    pub r#type: HubEventType,
    pub machine_id: Option<MachineId>,
    pub project_id: Option<ProjectId>,
    pub thread_id: Option<ThreadId>,
    /// Plain language.
    pub summary: Text<0, 200>,
    /// At most 2 KB of JSON; the hub trims before emitting.
    pub data: Option<serde_json::Value>,
    pub attention: Option<Attention>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadEventReason {
    Stalled,
    UsageLimit,
    Interrupted,
}

/// Fields `HubEvent.data` may carry on `thread.*` events, alongside whatever else the hub adds.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventData {
    pub run_id: Option<String>,
    /// The run ended while the hub was down and this event was emitted on its return.
    pub late: Option<bool>,
    pub reason: Option<ThreadEventReason>,
    /// Why the run ended: on `thread.completed`, `.failed`, `.interrupted` and `.usage_limited` from a node that
    /// records it.
    pub end_cause: Option<RunEnd>,
}

// The `HubEvent.data` shapes below are what the hub's emitters write (each names its event types). Fields the hub
// adds only on some paths are optional; any `data` over 2 KB arrives as `{ "truncated": true }` instead.

/// `workstream.created`, `workstream.running`, `workstream.state`, `workstream.done`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamEventData {
    pub workstream_id: WorkstreamId,
    /// workstream.state: the new state.
    pub state: Option<WorkstreamState>,
    /// workstream.state: the brief was set or edited.
    pub brief_edited: Option<bool>,
    /// workstream.state (stopped) and workstream.done: why, and who.
    pub reason: Option<String>,
    pub by: Option<String>,
}

/// `request.opened`, `request.updated`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestEventData {
    pub request_id: ChatRequestId,
    pub kind: RequestKind,
    pub state: RequestState,
    /// The order it is about, when it is about one.
    pub workstream_id: Option<WorkstreamId>,
    /// Who answered it ("human:<device>"), once someone did.
    pub by: Option<String>,
}

/// The merge train's events: `change.queued`, `change.ready`, `change.needs_rebase`, `change.ci_failed`,
/// `change.refused`, `pr.merged`, `pr.merged_outside`. Which fields each carries is in
/// `HubEventType`'s docs.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrainEventData {
    pub change_id: Option<ChangeId>,
    pub workstream_id: Option<WorkstreamId>,
    /// pr.merged: the writer task whose PR it was, when a task wrote it.
    pub task_id: Option<crate::tasks::TaskId>,
    pub repo: Option<GitHubRepo>,
    pub pr_number: Option<Count>,
    pub pr_url: Option<String>,
    pub merged_sha: Option<String>,
    /// pr.merged, pr.merged_outside: when it landed on the git host.
    pub merged_at: Option<Timestamp>,
    /// pr.merged: the train's batch PR it landed in.
    pub batch_pr: Option<Count>,
    /// pr.merged_outside: the PR's head branch and when it was opened.
    pub head: Option<String>,
    /// pr.merged, pr.merged_outside: the branch it merged into.
    pub base: Option<String>,
    pub pr_created_at: Option<Timestamp>,
    /// pr.merged_outside: who opened and who merged it, by the git host's account type.
    pub author_kind: Option<crate::metrics::ActorKind>,
    pub merged_by_kind: Option<crate::metrics::ActorKind>,
    /// pr.merged_outside: the merger's login on the git host, so a merge by the person's own account is their touch.
    pub merged_by: Option<String>,
    /// pr.merged on a repo with no CI: what fleetd checked instead.
    pub ci: Option<String>,
    /// change.ci_failed: the failing check names.
    pub checks: Option<Vec<String>>,
    pub log_url: Option<String>,
    pub reason: Option<String>,
    pub fix: Option<String>,
}

/// `prompt.changed`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptChangedData {
    pub id: String,
    pub scope: PromptScope,
    pub project_ref: Option<ProjectRef>,
    /// Absent on a reset.
    pub r#ref: Option<String>,
    /// The warnings' codes.
    pub warnings: Option<Vec<String>>,
}

/// `machine.guard`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineGuardData {
    /// true: new agents wait; false: they start again.
    pub paused: bool,
}

/// `machine.slept`: epoch milliseconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineSleptData {
    pub from_ms: i64,
    pub to_ms: i64,
}
