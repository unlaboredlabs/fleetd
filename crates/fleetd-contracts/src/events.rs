use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{EventSeq, MachineId, ProjectId, ThreadId, Timestamp};
use crate::prim::Text;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub enum HubEventType {
    #[serde(rename = "machine.online")]
    MachineOnline,
    #[serde(rename = "machine.offline")]
    MachineOffline,
    #[serde(rename = "machine.degraded")]
    MachineDegraded,
    /// The node no longer has the project: the hub dropped it from its cache, and its open workstreams stop. `data.title`.
    #[serde(rename = "project.removed")]
    ProjectRemoved,
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
    /// `data.changeId`, `data.repo`, `data.prNumber`, `data.mergedSha`.
    #[serde(rename = "pr.merged")]
    PrMerged,
    /// `data.repo`, `data.reason`.
    #[serde(rename = "train.frozen")]
    TrainFrozen,
    /// `data.repo`.
    #[serde(rename = "train.resumed")]
    TrainResumed,
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
}

impl HubEventType {
    /// The wire name, e.g. "thread.completed".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MachineOnline => "machine.online",
            Self::MachineOffline => "machine.offline",
            Self::MachineDegraded => "machine.degraded",
            Self::ProjectRemoved => "project.removed",
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
