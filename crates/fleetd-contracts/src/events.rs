use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{EventSeq, MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use crate::ledger::{
    AskClass, AskId, AskKind, AskState, BatchId, BriefHash, DecisionId, DecisionKey, WorkstreamId,
    WorkstreamState,
};
use crate::prim::{Count, Positive, Text};
use crate::prompts::PromptScope;
use crate::steer::SteerId;
use crate::train::{ChangeId, GitHubRepo};
use crate::verification::ClaimId;

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
    /// No progress past the stall threshold; the hub interrupts and nudges once.
    #[serde(rename = "thread.stalled")]
    ThreadStalled,
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
    /// A webhook subscription has been failing for over an hour.
    #[serde(rename = "webhook.failing")]
    WebhookFailing,
    #[serde(rename = "workstream.created")]
    WorkstreamCreated,
    /// The brief was frozen; `data.briefHash`.
    #[serde(rename = "workstream.running")]
    WorkstreamRunning,
    #[serde(rename = "workstream.state")]
    WorkstreamState,
    #[serde(rename = "ask.created")]
    AskCreated,
    /// An ask was answered from the decision log and never reached a batch.
    #[serde(rename = "ask.auto")]
    AskAuto,
    /// An open ask stopped being open (answered, withdrawn); `data.askId`, `data.key`, `data.state`, and
    /// `data.workstreamId` when it was about an order. Everything that counts open asks recomputes on it.
    #[serde(rename = "ask.closed")]
    AskClosed,
    /// A decide ask was answered; `data.askId`, `data.undoUntil`. Its decision and the lead's wake follow once the
    /// undo window passes.
    #[serde(rename = "ask.answered")]
    AskAnswered,
    /// An answer was taken back inside its undo window; the ask is open again. `data.askId`.
    #[serde(rename = "ask.undone")]
    AskUndone,
    /// The receipt: the lead was woken with the answer. `data.askId`, `data.deliveredAt`, `data.decisionId` (absent
    /// for a skip).
    #[serde(rename = "ask.delivered")]
    AskDelivered,
    #[serde(rename = "batch.ready")]
    BatchReady,
    #[serde(rename = "decision.recorded")]
    DecisionRecorded,
    #[serde(rename = "lead.started")]
    LeadStarted,
    #[serde(rename = "lead.woken")]
    LeadWoken,
    /// The human digest is ready; no project content, since every key sees it. Read it with digest_get. `data.at`.
    #[serde(rename = "digest.ready")]
    DigestReady,
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
    /// A write task's diff touched files outside its leased areas; `data.paths`.
    #[serde(rename = "task.out_of_area")]
    TaskOutOfArea,
    /// A project's max agents or the fleet cap changed; `data` is `tasks::AgentsCapData`, `summary` the chat's line.
    #[serde(rename = "agents.cap")]
    AgentsCap,
    /// A lease held for over 4 h; flagged once, never released by the hub. `data.taskId`, `data.area`.
    #[serde(rename = "lease.stale")]
    LeaseStale,
    /// A claim had a failing check; the workstream stays verifying. `data.claimId`, `data.workstreamId`.
    #[serde(rename = "claim.failed")]
    ClaimFailed,
    #[serde(rename = "claim.passed")]
    ClaimPassed,
    /// Every done-when check passed. `data.workstreamId`.
    #[serde(rename = "workstream.done")]
    WorkstreamDone,
    /// `data.taskId`, `data.prHeadSha`, `data.blocking`.
    #[serde(rename = "review.verdict")]
    ReviewVerdict,
    /// `data.incidentId`, `data.class`.
    #[serde(rename = "incident.recorded")]
    IncidentRecorded,
    /// `data.changeId`, `data.repo`, `data.prNumber`.
    #[serde(rename = "change.queued")]
    ChangeQueued,
    /// Its tier's reviews are satisfied for the current patch id. `data.changeId`.
    #[serde(rename = "change.ready")]
    ChangeReady,
    /// The rebase conflicted; `data.changeId`, `data.paths`.
    #[serde(rename = "change.needs_rebase")]
    ChangeNeedsRebase,
    /// `data.changeId`, `data.checks` (failing check names), `data.logUrl`.
    #[serde(rename = "change.ci_failed")]
    ChangeCiFailed,
    /// `data.changeId`, `data.repo`, `data.prNumber`, `data.mergedSha`; `data.ci` when the repo had no CI and the
    /// train merged on fleetd's own checks.
    #[serde(rename = "pr.merged")]
    PrMerged,
    /// `data.repo`, `data.reason`.
    #[serde(rename = "train.frozen")]
    TrainFrozen,
    /// `data.repo`.
    #[serde(rename = "train.resumed")]
    TrainResumed,
    /// Something that is not the train's sits where its worktree goes, and a person has to move it; `data.changeId`,
    /// `data.repo`, `data.error` (what to move).
    #[serde(rename = "train.blocked")]
    TrainBlocked,
    /// Refused at enqueue; `data.prUrl`, `data.fix`.
    #[serde(rename = "change.refused")]
    ChangeRefused,
    /// Where an intent went; `data.workstreamId` or `data.askId`, `data.template`, `data.reason`, `data.playbook`.
    #[serde(rename = "intake.routed")]
    IntakeRouted,
    /// A research workstream's computed verdict; `data.workstreamId`, `data.outcome`, `data.metricValues`.
    #[serde(rename = "research.verdict")]
    ResearchVerdict,
    /// M4: a machine's login hit the same limit on several threads, or its proxy has no account; dispatch there pauses.
    #[serde(rename = "usage.breaker")]
    UsageBreaker,
    /// M4: parked threads were sent "continue" at their reset or on usage_resume; `data.breakerCleared`.
    #[serde(rename = "usage.resumed")]
    UsageResumed,
    /// M8: the node wrote a secret's sink. `data.askId`, `data.fingerprint`, `data.by` (the human who submitted it).
    #[serde(rename = "ask.secret_saved")]
    AskSecretSaved,
    /// M8: the node ran an approved command. `data.askId`, `data.exitCode`, `data.timedOut`, `data.by` (the approver).
    #[serde(rename = "gated.ran")]
    GatedRan,
    /// M11: doctor checks changed status; `data.changes` lists `{ id, from, to }` (from absent on the first run).
    #[serde(rename = "doctor.changed")]
    DoctorChanged,
    /// M12: a retro run ended; `data.run`, `data.trigger`, `data.advise`, `data.proposals`, `data.dropped`, `data.usage` (orchestrator runs).
    #[serde(rename = "retro.ran")]
    RetroRan,
    /// M12: a playbook file changed under a retro proposal; `data.proposalId`, `data.playbook`, `data.ref`, `data.previousRef`, `data.kind`, `data.baseline`, `data.dueAt`.
    #[serde(rename = "playbook.changed")]
    PlaybookChanged,
    /// M12: a wording change missed its metric or regressed a guarded one and was rolled back; `data.proposalId`, `data.reason`.
    #[serde(rename = "playbook.reverted")]
    PlaybookReverted,
    /// M12: a wording change met its metric; `data.proposalId`, `data.measured`.
    #[serde(rename = "playbook.kept")]
    PlaybookKept,
    /// A device redeemed a pairing code from `fleetd pair` and got a human key; `data.keyId`, `data.deviceName`.
    #[serde(rename = "key.paired")]
    KeyPaired,
    /// A person added to an order for its lead: `data.workstreamId`, `data.noteId`, `data.urgent`, `data.text` (first
    /// 200 characters).
    #[serde(rename = "workstream.note")]
    WorkstreamNote,
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
    /// The agent named the steer (`data.excerpt`), or a lead call did.
    #[serde(rename = "steer.acknowledged")]
    SteerAcknowledged,
    /// The steer's run ended with no reply naming it; `data.excerpt` is its first reply.
    #[serde(rename = "steer.unacknowledged")]
    SteerUnacknowledged,
    #[serde(rename = "steer.withdrawn")]
    SteerWithdrawn,
    /// Refused by the node, the process exited before taking it in, or it expired in the offline queue;
    /// `data.reason`.
    #[serde(rename = "steer.failed")]
    SteerFailed,
    /// A plan's scope changed and a marker was written; `data` is the `PlanChange` (`status::PlanChangedData`).
    #[serde(rename = "plan.changed")]
    PlanChanged,
    /// The hub verified a plan item done; `data.itemId`, `data.milestoneId`, `data.workstreamId`, `data.evidence`.
    #[serde(rename = "plan.verified")]
    PlanVerified,
    /// A merge-train Change moved between states; `data.changeId`, `data.workstreamId`, `data.repo`, `data.prNumber`,
    /// `data.from`, `data.to`.
    #[serde(rename = "change.state")]
    ChangeState,
    /// Main-branch CI of a train repo changed state; `data.repo`, `data.sha`, `data.state`, `data.failing`.
    #[serde(rename = "ci.main")]
    CiMain,
    /// Reconciliation found GitHub moved without fleetd; `data.repo`, `data.kind`, `data.what`, `data.lagMs`.
    #[serde(rename = "github.drift")]
    GithubDrift,
    /// A status source went quiet past its cadence; `data.source`, `data.sinceMs`, `data.reason`.
    #[serde(rename = "source.stale")]
    SourceStale,
    /// A stale source answered again; `data.source`, `data.staleMs`.
    #[serde(rename = "source.fresh")]
    SourceFresh,
}

impl HubEventType {
    /// The wire name, e.g. "thread.completed".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MachineOnline => "machine.online",
            Self::MachineOffline => "machine.offline",
            Self::MachineDegraded => "machine.degraded",
            Self::MachineSlept => "machine.slept",
            Self::ProjectRemoved => "project.removed",
            Self::ProjectAdded => "project.added",
            Self::ProjectCloneProgress => "project.clone_progress",
            Self::ProjectAddFailed => "project.add_failed",
            Self::ThreadStarted => "thread.started",
            Self::ThreadCompleted => "thread.completed",
            Self::ThreadFailed => "thread.failed",
            Self::ThreadInterrupted => "thread.interrupted",
            Self::ThreadWaiting => "thread.waiting",
            Self::ThreadUsageLimited => "thread.usage_limited",
            Self::ThreadStalled => "thread.stalled",
            Self::WakeFired => "wake.fired",
            Self::WakeMissed => "wake.missed",
            Self::WriteDelivered => "write.delivered",
            Self::WriteExpired => "write.expired",
            Self::WebhookFailing => "webhook.failing",
            Self::WorkstreamCreated => "workstream.created",
            Self::WorkstreamRunning => "workstream.running",
            Self::WorkstreamState => "workstream.state",
            Self::AskCreated => "ask.created",
            Self::AskAuto => "ask.auto",
            Self::AskClosed => "ask.closed",
            Self::AskAnswered => "ask.answered",
            Self::AskUndone => "ask.undone",
            Self::AskDelivered => "ask.delivered",
            Self::BatchReady => "batch.ready",
            Self::DecisionRecorded => "decision.recorded",
            Self::LeadStarted => "lead.started",
            Self::LeadWoken => "lead.woken",
            Self::DigestReady => "digest.ready",
            Self::TaskQueued => "task.queued",
            Self::TaskStarted => "task.started",
            Self::TaskCompleted => "task.completed",
            Self::TaskFailed => "task.failed",
            Self::TaskCancelled => "task.cancelled",
            Self::TaskOutOfArea => "task.out_of_area",
            Self::AgentsCap => "agents.cap",
            Self::LeaseStale => "lease.stale",
            Self::ClaimFailed => "claim.failed",
            Self::ClaimPassed => "claim.passed",
            Self::WorkstreamDone => "workstream.done",
            Self::ReviewVerdict => "review.verdict",
            Self::IncidentRecorded => "incident.recorded",
            Self::ChangeQueued => "change.queued",
            Self::ChangeReady => "change.ready",
            Self::ChangeNeedsRebase => "change.needs_rebase",
            Self::ChangeCiFailed => "change.ci_failed",
            Self::PrMerged => "pr.merged",
            Self::TrainFrozen => "train.frozen",
            Self::TrainResumed => "train.resumed",
            Self::TrainBlocked => "train.blocked",
            Self::ChangeRefused => "change.refused",
            Self::IntakeRouted => "intake.routed",
            Self::ResearchVerdict => "research.verdict",
            Self::UsageBreaker => "usage.breaker",
            Self::UsageResumed => "usage.resumed",
            Self::AskSecretSaved => "ask.secret_saved",
            Self::GatedRan => "gated.ran",
            Self::DoctorChanged => "doctor.changed",
            Self::RetroRan => "retro.ran",
            Self::PlaybookChanged => "playbook.changed",
            Self::PlaybookReverted => "playbook.reverted",
            Self::PlaybookKept => "playbook.kept",
            Self::KeyPaired => "key.paired",
            Self::WorkstreamNote => "workstream.note",
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
            Self::GithubDrift => "github.drift",
            Self::SourceStale => "source.stale",
            Self::SourceFresh => "source.fresh",
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
    /// workstream.running: the frozen brief.
    pub brief_hash: Option<BriefHash>,
    /// workstream.state (verifying) and workstream.done: the claim that moved it.
    pub claim_id: Option<ClaimId>,
    /// workstream.state (stopped): why, and who.
    pub reason: Option<String>,
    pub by: Option<String>,
}

/// `ask.created`, `ask.auto`, `ask.closed`, `ask.answered`, `ask.undone`, `ask.delivered`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskEventData {
    pub ask_id: AskId,
    /// The order it is about, when it is about one (ask.closed always says).
    pub workstream_id: Option<WorkstreamId>,
    /// ask.closed: the state it closed in.
    pub state: Option<AskState>,
    pub key: Option<DecisionKey>,
    pub class: Option<AskClass>,
    pub kind: Option<AskKind>,
    pub batch_id: Option<BatchId>,
    pub number: Option<Positive>,
    /// ask.created: a closed ask opened again (a failed verify, an undone answer).
    pub reopened: Option<bool>,
    /// ask.auto and ask.delivered: the decision that answered it (absent on a delivered skip).
    pub decision_id: Option<DecisionId>,
    /// ask.answered: until then `inbox_undo` takes the answer back.
    pub undo_until: Option<Timestamp>,
    /// ask.delivered: when the lead was woken with the answer.
    pub delivered_at: Option<Timestamp>,
}

/// `claim.passed`, `claim.failed`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimEventData {
    pub claim_id: ClaimId,
    pub workstream_id: WorkstreamId,
    /// claim.failed: the done-when indexes that did not pass.
    pub failing: Option<Vec<Count>>,
}

/// The merge train's events: `change.queued`, `change.ready`, `change.needs_rebase`, `change.ci_failed`,
/// `change.refused`, `pr.merged`, `train.frozen`, `train.resumed`, `train.blocked`. Which fields each carries is in
/// `HubEventType`'s docs.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrainEventData {
    pub change_id: Option<ChangeId>,
    pub workstream_id: Option<WorkstreamId>,
    pub repo: Option<GitHubRepo>,
    pub pr_number: Option<Count>,
    pub pr_url: Option<String>,
    pub merged_sha: Option<String>,
    /// pr.merged on a repo with no CI: what fleetd checked instead.
    pub ci: Option<String>,
    /// change.needs_rebase: the conflicting paths.
    pub paths: Option<Vec<String>>,
    /// change.ci_failed: the failing check names.
    pub checks: Option<Vec<String>>,
    pub log_url: Option<String>,
    pub reason: Option<String>,
    pub fix: Option<String>,
    /// train.blocked: what a person has to move.
    pub error: Option<String>,
}

/// `workstream.note`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamNoteData {
    pub workstream_id: WorkstreamId,
    pub client_request_id: Option<String>,
    pub urgent: Option<bool>,
    /// The first 200 characters.
    pub text: Option<String>,
    /// The steer the note became.
    pub steer_id: Option<SteerId>,
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

/// `machine.slept`: epoch milliseconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineSleptData {
    pub from_ms: i64,
    pub to_ms: i64,
}
