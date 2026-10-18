//! App state and its reducer. Everything the hub says arrives through [`State::apply`], every user
//! action through a method here; each returns the frames to send. No I/O, so it is unit-tested.
//!
//! Sync model: on every (re)connect, take a snapshot, start the event stream from its cursor, then
//! fetch each project's outcome and the open asks. Events only mark things to refetch. A refetch
//! asked for while the same one is in flight runs once more when it lands, never twice at once.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use fleetd_contracts::app::{AppCallId, AppClientMessage, AppServerMessage};
use fleetd_contracts::doctor::{DoctorCheck, DoctorCheckId};
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::{MachineId, ProjectId, Timestamp};
use fleetd_contracts::ledger::{Ask, AskId, AskState, Batch, BatchId, BatchState, Lead, LeadState, PlaybookName, Workstream, WorkstreamId};
use fleetd_contracts::live::OrderCard;
use fleetd_contracts::mcp::{
    AsksListInput, AsksListOutput, AttachmentId, AttachmentMime, AttachmentPutInput, AttachmentPutOutput, AttentionPolicyInput,
    AttentionPolicyOutput, DoctorFixInput, DoctorFixOutput, DoctorListInput, DoctorListOutput, FleetStatus, InboxReplyInput, InboxReplyOutput,
    IntakePreviewInput, IntakePreviewOutput, IntakeRef, IntakeSubmitInput, IntakeSubmitOutput, OrderGetInput, OrderGetOutput, OrderNoteInput,
    OrderNoteOutput, OrderStopInput, OrderStopOutput, OrdersBoardInput, OrdersBoardOutput, ProjectFilesInput, ProjectFilesOutput, ProjectGetInput,
    ProjectGetOutput, SecretSubmitInput, SecretSubmitOutput, TailItem, ThreadTailInput, ThreadTailOutput, ThreadWindowInput, ThreadWindowOutput,
    TimeBreakdownInput, TimeBreakdownOutput, TimeInsightsInput, TimeInsightsOutput, TimeRetentionSetInput, TimeRetentionSetOutput, TimeSpansInput,
    TimeSpansOutput,
};
use fleetd_contracts::model::{Machine, MachineStatus, ProjectOutcome, ProjectSummary, ThreadStatus, ThreadSummary};
use fleetd_contracts::prim::{Int, IntOr, List, Text};
use fleetd_contracts::secrets::{SealedSecret, parse_secret_sink};
use fleetd_contracts::time::{InsightRule, Span as TimeSpan, SpanKind, TimeScope};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::client::Incoming;
use crate::live::state::LiveState;
use crate::notify::{Notification, Notifier, Policy};
use fleetd_contracts::mcp::{
    EventsWaitInput, EventsWaitOutput, ProjectAddInput, ProjectAddOutput, ProjectDiscoverInput, ProjectDiscoverOutput, ProjectInspectInput,
    ProjectInspectOutput,
};
use fleetd_contracts::mcp::{
    PromptGetInput, PromptGetOutput, PromptResetInput, PromptResetOutput, PromptSetInput, PromptSetOutput, PromptsListInput, PromptsListOutput,
    SessionPromptGetInput, SessionPromptGetOutput,
};
use fleetd_contracts::mcp::{StatusGetInput, StatusGetOutput, StatusSeenInput, StatusSeenOutput, StatusWaitInput, StatusWaitOutput};

/// A tool the app calls: its input type, wire name and output type.
pub(crate) trait Tool: Serialize {
    const NAME: &'static str;
    type Output: DeserializeOwned;
}

macro_rules! tools {
    ($($input:ident => $output:ident, $name:literal;)*) => {
        $(impl Tool for $input {
            const NAME: &'static str = $name;
            type Output = $output;
        })*
    };
}

tools! {
    ProjectGetInput => ProjectGetOutput, "project_get";
    ThreadTailInput => ThreadTailOutput, "thread_tail";
    AsksListInput => AsksListOutput, "asks_list";
    InboxReplyInput => InboxReplyOutput, "inbox_reply";
    SecretSubmitInput => SecretSubmitOutput, "secret_submit";
    AttentionPolicyInput => AttentionPolicyOutput, "attention_policy";
    DoctorListInput => DoctorListOutput, "doctor_list";
    DoctorFixInput => DoctorFixOutput, "doctor_fix";
    IntakeSubmitInput => IntakeSubmitOutput, "intake_submit";
    OrdersBoardInput => OrdersBoardOutput, "orders_board";
    OrderGetInput => OrderGetOutput, "order_get";
    OrderNoteInput => OrderNoteOutput, "order_note";
    OrderStopInput => OrderStopOutput, "order_stop";
    IntakePreviewInput => IntakePreviewOutput, "intake_preview";
    AttachmentPutInput => AttachmentPutOutput, "attachment_put";
    ProjectFilesInput => ProjectFilesOutput, "project_files";
    PromptsListInput => PromptsListOutput, "prompts_list";
    PromptGetInput => PromptGetOutput, "prompt_get";
    PromptSetInput => PromptSetOutput, "prompt_set";
    PromptResetInput => PromptResetOutput, "prompt_reset";
    SessionPromptGetInput => SessionPromptGetOutput, "session_prompt_get";
    TimeSpansInput => TimeSpansOutput, "time_spans";
    TimeBreakdownInput => TimeBreakdownOutput, "time_breakdown";
    TimeInsightsInput => TimeInsightsOutput, "time_insights";
    TimeRetentionSetInput => TimeRetentionSetOutput, "time_retention_set";
    ThreadWindowInput => ThreadWindowOutput, "thread_window";
    ProjectDiscoverInput => ProjectDiscoverOutput, "project_discover";
    ProjectAddInput => ProjectAddOutput, "project_add";
    ProjectInspectInput => ProjectInspectOutput, "project_inspect";
    EventsWaitInput => EventsWaitOutput, "events_wait";
    StatusGetInput => StatusGetOutput, "status_get";
    StatusWaitInput => StatusWaitOutput, "status_wait";
    StatusSeenInput => StatusSeenOutput, "status_seen";
}

/// (machineId, projectId)
pub type ProjectKey = (String, String);

/// Messages in the lead log tail.
pub const TAIL_N: i64 = 50;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Purpose {
    Asks,
    Project(ProjectKey),
    Tail(ProjectKey),
    Reply,
    Doctor,
    DoctorRerun,
    DoctorFix(DoctorCheckId),
    /// `saved` is what the echo says on success, e.g. "STRIPE_KEY saved on lab-a".
    Secret {
        ask_id: String,
        saved: String,
    },
    Policy,
    /// A new order, keyed by its clientRequestId (the card it shows as while in flight).
    Order {
        request_id: String,
    },
    /// One project's order cards.
    Board(ProjectKey),
    /// The open order's detail.
    OrderGet(String),
    /// A follow-up note to an order, keyed by its clientRequestId.
    OrderNote {
        request_id: String,
    },
    OrderStop(String),
    /// The router's guess for the composer's text.
    Preview,
    /// One attachment upload, by the composer's local id.
    Attach(u64),
    /// File paths for the @ menu.
    Files {
        query: String,
    },
    /// Settings → Prompts and Instructions, and the "what this agent was told" sheet.
    Prompt(crate::prompts::Call),
    /// The Status view, tagged with the view generation it was sent for, so an answer for a closed or re-aimed
    /// view is dropped.
    Status(crate::status::Call, u64),
    /// The time inspector, tagged with the query generation it was sent for, so a page for an older query is dropped.
    Time(TimeCall, u64),
    /// The Add project sheet: what's there to add, and the add itself.
    AddDiscover,
    AddProject,
    /// Whether a clone's existing folder is that repo, before offering to add it.
    AddInspect,
    /// The add's events since it started, looked up after a reconnect.
    AddRecover,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TimeCall {
    Breakdown,
    Insights,
    /// One page of the open order's spans.
    Spans,
    /// The spans a finding or a breakdown row links to.
    Linked,
    Window,
    Retention,
    /// Settings → Data: the retention and the stored size.
    Store,
}

impl Purpose {
    /// One-shot user actions: never coalesced, never redone.
    fn one_shot(&self) -> bool {
        matches!(
            self,
            Purpose::Reply
                | Purpose::DoctorRerun
                | Purpose::DoctorFix(_)
                | Purpose::Secret { .. }
                | Purpose::Order { .. }
                | Purpose::OrderNote { .. }
                | Purpose::OrderStop(_)
                | Purpose::Preview
                | Purpose::Attach(_)
                | Purpose::Files { .. }
                | Purpose::Prompt(_)
                | Purpose::Time(TimeCall::Spans | TimeCall::Linked | TimeCall::Window | TimeCall::Retention, _)
                | Purpose::AddDiscover
                | Purpose::AddProject
                | Purpose::AddInspect
                | Purpose::AddRecover
                | Purpose::Status(crate::status::Call::Seen | crate::status::Call::Digest, _)
        )
    }
}

/// Hub events kept per order for the order view's coalesced "T31 started, #211 merged" lines.
const ORDER_EVENTS: usize = 40;

/// An order the composer sent: a card on the board from the moment Enter is pressed (spec 2.3, "what happens on
/// send"), until the board lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct SentOrder {
    pub request_id: String,
    pub to: Option<ProjectKey>,
    pub text: String,
    pub template: Option<PlaybookName>,
    pub attachments: Vec<String>,
    pub refs: Vec<IntakeRef>,
    pub status: Sent,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Sent {
    Sending,
    /// The hub made workstream `workstream_id` in `project`; it stays until that project's board lists it.
    Placed {
        workstream_id: String,
        project: Option<ProjectKey>,
        lead_waiting: Option<String>,
    },
    /// The router couldn't place it: answering this ask picks the project.
    Unrouted {
        ask_id: String,
    },
    Failed(String),
}

impl SentOrder {
    /// The card's title: the first line of the text.
    pub fn title(&self) -> &str {
        self.text.lines().next().unwrap_or_default()
    }
}

/// A follow-up note, shown above the follow-up composer until the lead wakes for it.
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub request_id: String,
    pub text: String,
    pub urgent: bool,
    pub status: NoteStatus,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NoteStatus {
    Sending,
    /// Recorded; waits for the lead's next wake (or was steered in, `urgent`).
    Queued,
    Failed(String),
}

/// The order view's own data, next to the lanes kept in [`LiveState`].
pub struct OrderView {
    pub workstream_id: String,
    pub key: Option<ProjectKey>,
    pub card: Option<OrderCard>,
    pub claims: Vec<fleetd_contracts::verification::Claim>,
    pub loaded: bool,
    pub error: Option<String>,
    pub notes: Vec<Note>,
    pub stopping: bool,
}

/// An attachment as the composer shows it: uploading, then its hub id or why not.
#[derive(Clone, Debug, PartialEq)]
pub enum Upload {
    Uploading,
    Done { attachment_id: String },
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Conn {
    Connecting { reason: Option<String>, retry_in: Option<Duration> },
    Live,
    Refused(String),
}

pub struct ProjectRow {
    pub summary: ProjectSummary,
    pub outcome: Option<ProjectOutcome>,
    pub error: Option<String>,
}

impl ProjectRow {
    pub fn key(&self) -> ProjectKey {
        (self.summary.machine_id.to_string(), self.summary.project_id.to_string())
    }

    pub fn lead(&self) -> Option<&Lead> {
        self.outcome.as_ref()?.lead.as_ref()
    }

    pub fn lead_thread(&self) -> Option<&ThreadSummary> {
        let lead = self.lead()?;
        self.outcome.as_ref()?.threads.iter().find(|t| t.thread_id == lead.thread_id)
    }

    pub fn workstreams(&self) -> &[Workstream] {
        self.outcome.as_ref().and_then(|o| o.workstreams.as_ref()).map_or(&[], |w| w.as_slice())
    }
}

pub struct Detail {
    pub key: ProjectKey,
    /// Oldest first.
    pub tail: Vec<TailItem>,
    pub tail_error: Option<String>,
    /// Bumped whenever `tail` changes, so the view rebuilds its log rows only then.
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Echo {
    pub text: String,
    pub ok: bool,
}

/// The setup checks, once the Machines screen has asked for them.
#[derive(Default)]
pub struct Doctor {
    pub checks: Vec<DoctorCheck>,
    pub checked_at: Option<fleetd_contracts::ids::Timestamp>,
    pub error: Option<String>,
}

/// One numbered inbox line.
pub struct InboxItem<'a> {
    pub batch_id: &'a BatchId,
    pub number: i64,
    pub ask: &'a Ask,
}

/// What the time inspector asks about. `spans` is set for an order: its timeline needs every span, the other
/// scopes show totals only.
#[derive(Clone, Debug, PartialEq)]
pub struct TimeQuery {
    pub scope: TimeScope,
    pub breakdown: TimeBreakdownInput,
    pub insights: TimeInsightsInput,
    pub spans: bool,
}

/// The spans a finding or a breakdown row links to: by rule, by kind, and narrowed on the client to one label or
/// check name.
#[derive(Clone, Debug, PartialEq)]
pub struct Linked {
    pub title: String,
    pub rule: Option<InsightRule>,
    pub kinds: Vec<SpanKind>,
    pub label: Option<String>,
    pub check: Option<String>,
}

impl Linked {
    pub fn keeps(&self, span: &TimeSpan) -> bool {
        (self.kinds.is_empty() || self.kinds.contains(&span.kind))
            && self.label.as_ref().is_none_or(|l| span.label.as_deref() == Some(l.as_str()))
            && self.check.as_ref().is_none_or(|c| span.extra.as_ref().and_then(|e| e.check.as_deref()) == Some(c.as_str()))
    }
}

/// Asked for; `None` until the hub answered.
pub type Pending<T> = Option<Result<T, String>>;
/// (machine, thread, item).
pub type ItemAt = (String, String, String);
pub type LinkedSpans = Option<(Linked, Pending<Vec<TimeSpan>>)>;
pub type TranscriptWindow = Option<(ItemAt, Pending<ThreadWindowOutput>)>;

#[derive(Default)]
pub struct TimeState {
    pub query: Option<TimeQuery>,
    generation: u64,
    pub breakdown: Option<Result<TimeBreakdownOutput, String>>,
    pub insights: Option<Result<TimeInsightsOutput, String>>,
    /// The open order's spans, oldest id first; pages keep arriving until `spans_done`.
    pub spans: Vec<TimeSpan>,
    pub spans_done: bool,
    pub spans_error: Option<String>,
    /// What the hub knows is missing from those spans.
    pub spans_coverage: Option<fleetd_contracts::time::Coverage>,
    /// What was asked for, and its spans once they arrived (the first page only: 500).
    pub linked: LinkedSpans,
    /// (machine, thread, item) and its transcript window.
    pub window: TranscriptWindow,
    /// (retention days, stored bytes), for Settings → Data.
    pub store: Option<Result<(i64, i64), String>>,
    /// Bumped on every answer, so the view rebuilds only when something arrived.
    pub version: u64,
}

pub struct State {
    pub conn: Conn,
    pub machines: Vec<Machine>,
    pub projects: Vec<ProjectRow>,
    pub attention: Vec<HubEvent>,
    pub batches: Vec<Batch>,
    pub asks: HashMap<String, Ask>,
    pub asks_error: Option<String>,
    pub echo: Option<Echo>,
    pub detail: Option<Detail>,
    /// None until first opened; from then on kept fresh on `doctor.changed`.
    pub doctor: Option<Doctor>,
    /// A hub error not tied to one call.
    pub notice: Option<String>,
    /// The hub's attention_policy; notifications wait until it is known.
    pub policy: Option<Policy>,
    /// Order cards, trains, machines and live lane values.
    pub live: LiveState,
    pub board_errors: HashMap<ProjectKey, String>,
    /// Orders sent from this app, newest last, until the board lists them.
    pub sent: Vec<SentOrder>,
    pub order: Option<OrderView>,
    /// The router's guess: (the text it was for, its project). `None` project = it couldn't place it.
    pub guess: Option<(String, Option<ProjectKey>)>,
    pub uploads: HashMap<u64, Upload>,
    /// The @ menu's file paths: (query, paths).
    pub files: Option<(String, Vec<String>)>,
    /// The project the last order went to, the composer's last-resort default.
    pub last_project: Option<ProjectKey>,
    /// Notes steered into a running lead turn, so the conversation can mark them.
    pub steered: VecDeque<String>,
    pub prompts: crate::prompts::Prompts,
    /// The time inspector's last answers, for the query it has open.
    pub time: TimeState,
    pub add: crate::project_add::Feed,
    /// The Status view's scope and its latest doc.
    pub status: crate::status::StatusState,
    order_events: HashMap<String, VecDeque<HubEvent>>,
    /// The live subscription last sent on this connection, and whether this hub streams live frames at all.
    live_sub: Option<(bool, Option<String>)>,
    live_frames: bool,
    live_unsupported: bool,
    notifier: Notifier,
    /// Open-asks fetches sent, and the number of the last one answered (see `Notifier::due`).
    asks_sent: u64,
    asks_seen: u64,
    streaming: bool,
    snapshot_pending: bool,
    next_id: u64,
    pending: HashMap<String, Purpose>,
    inflight: HashSet<Purpose>,
    dirty: HashSet<Purpose>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            conn: Conn::Connecting { reason: None, retry_in: None },
            machines: Vec::new(),
            projects: Vec::new(),
            attention: Vec::new(),
            batches: Vec::new(),
            asks: HashMap::new(),
            asks_error: None,
            echo: None,
            detail: None,
            doctor: None,
            notice: None,
            policy: None,
            live: LiveState::default(),
            board_errors: HashMap::new(),
            sent: Vec::new(),
            order: None,
            guess: None,
            uploads: HashMap::new(),
            files: None,
            last_project: None,
            steered: VecDeque::new(),
            prompts: crate::prompts::Prompts::default(),
            time: TimeState::default(),
            add: crate::project_add::Feed::default(),
            status: crate::status::StatusState::default(),
            order_events: HashMap::new(),
            live_sub: None,
            live_frames: false,
            live_unsupported: false,
            notifier: Notifier::default(),
            asks_sent: 0,
            asks_seen: 0,
            streaming: false,
            snapshot_pending: false,
            next_id: 0,
            pending: HashMap::new(),
            inflight: HashSet::new(),
            dirty: HashSet::new(),
        }
    }
}

pub(crate) type Out = Vec<AppClientMessage>;

impl State {
    pub fn apply(&mut self, incoming: Incoming) -> Out {
        match incoming {
            Incoming::Ready => {
                self.reset_calls();
                self.conn = Conn::Live;
                self.notice = None;
                self.snapshot_pending = true;
                let mut out = vec![AppClientMessage::Snapshot {}];
                if let Some(q) = self.time.query.take() {
                    out.extend(self.time_open(q));
                }
                out.extend(self.status_reconnected());
                out
            }
            Incoming::Disconnected { reason, retry_in } => {
                self.reset_calls();
                self.add_disconnected();
                // Lanes keep their last values, greyed; elapsed keeps ticking from startedAt.
                self.live.mark_stale();
                self.status.disconnected();
                self.conn = Conn::Connecting { reason: Some(reason), retry_in: Some(retry_in) };
                Vec::new()
            }
            Incoming::Unauthorized(message) => {
                self.reset_calls();
                self.add_disconnected();
                self.live.clear();
                self.conn = Conn::Refused(message);
                Vec::new()
            }
            Incoming::Message(message) => self.on_message(message),
        }
    }

    pub fn project(&self, key: &ProjectKey) -> Option<&ProjectRow> {
        self.projects.iter().find(|p| &p.key() == key)
    }

    pub fn machine(&self, machine_id: &str) -> Option<&Machine> {
        self.machines.iter().find(|m| m.machine_id == machine_id)
    }

    /// Open asks of open batches: newest batch first, then by number.
    pub fn inbox(&self) -> Vec<InboxItem<'_>> {
        let mut out = Vec::new();
        for batch in self.batches.iter().filter(|b| b.state == BatchState::Open) {
            let mut items: Vec<_> = batch.items.iter().collect();
            items.sort_by_key(|i| i.number);
            for item in items {
                if let Some(ask) = self.asks.get(item.ask_id.as_str()).filter(|a| a.state == AskState::Open) {
                    out.push(InboxItem { batch_id: &batch.batch_id, number: item.number.get(), ask });
                }
            }
        }
        out
    }

    pub fn open_project(&mut self, key: ProjectKey) -> Out {
        self.detail = Some(Detail { key: key.clone(), tail: Vec::new(), tail_error: None, version: 0 });
        let mut out: Out = self.request_project(&key).into_iter().collect();
        out.extend(self.request_tail());
        out
    }

    /// Sends a terse reply such as "1 go 2 nvm"; `batch_id` pins it to one batch.
    pub fn reply(&mut self, raw: &str, batch_id: Option<&BatchId>) -> Out {
        if !self.live_or_echo("Not connected to the hub; the reply was not sent.") {
            return Vec::new();
        }
        let raw = match Text::new(raw) {
            Ok(raw) => raw,
            Err(e) => return self.refuse(format!("The reply was not sent: {e}.")),
        };
        vec![self.call(Purpose::Reply, &InboxReplyInput { raw, batch_id: batch_id.cloned() })]
    }

    /// Sends a new order through the hub's intake: to `to`, or (None) wherever the hub's router puts it. It shows
    /// as a "sending" card at once; `request_id` makes a retried send land once.
    pub fn submit_order(&mut self, order: SentOrder) -> Out {
        if !self.live_or_echo("Not connected to the hub; the order was not sent.") {
            return Vec::new();
        }
        if let Some(to) = &order.to {
            self.last_project = Some(to.clone());
        }
        let out = self.send_order(&order);
        self.sent.retain(|o| o.request_id != order.request_id);
        self.sent.push(SentOrder { status: Sent::Sending, ..order });
        out
    }

    /// Sends a failed order again with the same clientRequestId, so the hub answers it once.
    pub fn retry_order(&mut self, request_id: &str) -> Out {
        let Some(order) = self.sent.iter().find(|o| o.request_id == request_id).cloned() else { return Vec::new() };
        if !self.live_or_echo("Not connected to the hub; the order was not sent.") {
            return Vec::new();
        }
        let out = self.send_order(&order);
        if let Some(o) = self.sent.iter_mut().find(|o| o.request_id == request_id) {
            o.status = Sent::Sending;
        }
        out
    }

    /// Takes a sent order off the board (Edit puts its text back in the composer).
    pub fn take_sent(&mut self, request_id: &str) -> Option<SentOrder> {
        let ix = self.sent.iter().position(|o| o.request_id == request_id)?;
        Some(self.sent.remove(ix))
    }

    fn send_order(&mut self, order: &SentOrder) -> Out {
        let (text, request_id) = match (Text::new(order.text.as_str()), fleetd_contracts::mcp::RequestId::new(order.request_id.as_str())) {
            (Ok(text), Ok(id)) => (text, id),
            (Err(e), _) | (_, Err(e)) => return self.refuse(format!("The order was not sent: {e}.")),
        };
        let input = IntakeSubmitInput {
            machine_id: order.to.as_ref().map(|k| MachineId::unchecked(&k.0)),
            project_id: order.to.as_ref().map(|k| ProjectId::unchecked(&k.1)),
            text,
            template: order.template,
            client_request_id: request_id,
            attachments: attachments(&order.attachments),
            refs: (!order.refs.is_empty()).then(|| List::unchecked(order.refs.clone())),
        };
        vec![self.call(Purpose::Order { request_id: order.request_id.clone() }, &input)]
    }

    /// Opens an order: its detail, and its project's lead conversation.
    pub fn open_order(&mut self, workstream_id: &str) -> Out {
        let key = self.project_of(workstream_id);
        let notes = self.order.take().filter(|o| o.workstream_id == workstream_id).map(|o| o.notes).unwrap_or_default();
        self.order = Some(OrderView {
            workstream_id: workstream_id.to_string(),
            key: key.clone(),
            card: self.card(workstream_id).cloned(),
            claims: Vec::new(),
            loaded: false,
            error: None,
            notes,
            stopping: false,
        });
        let mut out: Out = self.request_order().into_iter().collect();
        // The lead log belongs to the order's project: a fresh one, never the previous order's.
        match key {
            Some(key) => out.extend(self.open_project(key)),
            None => self.detail = None,
        }
        out
    }

    pub fn close_order(&mut self) {
        self.order = None;
        self.detail = None;
    }

    /// The project an order belongs to, from the board or the project outcomes.
    pub fn project_of(&self, workstream_id: &str) -> Option<ProjectKey> {
        if let Some(card) = self.card(workstream_id) {
            return Some((card.project_ref.machine_id.to_string(), card.project_ref.project_id.to_string()));
        }
        self.projects.iter().find(|r| r.workstreams().iter().any(|w| w.workstream_id == workstream_id)).map(ProjectRow::key)
    }

    /// An order's card as the board has it.
    pub fn card(&self, workstream_id: &str) -> Option<&OrderCard> {
        self.projects.iter().find_map(|r| self.live.orders(&r.key()).iter().find(|c| c.workstream_id == workstream_id))
    }

    /// Its workstream record (brief, source text), when the project outcome has it.
    pub fn workstream(&self, workstream_id: &str) -> Option<&Workstream> {
        self.projects.iter().flat_map(|r| r.workstreams()).find(|w| w.workstream_id == workstream_id)
    }

    /// Hub events about one order, oldest first.
    pub fn order_events(&self, workstream_id: &str) -> impl Iterator<Item = &HubEvent> {
        self.order_events.get(workstream_id).into_iter().flatten()
    }

    /// Records a hub event about an order (the bench fixture's way in; the hub's come through `apply`).
    pub fn push_order_event(&mut self, event: HubEvent) {
        self.on_order_event(&event);
    }

    /// Open asks about one order.
    pub fn order_asks(&self, workstream_id: &str) -> Vec<InboxItem<'_>> {
        self.inbox().into_iter().filter(|i| i.ask.workstream_id.as_ref().is_some_and(|w| w == workstream_id)).collect()
    }

    /// A follow-up to the open order: Enter adds it for the lead's next wake, `urgent` (⌘Enter) steers it in now.
    pub fn note(&mut self, text: &str, urgent: bool, attachments_in: Vec<String>, refs: Vec<IntakeRef>, request_id: &str) -> Out {
        let Some(workstream_id) = self.order.as_ref().map(|o| o.workstream_id.clone()) else { return Vec::new() };
        if !self.live_or_echo("Not connected to the hub; the note was not sent.") {
            return Vec::new();
        }
        let (body, id) = match (Text::new(text), fleetd_contracts::mcp::RequestId::new(request_id)) {
            (Ok(body), Ok(id)) => (body, id),
            (Err(e), _) | (_, Err(e)) => return self.refuse(format!("The note was not sent: {e}.")),
        };
        let input = OrderNoteInput {
            workstream_id: WorkstreamId::unchecked(&workstream_id),
            text: body,
            attachments: attachments(&attachments_in),
            refs: (!refs.is_empty()).then(|| List::unchecked(refs)),
            urgent,
            client_request_id: id,
        };
        let call = self.call(Purpose::OrderNote { request_id: request_id.to_string() }, &input);
        if let Some(order) = self.order.as_mut() {
            order.notes.push(Note { request_id: request_id.to_string(), text: text.to_string(), urgent, status: NoteStatus::Sending });
        }
        vec![call]
    }

    /// Stops the open order (after the confirm popover): its agents are cancelled, merged PRs stay.
    pub fn stop_order(&mut self) -> Out {
        let Some(workstream_id) = self.order.as_ref().filter(|o| !o.stopping).map(|o| o.workstream_id.clone()) else { return Vec::new() };
        if self.conn != Conn::Live {
            return self.refuse("Not connected to the hub; the order was not stopped.".into());
        }
        if let Some(o) = self.order.as_mut() {
            o.stopping = true;
        }
        let input = OrderStopInput { workstream_id: WorkstreamId::unchecked(&workstream_id), reason: None };
        vec![self.call(Purpose::OrderStop(workstream_id), &input)]
    }

    /// Asks the router where `text` would go, one guess in flight at a time; never blocks a send.
    pub fn preview(&mut self, text: &str) -> Out {
        if self.conn != Conn::Live || self.pending.values().any(|p| *p == Purpose::Preview) {
            return Vec::new();
        }
        let Ok(body) = Text::new(text) else { return Vec::new() };
        self.guess = Some((text.to_string(), None));
        vec![self.call(Purpose::Preview, &IntakePreviewInput { text: body })]
    }

    pub fn guessing(&self) -> bool {
        self.pending.values().any(|p| *p == Purpose::Preview)
    }

    /// Uploads one attachment now, so Send is instant; the composer shows `uploads[local]`.
    pub fn attach(&mut self, local: u64, name: &str, mime: &str, data_b64: String) -> Out {
        if self.conn != Conn::Live {
            self.uploads.insert(local, Upload::Failed("Not connected to the hub.".into()));
            return Vec::new();
        }
        let mime: Result<AttachmentMime, _> = serde_json::from_value(serde_json::Value::String(mime.to_string()));
        let (Ok(mime), Ok(name), Ok(data_b64)) = (mime, fleetd_contracts::prim::Line::new(name), Text::new(data_b64)) else {
            self.uploads.insert(local, Upload::Failed("This file can't be attached.".into()));
            return Vec::new();
        };
        self.uploads.insert(local, Upload::Uploading);
        let input = AttachmentPutInput { name, mime, data_b64 };
        vec![self.call(Purpose::Attach(local), &input)]
    }

    /// File paths in a project for the @ menu.
    pub fn list_files(&mut self, key: &ProjectKey, query: &str) -> Out {
        if self.conn != Conn::Live || self.pending.values().any(|p| matches!(p, Purpose::Files { query: q } if q == query)) {
            return Vec::new();
        }
        let input = ProjectFilesInput {
            machine_id: MachineId::unchecked(&key.0),
            project_id: ProjectId::unchecked(&key.1),
            query: Text::unchecked(query),
            limit: IntOr(Int::unchecked(20)),
        };
        vec![self.call(Purpose::Files { query: query.to_string() }, &input)]
    }

    // ---- time inspector ---------------------------------------------------------------------

    /// Opens (or re-aims) the time inspector. The same query again sends nothing.
    pub fn time_open(&mut self, query: TimeQuery) -> Out {
        if self.time.query.as_ref() == Some(&query) {
            return Vec::new();
        }
        self.time.generation += 1;
        let g = self.time.generation;
        let t = &mut self.time;
        t.breakdown = None;
        t.insights = None;
        t.spans.clear();
        t.spans_done = !query.spans;
        t.spans_error = None;
        t.spans_coverage = None;
        t.linked = None;
        t.window = None;
        t.version += 1;
        let mut out = vec![
            self.call(Purpose::Time(TimeCall::Breakdown, g), &query.breakdown),
            self.call(Purpose::Time(TimeCall::Insights, g), &query.insights),
        ];
        if query.spans {
            out.push(self.call(Purpose::Time(TimeCall::Spans, g), &spans_input(&query, None)));
        }
        self.time.query = Some(query);
        out
    }

    /// The view closed: late answers are dropped and events no longer refetch.
    pub fn time_close(&mut self) {
        self.time.query = None;
        self.time.generation += 1;
    }

    pub fn time_linked(&mut self, linked: Linked) -> Out {
        let Some(q) = self.time.query.clone() else { return Vec::new() };
        let mut input = spans_input(&q, None);
        input.rule = linked.rule;
        input.kinds = (!linked.kinds.is_empty()).then(|| List::unchecked(linked.kinds.clone()));
        self.time.linked = Some((linked, None));
        self.time.version += 1;
        vec![self.call(Purpose::Time(TimeCall::Linked, self.time.generation), &input)]
    }

    pub fn time_close_linked(&mut self) {
        self.time.linked = None;
        self.time.version += 1;
    }

    /// The transcript around one item of a session (click on a span).
    pub fn time_window(&mut self, machine: &str, thread: &str, item: &str) -> Out {
        self.time.window = Some(((machine.into(), thread.into(), item.into()), None));
        self.time.version += 1;
        let input = ThreadWindowInput {
            machine_id: MachineId::unchecked(machine),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread),
            item_id: Text::unchecked(item),
            before: IntOr::default(),
            after: IntOr::default(),
        };
        vec![self.call(Purpose::Time(TimeCall::Window, self.time.generation), &input)]
    }

    pub fn time_close_window(&mut self) {
        self.time.window = None;
        self.time.version += 1;
    }

    /// Settings → Data: the hub's retention and stored size come with any breakdown; the last hour of the fleet
    /// is the cheapest one.
    pub fn time_store(&mut self, since: Timestamp) -> Out {
        let input = TimeBreakdownInput { scope: TimeScope::Fleet, since, until: None, compare: None, filters: Default::default() };
        self.refetch(Purpose::Time(TimeCall::Store, 0), &input).into_iter().collect()
    }

    pub fn set_retention(&mut self, days: i64) -> Out {
        if !self.live_or_echo("Not connected to the hub; retention was not changed.") {
            return Vec::new();
        }
        vec![self.call(Purpose::Time(TimeCall::Retention, 0), &TimeRetentionSetInput { retention_days: Int::unchecked(days) })]
    }

    /// A running order's open view refetches on the hub events that change its time: no polling.
    fn time_on_event(&mut self, event: &HubEvent) -> Out {
        let Some(TimeScope::Order { workstream_id }) = self.time.query.as_ref().map(|q| &q.scope) else { return Vec::new() };
        let kind = event.r#type.as_str();
        let concerns = ["task.", "change.", "ask.", "workstream."].iter().any(|p| kind.starts_with(p))
            || matches!(event.r#type, HubEventType::LeadWoken | HubEventType::PrMerged);
        let data = event.data.as_ref();
        let about = data.and_then(|d| d.get("workstreamId")).and_then(|v| v.as_str()) == Some(workstream_id.as_str())
            || data
                .and_then(|d| d.get("workstreamIds"))
                .and_then(|v| v.as_array())
                .is_some_and(|ws| ws.iter().any(|w| w.as_str() == Some(workstream_id.as_str())));
        if !concerns || !about {
            return Vec::new();
        }
        let g = self.time.generation;
        let Some(q) = self.time.query.clone() else { return Vec::new() };
        let mut out: Out = self.refetch(Purpose::Time(TimeCall::Breakdown, g), &q.breakdown).into_iter().collect();
        out.extend(self.refetch(Purpose::Time(TimeCall::Insights, g), &q.insights));
        if q.spans && self.time.spans_done {
            // From just before the oldest span still open, so the ones that closed come back with their end.
            let open = self.time.spans.iter().filter(|s| s.end_ms.is_none()).map(|s| s.id.get()).min();
            let after = open.map(|id| id - 1).or_else(|| self.time.spans.last().map(|s| s.id.get()));
            self.time.spans_done = false;
            out.push(self.call(Purpose::Time(TimeCall::Spans, g), &spans_input(&q, after)));
        }
        out
    }

    fn on_time_result(&mut self, call: TimeCall, g: u64, output: serde_json::Value) -> Out {
        let mut out = Vec::new();
        let current = g == self.time.generation;
        match call {
            TimeCall::Store => self.time.store = Some(parse::<TimeBreakdownOutput>(output).map(|b| (b.retention_days.get(), b.stored_bytes.get()))),
            TimeCall::Retention => match parse::<TimeRetentionSetOutput>(output) {
                Ok(r) => {
                    let bytes = self.time.store.as_ref().and_then(|s| s.as_ref().ok()).map_or(0, |s| s.1);
                    self.time.store = Some(Ok((r.retention_days.get(), bytes)));
                }
                Err(e) => self.echo = Some(Echo { text: e, ok: false }),
            },
            _ if !current => return out,
            TimeCall::Breakdown => self.time.breakdown = Some(parse(output)),
            TimeCall::Insights => self.time.insights = Some(parse(output)),
            TimeCall::Spans => match parse::<TimeSpansOutput>(output) {
                Ok(page) => {
                    let t = &mut self.time;
                    t.spans_coverage = Some(page.coverage.clone());
                    for span in page.spans.into_iter() {
                        match t.spans.binary_search_by_key(&span.id.get(), |s| s.id.get()) {
                            Ok(ix) => t.spans[ix] = span,
                            Err(ix) => t.spans.insert(ix, span),
                        }
                    }
                    match (page.next_after_id, self.time.query.clone()) {
                        (Some(next), Some(q)) => out.push(self.call(Purpose::Time(TimeCall::Spans, g), &spans_input(&q, Some(next.get())))),
                        _ => self.time.spans_done = true,
                    }
                }
                Err(e) => {
                    self.time.spans_error = Some(e);
                    self.time.spans_done = true;
                }
            },
            TimeCall::Linked => {
                if let Some((linked, slot)) = self.time.linked.as_mut() {
                    *slot = Some(parse::<TimeSpansOutput>(output).map(|p| p.spans.into_iter().filter(|s| linked.keeps(s)).collect()));
                }
            }
            TimeCall::Window => {
                if let Some((_, slot)) = self.time.window.as_mut() {
                    *slot = Some(parse(output));
                }
            }
        }
        self.time.version += 1;
        out
    }

    fn on_time_error(&mut self, call: TimeCall, g: u64, text: String) {
        let t = &mut self.time;
        match call {
            TimeCall::Store => t.store = Some(Err(text)),
            TimeCall::Retention => self.echo = Some(Echo { text, ok: false }),
            _ if g != t.generation => return,
            TimeCall::Breakdown => t.breakdown = Some(Err(text)),
            TimeCall::Insights => t.insights = Some(Err(text)),
            TimeCall::Spans => {
                t.spans_error = Some(text);
                t.spans_done = true;
            }
            TimeCall::Linked => {
                if let Some((_, slot)) = t.linked.as_mut() {
                    *slot = Some(Err(text));
                }
            }
            TimeCall::Window => {
                if let Some((_, slot)) = t.window.as_mut() {
                    *slot = Some(Err(text));
                }
            }
        }
        self.time.version += 1;
    }

    /// The Machines screen opened: list the doctor's checks.
    pub fn open_doctor(&mut self) -> Out {
        self.doctor.get_or_insert_with(Doctor::default);
        self.request_doctor().into_iter().collect()
    }

    /// Runs every check now (takes the hub a few seconds).
    pub fn rerun_doctor(&mut self) -> Out {
        if self.doctor_rerunning() || !self.live_or_echo("Not connected to the hub; the checks were not re-run.") {
            return Vec::new();
        }
        self.doctor.get_or_insert_with(Doctor::default);
        vec![self.call(Purpose::DoctorRerun, &DoctorListInput { machine_id: None, rerun: Some(true) })]
    }

    /// Runs a check's auto fix; the answer replaces that check.
    pub fn fix_doctor(&mut self, check_id: &DoctorCheckId) -> Out {
        if self.doctor_fixing(check_id) || !self.live_or_echo("Not connected to the hub; the fix was not run.") {
            return Vec::new();
        }
        vec![self.call(Purpose::DoctorFix(check_id.clone()), &DoctorFixInput { check_id: check_id.clone() })]
    }

    /// The machine a secret ask's sink is on and its box key, or why it can't take the secret now.
    pub fn secret_target(&self, ask: &Ask) -> Result<(String, String), String> {
        let Some(sink) = ask.sink.as_deref().and_then(parse_secret_sink) else { return Err("This ask has no valid sink.".into()) };
        let machine_id = sink.machine_id.as_str();
        let Some(machine) = self.machine(machine_id) else { return Err(format!("The hub doesn't know machine {machine_id}.")) };
        let Some(key) = &machine.box_pub_key else { return Err(format!("{machine_id} takes no secrets: its node has no box key yet.")) };
        if machine.status == MachineStatus::Offline {
            return Err(format!("{machine_id} is offline. Try again when it is online."));
        }
        Ok((machine_id.to_string(), key.to_string()))
    }

    /// Sends a value sealed to the sink machine (see `seal`); the echo shows the node's fingerprint.
    pub fn submit_secret(&mut self, ask_id: &str, machine_id: &str, sealed: String) -> Out {
        if self.secret_submitting(ask_id) || !self.live_or_echo("Not connected to the hub; the secret was not sent.") {
            return Vec::new();
        }
        let input = match (AskId::new(ask_id), SealedSecret::new(sealed)) {
            (Ok(ask_id), Ok(sealed)) => SecretSubmitInput { ask_id, sealed },
            (Err(e), _) | (_, Err(e)) => return self.refuse(format!("The secret was not sent: {e}.")),
        };
        let key = self.asks.get(ask_id).map_or("The secret", |a| a.key.as_str());
        let purpose = Purpose::Secret { ask_id: ask_id.to_string(), saved: format!("{key} saved on {machine_id}") };
        vec![self.call(purpose, &input)]
    }

    pub fn secret_submitting(&self, ask_id: &str) -> bool {
        self.pending.values().any(|p| matches!(p, Purpose::Secret { ask_id: id, .. } if id == ask_id))
    }

    /// A "needs you" notification to show now, if the hub's rules and policy allow one.
    pub fn take_notification(&mut self, now_ms: i64) -> Option<Notification> {
        let policy = self.policy.as_ref()?;
        let (asks, seen) = (&self.asks, self.asks_seen);
        self.notifier.due(now_ms, policy, |id, sent| seen <= sent || asks.get(id).is_some_and(|a| a.state == AskState::Open))
    }

    pub fn doctor_rerunning(&self) -> bool {
        self.pending.values().any(|p| *p == Purpose::DoctorRerun)
    }

    pub fn doctor_fixing(&self, check_id: &DoctorCheckId) -> bool {
        self.pending.values().any(|p| matches!(p, Purpose::DoctorFix(id) if id == check_id))
    }

    /// Shows why a user action was not sent.
    fn refuse(&mut self, text: String) -> Out {
        self.echo = Some(Echo { text, ok: false });
        Vec::new()
    }

    fn live_or_echo(&mut self, offline: &str) -> bool {
        if self.conn != Conn::Live {
            self.echo = Some(Echo { text: offline.into(), ok: false });
        }
        self.conn == Conn::Live
    }

    /// Periodic: keeps the open project's lead log fresh while the lead is at work, and the quiet windows
    /// current.
    pub fn poll(&mut self, now_ms: i64) -> Out {
        let busy = self.detail.as_ref().and_then(|d| self.project(&d.key)).is_some_and(|row| {
            row.lead().is_some_and(|l| l.state == LeadState::Working) || row.lead_thread().is_some_and(|t| t.status == ThreadStatus::Running)
        });
        let mut out: Out = if busy && self.conn == Conn::Live { self.request_tail().into_iter().collect() } else { Vec::new() };
        out.extend(self.status_check_deadline(now_ms));
        if self.policy.as_ref().is_some_and(|p| p.stale(now_ms)) {
            out.extend(self.request_policy());
        }
        out
    }

    /// Subscribes to live frames for the board and/or one focused order, when that changed. Send again after the
    /// window comes back (`force`): the hub answers with a full frame.
    pub fn subscribe_live(&mut self, board: bool, focus: Option<&str>, force: bool) -> Out {
        let want = (board, focus.map(str::to_string));
        if self.conn != Conn::Live || self.live_unsupported || (!force && self.live_sub.as_ref() == Some(&want)) {
            return Vec::new();
        }
        self.live_sub = Some(want);
        vec![AppClientMessage::Live { board, focus: focus.map(WorkstreamId::unchecked) }]
    }

    /// Live values can't be trusted: the connection is down, or the feed stopped.
    pub fn live_stale(&self) -> bool {
        self.conn != Conn::Live || self.live.stale()
    }

    fn reset_calls(&mut self) {
        self.prompts.reset_calls();
        self.live_sub = None;
        self.streaming = false;
        self.snapshot_pending = false;
        self.pending.clear();
        self.inflight.clear();
        self.dirty.clear();
    }

    pub(crate) fn call<I: Tool>(&mut self, purpose: Purpose, input: &I) -> AppClientMessage {
        self.next_id += 1;
        let id = format!("c{}", self.next_id);
        self.pending.insert(id.clone(), purpose.clone());
        if !purpose.one_shot() {
            self.inflight.insert(purpose);
        }
        AppClientMessage::Call { id: AppCallId::unchecked(id), tool: Text::unchecked(I::NAME), input: serde_json::to_value(input).unwrap() }
    }

    /// A refetch: sent now, or once more after the in-flight one lands.
    fn refetch<I: Tool>(&mut self, purpose: Purpose, input: &I) -> Option<AppClientMessage> {
        if self.conn != Conn::Live {
            return None;
        }
        if self.inflight.contains(&purpose) {
            self.dirty.insert(purpose);
            return None;
        }
        Some(self.call(purpose, input))
    }

    fn request_asks(&mut self) -> Option<AppClientMessage> {
        let call = self.refetch(Purpose::Asks, &AsksListInput { state: AskState::Open, batch_id: None });
        if call.is_some() {
            self.asks_sent += 1;
        }
        call
    }

    fn request_policy(&mut self) -> Option<AppClientMessage> {
        self.refetch(Purpose::Policy, &AttentionPolicyInput {})
    }

    fn request_project(&mut self, key: &ProjectKey) -> Option<AppClientMessage> {
        // The key came from a decoded ProjectSummary.
        let input = ProjectGetInput { machine_id: MachineId::unchecked(&key.0), project_id: ProjectId::unchecked(&key.1) };
        self.refetch(Purpose::Project(key.clone()), &input)
    }

    fn request_tail(&mut self) -> Option<AppClientMessage> {
        let key = self.detail.as_ref()?.key.clone();
        let thread_id = self.project(&key)?.lead()?.thread_id.clone();
        let input = ThreadTailInput { machine_id: MachineId::unchecked(&key.0), thread_id, n: IntOr(Int::unchecked(TAIL_N)), kinds: None };
        self.refetch(Purpose::Tail(key), &input)
    }

    fn request_board(&mut self, key: &ProjectKey) -> Option<AppClientMessage> {
        let project_ref = fleetd_contracts::ids::ProjectRef { machine_id: MachineId::unchecked(&key.0), project_id: ProjectId::unchecked(&key.1) };
        let input = OrdersBoardInput { project_ref: Some(project_ref), include_done_since: None };
        self.refetch(Purpose::Board(key.clone()), &input)
    }

    fn request_order(&mut self) -> Option<AppClientMessage> {
        let id = self.order.as_ref()?.workstream_id.clone();
        let input = OrderGetInput { workstream_id: WorkstreamId::unchecked(&id) };
        self.refetch(Purpose::OrderGet(id), &input)
    }

    fn request_doctor(&mut self) -> Option<AppClientMessage> {
        self.refetch(Purpose::Doctor, &DoctorListInput { machine_id: None, rerun: None })
    }

    pub(crate) fn request_snapshot(&mut self) -> Option<AppClientMessage> {
        if self.conn != Conn::Live || self.snapshot_pending {
            return None;
        }
        self.snapshot_pending = true;
        Some(AppClientMessage::Snapshot {})
    }

    fn redo(&mut self, purpose: Purpose) -> Option<AppClientMessage> {
        match purpose {
            Purpose::Asks => self.request_asks(),
            Purpose::Project(key) => self.request_project(&key),
            Purpose::Tail(_) => self.request_tail(),
            Purpose::Doctor => self.request_doctor(),
            Purpose::Policy => self.request_policy(),
            Purpose::Board(key) => self.request_board(&key),
            Purpose::OrderGet(_) => self.request_order(),
            Purpose::Time(call @ (TimeCall::Breakdown | TimeCall::Insights), g) if g == self.time.generation => {
                let q = self.time.query.clone()?;
                let purpose = Purpose::Time(call, g);
                if call == TimeCall::Breakdown { self.refetch(purpose, &q.breakdown) } else { self.refetch(purpose, &q.insights) }
            }
            _ => None,
        }
    }

    fn on_message(&mut self, message: AppServerMessage) -> Out {
        match message {
            AppServerMessage::Ready { .. } => Vec::new(),
            AppServerMessage::Live(frame) => {
                self.live_frames = true;
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
                self.live.apply(frame, now);
                Vec::new()
            }
            AppServerMessage::Snapshot(status) => self.on_snapshot(status),
            AppServerMessage::Event(event) => self.on_event(&event),
            AppServerMessage::Result { id, output } => {
                let Some(purpose) = self.pending.remove(id.as_str()) else { return Vec::new() };
                self.inflight.remove(&purpose);
                let mut out = self.on_result(&purpose, output);
                if self.dirty.remove(&purpose) {
                    out.extend(self.redo(purpose));
                }
                out
            }
            AppServerMessage::Error(error) => {
                let text = match &error.fix {
                    Some(fix) => format!("{} {fix}", error.message),
                    None => error.message.clone(),
                };
                let Some(purpose) = error.id.as_ref().and_then(|id| self.pending.remove(id.as_str())) else {
                    // A hub that doesn't stream live frames answers the subscription with a session error: the
                    // board still works from its refetches, so say nothing and stop asking.
                    if error.id.is_none() && error.code == fleetd_contracts::mcp::ErrorCode::Invalid && self.live_sub.is_some() && !self.live_frames {
                        self.live_unsupported = true;
                        return Vec::new();
                    }
                    if error.id.is_none() {
                        self.notice = Some(text);
                    }
                    return Vec::new();
                };
                self.inflight.remove(&purpose);
                self.dirty.remove(&purpose);
                if matches!(purpose, Purpose::AddDiscover | Purpose::AddProject | Purpose::AddInspect | Purpose::AddRecover) {
                    return self.on_add_error(&purpose, error.message, error.fix);
                }
                self.on_call_error(&purpose, text);
                Vec::new()
            }
        }
    }

    fn on_snapshot(&mut self, status: FleetStatus) -> Out {
        self.snapshot_pending = false;
        let mut out = Vec::new();
        if !self.streaming {
            self.streaming = true;
            out.push(AppClientMessage::Events { cursor: status.cursor });
        }
        let mut old: HashMap<ProjectKey, ProjectRow> = self.projects.drain(..).map(|r| (r.key(), r)).collect();
        self.projects = status
            .projects
            .into_iter()
            .map(|summary| {
                let key = (summary.machine_id.to_string(), summary.project_id.to_string());
                let (outcome, error) = old.remove(&key).map_or((None, None), |r| (r.outcome, r.error));
                ProjectRow { summary, outcome, error }
            })
            .collect();
        self.machines = status.machines;
        self.attention = status.attention.into_iter().collect();
        let keys: Vec<ProjectKey> = self.projects.iter().map(ProjectRow::key).collect();
        out.extend(keys.iter().filter_map(|k| self.request_project(k)));
        out.extend(keys.iter().filter_map(|k| self.request_board(k)));
        out.extend(self.request_asks());
        out.extend(self.request_policy());
        if self.doctor.is_some() {
            out.extend(self.request_doctor());
        }
        out.extend(self.prompts_reconnected());
        self.add_saw(status.cursor);
        out.extend(self.add_reconnected());
        out
    }

    fn on_event(&mut self, event: &HubEvent) -> Out {
        let mut out = Vec::new();
        let kind = event.r#type.as_str();
        // A project added or removed elsewhere (another app, the CLI, an agent) shows up or leaves.
        if kind.starts_with("machine.") || matches!(event.r#type, HubEventType::ProjectAdded | HubEventType::ProjectRemoved) {
            out.extend(self.request_snapshot());
        }
        self.add_saw(event.seq);
        out.extend(self.on_add_event(event));
        if event.r#type == HubEventType::DigestReady {
            out.extend(self.status_digest_ready());
        }
        if event.r#type == HubEventType::DoctorChanged && self.doctor.is_some() {
            out.extend(self.request_doctor());
        }
        let asks_before = self.asks_sent;
        if kind.starts_with("ask.") || matches!(event.r#type, HubEventType::BatchReady | HubEventType::DecisionRecorded | HubEventType::GatedRan) {
            out.extend(self.request_asks());
        }
        // policy.quiet_hours or policy.tz may have changed.
        if event.r#type == HubEventType::DecisionRecorded && self.policy.is_some() {
            out.extend(self.request_policy());
        }
        // A fetch sent just now for this event can say whether its ask was answered; one already in flight can't.
        self.notifier.push(event, asks_before);
        out.extend(self.on_order_event(event));
        if matches!(event.r#type, HubEventType::PromptChanged | HubEventType::PromptDefaultChanged) {
            out.extend(self.on_prompt_event());
        }
        out.extend(self.time_on_event(event));
        let project_scoped = ["workstream.", "lead.", "thread."].iter().any(|p| kind.starts_with(p));
        if let (true, Some(machine_id), Some(project_id)) = (project_scoped, &event.machine_id, &event.project_id) {
            let key = (machine_id.to_string(), project_id.to_string());
            if self.project(&key).is_some() {
                out.extend(self.request_project(&key));
            } else {
                out.extend(self.request_snapshot());
            }
        }
        if kind.starts_with("thread.") {
            let lead_thread = self.detail.as_ref().and_then(|d| self.project(&d.key)).and_then(|r| r.lead()).map(|l| l.thread_id.as_str());
            if lead_thread.is_some() && lead_thread == event.thread_id.as_ref().map(|t| t.as_str()) {
                out.extend(self.request_tail());
            }
        }
        out
    }

    /// Order-shaped events refetch that project's board (and the open order); each is kept for the order view.
    fn on_order_event(&mut self, event: &HubEvent) -> Out {
        let kind = event.r#type.as_str();
        let mut out = Vec::new();
        let workstream_id = event.data.as_ref().and_then(|d| d.get("workstreamId")).and_then(|v| v.as_str()).map(str::to_string);
        if let Some(w) = &workstream_id {
            let ring = self.order_events.entry(w.clone()).or_default();
            ring.push_back(event.clone());
            if ring.len() > ORDER_EVENTS {
                ring.pop_front();
            }
        }
        let shapes_orders = ["workstream.", "task.", "change.", "claim.", "ask."].iter().any(|p| kind.starts_with(p))
            || matches!(event.r#type, HubEventType::PrMerged | HubEventType::ReviewVerdict);
        if shapes_orders {
            let key = match (&event.machine_id, &event.project_id) {
                (Some(m), Some(p)) => Some((m.to_string(), p.to_string())),
                _ => workstream_id.as_deref().and_then(|w| self.project_of(w)),
            };
            if let Some(key) = key.filter(|k| self.project(k).is_some()) {
                out.extend(self.request_board(&key));
            }
            if workstream_id.is_some() && self.order.as_ref().map(|o| &o.workstream_id) == workstream_id.as_ref() {
                out.extend(self.request_order());
            }
        }
        // The lead woke: notes it was waiting for are in its thread now, so the conversation shows them as yours.
        if event.r#type == HubEventType::LeadWoken
            && let (Some(m), Some(p), Some(order)) = (&event.machine_id, &event.project_id, self.order.as_mut())
            && order.key.as_ref().is_some_and(|k| k.0 == m.as_str() && k.1 == p.as_str())
        {
            order.notes.retain(|n| n.status != NoteStatus::Queued);
        }
        out
    }

    fn on_result(&mut self, purpose: &Purpose, output: serde_json::Value) -> Out {
        match purpose {
            Purpose::Prompt(call) => return self.on_prompt_result(call, output),
            Purpose::Time(call, g) => return self.on_time_result(*call, *g, output),
            Purpose::AddDiscover | Purpose::AddProject | Purpose::AddInspect | Purpose::AddRecover => return self.on_add_result(purpose, output),
            Purpose::Status(call, generation) => return self.on_status_result(*call, *generation, output),
            Purpose::Asks => match parse::<AsksListOutput>(output) {
                Ok(list) => {
                    self.asks_seen = self.asks_sent;
                    self.batches = list.batches.into_iter().collect();
                    self.asks = list.asks.into_iter().map(|a| (a.ask_id.to_string(), a)).collect();
                    self.asks_error = None;
                }
                Err(e) => self.asks_error = Some(e),
            },
            Purpose::Project(key) => {
                let parsed = parse::<ProjectGetOutput>(output);
                let Some(row) = self.projects.iter_mut().find(|r| &r.key() == key) else { return Vec::new() };
                match parsed {
                    Ok(outcome) => {
                        row.outcome = Some(outcome);
                        row.error = None;
                    }
                    Err(e) => row.error = Some(e),
                }
                // The lead thread may be new (lead_restart): refresh its log.
                if self.detail.as_ref().is_some_and(|d| &d.key == key) {
                    return self.request_tail().into_iter().collect();
                }
            }
            Purpose::Tail(key) => {
                let parsed = parse::<ThreadTailOutput>(output);
                if let Some(detail) = self.detail.as_mut().filter(|d| &d.key == key) {
                    match parsed {
                        Ok(tail) => {
                            let mut items: Vec<TailItem> = tail.items.into_iter().collect();
                            items.reverse();
                            if items != detail.tail {
                                detail.tail = items;
                                detail.version += 1;
                            }
                            detail.tail_error = None;
                        }
                        Err(e) => detail.tail_error = Some(e),
                    }
                }
            }
            Purpose::Reply => {
                match parse::<InboxReplyOutput>(output) {
                    Ok(r) if r.parsed => self.echo = Some(Echo { text: r.echo.unwrap_or_else(|| "Done.".into()), ok: true }),
                    Ok(r) => self.echo = Some(Echo { text: r.hint.unwrap_or_else(|| "The hub couldn't read that reply.".into()), ok: false }),
                    Err(e) => self.echo = Some(Echo { text: e, ok: false }),
                }
                return self.request_asks().into_iter().collect();
            }
            Purpose::Doctor | Purpose::DoctorRerun => {
                let doctor = self.doctor.get_or_insert_with(Doctor::default);
                match parse::<DoctorListOutput>(output) {
                    Ok(list) => {
                        doctor.checks = list.checks.into_iter().collect();
                        doctor.checked_at = Some(list.checked_at);
                        doctor.error = None;
                    }
                    Err(e) => doctor.error = Some(e),
                }
            }
            Purpose::Secret { saved, .. } => {
                match parse::<SecretSubmitOutput>(output) {
                    Ok(out) => self.echo = Some(Echo { text: format!("{saved}, fingerprint {}", out.fingerprint), ok: true }),
                    Err(e) => self.echo = Some(Echo { text: e, ok: false }),
                }
                return self.request_asks().into_iter().collect();
            }
            Purpose::Order { request_id } => {
                let to = self.sent.iter().find(|o| &o.request_id == request_id).and_then(|o| o.to.clone());
                let status = match parse::<IntakeSubmitOutput>(output) {
                    Ok(IntakeSubmitOutput { workstream_id: Some(ws), echo, lead_waiting, .. }) => {
                        let project = echo.map(|e| (e.project_ref.machine_id.to_string(), e.project_ref.project_id.to_string())).or(to);
                        Sent::Placed { workstream_id: ws.to_string(), project, lead_waiting }
                    }
                    Ok(IntakeSubmitOutput { ask_id: Some(ask), .. }) => Sent::Unrouted { ask_id: ask.to_string() },
                    Ok(_) => Sent::Failed("The hub sent an empty answer.".into()),
                    Err(e) => Sent::Failed(e),
                };
                let placed_in = match &status {
                    Sent::Placed { project: Some(p), .. } => Some(p.clone()),
                    _ => None,
                };
                if let Some(o) = self.sent.iter_mut().find(|o| &o.request_id == request_id) {
                    o.status = status;
                }
                let mut out: Out = self.request_asks().into_iter().collect();
                out.extend(placed_in.and_then(|k| self.request_board(&k)));
                return out;
            }
            Purpose::Board(key) => match parse::<OrdersBoardOutput>(output) {
                Ok(board) => {
                    self.board_errors.remove(key);
                    // A sent order leaves once its project's board lists it.
                    self.sent.retain(|o| !matches!(&o.status, Sent::Placed { workstream_id, .. } if board.orders.iter().any(|c| c.workstream_id == workstream_id.as_str())));
                    if let Some(order) = self.order.as_mut()
                        && let Some(card) = board.orders.iter().find(|c| c.workstream_id == order.workstream_id.as_str())
                    {
                        order.card = Some(card.clone());
                    }
                    self.live.set_board(key, board);
                }
                Err(e) => {
                    self.board_errors.insert(key.clone(), e);
                }
            },
            Purpose::OrderGet(id) => {
                let parsed = parse::<OrderGetOutput>(output);
                if let Some(order) = self.order.as_mut().filter(|o| &o.workstream_id == id) {
                    order.loaded = true;
                    match parsed {
                        Ok(detail) => {
                            order.error = None;
                            order.card = Some(detail.order.clone());
                            order.claims = detail.claims.clone().map(|c| c.to_vec()).unwrap_or_default();
                            let learned = order.key.is_none().then(|| {
                                let p = &detail.order.project_ref;
                                (p.machine_id.to_string(), p.project_id.to_string())
                            });
                            order.key = order.key.clone().or(learned.clone());
                            self.live.set_order(detail);
                            // Only now is the project known: fetch its lead log.
                            if let Some(key) = learned {
                                return self.open_project(key);
                            }
                        }
                        Err(e) => order.error = Some(e),
                    }
                }
            }
            Purpose::OrderNote { request_id } => {
                let status = match parse::<OrderNoteOutput>(output) {
                    Ok(_) => NoteStatus::Queued,
                    Err(e) => NoteStatus::Failed(e),
                };
                let steered =
                    self.order.as_ref().and_then(|o| o.notes.iter().find(|n| &n.request_id == request_id && n.urgent)).map(|n| n.text.clone());
                if let (NoteStatus::Queued, Some(text)) = (&status, steered) {
                    self.steered.push_back(text);
                    if self.steered.len() > 20 {
                        self.steered.pop_front();
                    }
                }
                self.set_note(request_id, status);
            }
            Purpose::OrderStop(id) => {
                if let Some(order) = self.order.as_mut().filter(|o| &o.workstream_id == id) {
                    order.stopping = false;
                }
                match parse::<OrderStopOutput>(output) {
                    Ok(_) => self.echo = Some(Echo { text: format!("Stopped {id}. Its running agents were cancelled; merged PRs stay."), ok: true }),
                    Err(e) => self.echo = Some(Echo { text: e, ok: false }),
                }
                let key = self.project_of(id);
                let mut out: Out = self.request_order().into_iter().collect();
                out.extend(key.and_then(|k| self.request_board(&k)));
                return out;
            }
            Purpose::Preview => {
                let project = parse::<IntakePreviewOutput>(output)
                    .ok()
                    .and_then(|p| p.echo)
                    .map(|e| (e.project_ref.machine_id.to_string(), e.project_ref.project_id.to_string()));
                if let Some(guess) = self.guess.as_mut() {
                    guess.1 = project;
                }
            }
            Purpose::Attach(local) => {
                let upload = match parse::<AttachmentPutOutput>(output) {
                    Ok(put) => Upload::Done { attachment_id: put.attachment_id.to_string() },
                    Err(e) => Upload::Failed(e),
                };
                self.uploads.insert(*local, upload);
            }
            Purpose::Files { query } => {
                if let Ok(files) = parse::<ProjectFilesOutput>(output) {
                    self.files = Some((query.clone(), files.paths.iter().map(|p| p.to_string()).collect()));
                }
            }
            Purpose::Policy => {
                self.policy = Some(parse::<AttentionPolicyOutput>(output).map_or_else(|_| Policy::fallback(), |p| Policy::from_output(&p)));
            }
            Purpose::DoctorFix(_) => match parse::<DoctorFixOutput>(output) {
                Ok(fixed) => {
                    let doctor = self.doctor.get_or_insert_with(Doctor::default);
                    match doctor.checks.iter_mut().find(|c| c.id == fixed.check.id) {
                        Some(check) => *check = fixed.check,
                        None => doctor.checks.push(fixed.check),
                    }
                    self.echo = Some(Echo { text: fixed.ran, ok: true });
                }
                Err(e) => self.echo = Some(Echo { text: e, ok: false }),
            },
        }
        Vec::new()
    }

    fn on_call_error(&mut self, purpose: &Purpose, text: String) {
        match purpose {
            Purpose::Prompt(call) => self.on_prompt_error(call, text),
            Purpose::Time(call, g) => self.on_time_error(*call, *g, text),
            Purpose::AddDiscover | Purpose::AddProject | Purpose::AddInspect | Purpose::AddRecover => {}
            Purpose::Status(call, generation) => self.on_status_error(*call, *generation, text),
            Purpose::Asks => self.asks_error = Some(text),
            Purpose::Project(key) => {
                if let Some(row) = self.projects.iter_mut().find(|r| &r.key() == key) {
                    row.error = Some(text);
                }
            }
            Purpose::Tail(key) => {
                if let Some(detail) = self.detail.as_mut().filter(|d| &d.key == key) {
                    detail.tail_error = Some(text);
                }
            }
            Purpose::Doctor | Purpose::DoctorRerun => self.doctor.get_or_insert_with(Doctor::default).error = Some(text),
            Purpose::Reply | Purpose::DoctorFix(_) | Purpose::Secret { .. } => self.echo = Some(Echo { text, ok: false }),
            Purpose::Order { request_id } => {
                if let Some(o) = self.sent.iter_mut().find(|o| &o.request_id == request_id) {
                    o.status = Sent::Failed(text);
                }
            }
            Purpose::Board(key) => {
                self.board_errors.insert(key.clone(), text);
            }
            Purpose::OrderGet(id) => {
                if let Some(order) = self.order.as_mut().filter(|o| &o.workstream_id == id) {
                    order.loaded = true;
                    order.error = Some(text);
                }
            }
            Purpose::OrderNote { request_id } => self.set_note(request_id, NoteStatus::Failed(text)),
            Purpose::OrderStop(id) => {
                if let Some(order) = self.order.as_mut().filter(|o| &o.workstream_id == id) {
                    order.stopping = false;
                }
                self.echo = Some(Echo { text, ok: false });
            }
            // A hub without intake_preview or project_files: no guess, no file list; nothing else changes.
            Purpose::Preview | Purpose::Files { .. } => {}
            Purpose::Attach(local) => {
                self.uploads.insert(*local, Upload::Failed(text));
            }
            // An older hub without attention_policy: notify with the default window and no quiet hours.
            Purpose::Policy => self.policy = Some(Policy::fallback()),
        }
    }
}

/// Uploaded attachment ids as the wire takes them; None when there are none.
fn attachments(ids: &[String]) -> Option<fleetd_contracts::mcp::Attachments> {
    (!ids.is_empty()).then(|| List::unchecked(ids.iter().map(|id| AttachmentId::unchecked(id.as_str())).collect()))
}

impl State {
    fn set_note(&mut self, request_id: &str, status: NoteStatus) {
        if let Some(note) = self.order.as_mut().and_then(|o| o.notes.iter_mut().find(|n| n.request_id == request_id)) {
            note.status = status;
        }
    }
}

fn spans_input(q: &TimeQuery, after_id: Option<i64>) -> TimeSpansInput {
    TimeSpansInput {
        scope: q.scope.clone(),
        since: q.breakdown.since.clone(),
        until: q.breakdown.until.clone(),
        kinds: None,
        rule: None,
        after_id: after_id.map(Int::unchecked),
        limit: IntOr(Int::unchecked(500)),
    }
}

pub(crate) fn parse<T: DeserializeOwned>(output: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(output).map_err(|e| format!("Unexpected answer from the hub: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::app::AppError;
    use fleetd_contracts::doctor::DoctorStatus;
    use fleetd_contracts::events::Attention;
    use fleetd_contracts::ids::EventSeq;
    use fleetd_contracts::mcp::ErrorCode;
    use serde_json::{Value, json};

    const AT: &str = "2026-10-17T10:00:00.000Z";
    /// Standard base64 of 32 bytes, as a node's box key is.
    const BOX_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    fn sealed() -> String {
        format!("{}==", "A".repeat(86))
    }

    fn project_json(m: &str, p: &str) -> Value {
        json!({ "machineId": m, "projectId": p, "title": p, "workspaceRoot": format!("/w/{p}"),
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT })
    }

    fn snapshot(projects: &[(&str, &str)], cursor: u64) -> Incoming {
        let projects: Vec<Value> = projects.iter().map(|(m, p)| project_json(m, p)).collect();
        let frame = json!({ "t": "snapshot", "machines": [{ "machineId": "lab-a", "name": "lab-a", "tags": [], "status": "online",
            "lastSeenAt": AT, "nodeVersion": "0.0.0" }], "projects": projects, "attention": [], "cursor": cursor });
        Incoming::Message(serde_json::from_value(frame).unwrap())
    }

    fn result(id: &str, output: Value) -> Incoming {
        Incoming::Message(AppServerMessage::Result { id: AppCallId::new(id).unwrap(), output })
    }

    fn error(id: &str, code: ErrorCode, message: &str, fix: Option<&str>) -> Incoming {
        let id = Some(AppCallId::new(id).unwrap());
        Incoming::Message(AppServerMessage::Error(AppError { id, code, message: message.into(), fix: fix.map(Into::into) }))
    }

    fn hub_event(event: Value) -> Incoming {
        Incoming::Message(AppServerMessage::Event(serde_json::from_value(event).unwrap()))
    }

    fn event(kind: &str, project: Option<&str>, thread: Option<&str>) -> Incoming {
        let mut e = json!({ "seq": 9, "at": AT, "type": kind, "summary": kind });
        if project.or(thread).is_some() {
            e["machineId"] = json!("lab-a");
        }
        if let Some(p) = project {
            e["projectId"] = json!(p);
        }
        if let Some(t) = thread {
            e["threadId"] = json!(t);
        }
        hub_event(e)
    }

    /// (id, tool) of each call in `out`.
    fn calls(out: &[AppClientMessage]) -> Vec<(String, String)> {
        out.iter()
            .filter_map(|m| match m {
                AppClientMessage::Call { id, tool, .. } => Some((id.to_string(), tool.to_string())),
                _ => None,
            })
            .collect()
    }

    fn check_id(id: &str) -> DoctorCheckId {
        DoctorCheckId::new(id).unwrap()
    }

    fn outcome(p: &str, lead_thread: Option<&str>, lead_state: &str) -> Value {
        let mut o = json!({ "project": project_json("lab-a", p), "threads": [], "stale": false, "asOf": AT });
        if let Some(t) = lead_thread {
            o["lead"] = json!({ "projectRef": { "machineId": "lab-a", "projectId": p }, "threadId": t, "state": lead_state,
                                "startedAt": AT, "sessionGeneration": 0 });
        }
        o
    }

    fn ask(id: &str, number: u32, state: &str) -> Value {
        json!({ "askId": id, "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "kind": "decide", "key": "api.path",
                "class": "product", "text": "Path?", "recommendation": "/healthz", "blocks": "nothing", "proceededOnRec": true,
                "state": state, "batchId": "B1", "number": number, "createdAt": AT })
    }

    /// Connected, snapshotted with projects p1 and p2, and every initial call answered.
    fn synced() -> State {
        let mut s = State::default();
        s.apply(Incoming::Ready);
        let out = s.apply(snapshot(&[("lab-a", "p1"), ("lab-a", "p2")], 0));
        for (id, tool) in calls(&out) {
            let output = match tool.as_str() {
                "asks_list" => json!({ "batches": [], "asks": [] }),
                "attention_policy" => json!({ "coalesceSec": 1200, "quiet": [] }),
                "orders_board" => json!({ "orders": [], "trains": [], "at": AT }),
                _ => outcome(if s.pending[&id] == Purpose::Project(("lab-a".into(), "p1".into())) { "p1" } else { "p2" }, Some("lead-1"), "idle"),
            };
            s.apply(result(&id, output));
        }
        s
    }

    #[test]
    fn connect_takes_a_snapshot_then_streams_and_fetches() {
        let mut s = State::default();
        assert_eq!(s.apply(Incoming::Ready), vec![AppClientMessage::Snapshot {}]);
        let out = s.apply(snapshot(&[("lab-a", "p1"), ("lab-a", "p2")], 41));
        assert_eq!(out[0], AppClientMessage::Events { cursor: EventSeq::new(41).unwrap() });
        let tools: Vec<String> = calls(&out).into_iter().map(|(_, t)| t).collect();
        assert_eq!(tools, ["project_get", "project_get", "orders_board", "orders_board", "asks_list", "attention_policy"]);
        assert_eq!(s.projects.len(), 2);
    }

    #[test]
    fn results_fill_the_row_their_id_belongs_to() {
        let s = synced();
        let p1 = s.project(&("lab-a".into(), "p1".into())).unwrap();
        assert_eq!(p1.lead().unwrap().thread_id, "lead-1");
        assert_eq!(p1.outcome.as_ref().unwrap().project.project_id, "p1");
        assert!(s.pending.is_empty() && s.inflight.is_empty());
    }

    #[test]
    fn events_while_a_fetch_is_in_flight_coalesce_into_one_more() {
        let mut s = synced();
        let first = calls(&s.apply(event("ask.created", None, None)));
        assert_eq!(first.len(), 1);
        assert!(s.apply(event("batch.ready", None, None)).is_empty());
        assert_eq!(calls(&s.apply(event("decision.recorded", None, None))).iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["attention_policy"]);
        let after = calls(&s.apply(result(&first[0].0, json!({ "batches": [], "asks": [] }))));
        assert_eq!(after.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["asks_list"]);
        assert!(calls(&s.apply(result(&after[0].0, json!({ "batches": [], "asks": [] })))).is_empty());
    }

    #[test]
    fn project_events_refetch_that_project_and_unknown_ones_resnapshot() {
        let mut s = synced();
        let out = s.apply(event("workstream.created", Some("p2"), None));
        let key: ProjectKey = ("lab-a".into(), "p2".into());
        let pending: HashSet<&Purpose> = s.pending.values().collect();
        assert_eq!(pending, HashSet::from([&Purpose::Project(key.clone()), &Purpose::Board(key)]), "its outcome and its order cards");
        assert_eq!(calls(&out).len(), 2);
        assert_eq!(s.apply(event("lead.started", Some("p9"), None)), vec![AppClientMessage::Snapshot {}]);
        // Only one snapshot in flight; a second one doesn't restart the event stream.
        assert!(s.apply(event("machine.offline", None, None)).is_empty());
        let out = s.apply(snapshot(&[("lab-a", "p1"), ("lab-a", "p2"), ("lab-a", "p9")], 50));
        assert!(!out.iter().any(|m| matches!(m, AppClientMessage::Events { .. })));
        assert_eq!(s.projects.len(), 3);
        assert!(s.project(&("lab-a".into(), "p1".into())).unwrap().outcome.is_some(), "known outcomes survive a resnapshot");
    }

    #[test]
    fn a_reconnect_drops_answers_meant_for_the_old_connection() {
        let mut s = synced();
        let old = calls(&s.apply(event("ask.created", None, None)));
        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: Duration::from_secs(1) });
        assert!(matches!(s.conn, Conn::Connecting { .. }));
        assert!(s.reply("1 go", None).is_empty(), "replies are not sent while offline");
        assert!(!s.echo.as_ref().unwrap().ok);
        s.apply(Incoming::Ready);
        assert!(s.apply(result(&old[0].0, json!({ "batches": [], "asks": [ask("A1", 1, "open")] }))).is_empty());
        assert!(s.asks.is_empty());
    }

    #[test]
    fn inbox_lists_open_asks_of_open_batches_by_number() {
        let mut s = synced();
        let id = calls(&s.apply(event("batch.ready", None, None)))[0].0.clone();
        let batches = json!([{ "batchId": "B1", "createdAt": AT, "state": "open",
            "items": [{ "number": 2, "askId": "A2" }, { "number": 1, "askId": "A1" }, { "number": 3, "askId": "A3" }] }]);
        s.apply(result(&id, json!({ "batches": batches, "asks": [ask("A1", 1, "open"), ask("A2", 2, "answered"), ask("A3", 3, "open")] })));
        let items: Vec<(i64, &str)> = s.inbox().iter().map(|i| (i.number, i.ask.ask_id.as_str())).collect();
        assert_eq!(items, [(1, "A1"), (3, "A3")]);
    }

    #[test]
    fn reply_sends_inbox_reply_and_shows_the_echo_or_hint() {
        let mut s = synced();
        let out = s.reply("1 go", Some(&BatchId::new("B1").unwrap()));
        let AppClientMessage::Call { id, tool, input } = &out[0] else { panic!() };
        assert_eq!((tool.as_str(), input), ("inbox_reply", &json!({ "raw": "1 go", "batchId": "B1" })));
        let refresh = calls(&s.apply(result(id, json!({ "parsed": true, "echo": "Logged: 1 → /healthz (D1)", "applied": [] }))));
        assert_eq!(s.echo, Some(Echo { text: "Logged: 1 → /healthz (D1)".into(), ok: true }));
        assert_eq!(refresh[0].1, "asks_list");

        let AppClientMessage::Call { id, .. } = &s.reply("purple", None)[0] else { panic!() };
        s.apply(result(id, json!({ "parsed": false, "applied": [], "hint": "Start with an item number." })));
        assert_eq!(s.echo, Some(Echo { text: "Start with an item number.".into(), ok: false }));
    }

    fn order(to: Option<&ProjectKey>, text: &str, id: &str) -> SentOrder {
        SentOrder {
            request_id: id.into(),
            to: to.cloned(),
            text: text.into(),
            template: Some(PlaybookName::Feature),
            attachments: Vec::new(),
            refs: Vec::new(),
            status: Sent::Sending,
        }
    }

    fn board_json(p: &str, w: &str) -> Value {
        let mut board: Value =
            serde_json::from_str(include_str!("../../../crates/fleetd-contracts/tests/fixtures/live/orders_board.output.json")).unwrap();
        board["orders"][0]["workstreamId"] = json!(w);
        board["orders"][0]["projectRef"] = json!({ "machineId": "lab-a", "projectId": p });
        board["orders"] = json!([board["orders"][0].clone()]);
        board
    }

    fn tools_of(out: &[AppClientMessage]) -> Vec<String> {
        calls(out).into_iter().map(|c| c.1).collect()
    }

    #[test]
    fn a_sent_order_is_a_card_at_once_and_leaves_when_the_board_lists_it() {
        let mut s = synced();
        let key: ProjectKey = ("lab-a".into(), "p1".into());
        let AppClientMessage::Call { id, tool, input } = &s.submit_order(order(Some(&key), "ship dark mode", "app-1"))[0] else { panic!() };
        assert_eq!(tool.as_str(), "intake_submit");
        assert_eq!(
            input,
            &json!({ "machineId": "lab-a", "projectId": "p1", "text": "ship dark mode", "template": "feature", "clientRequestId": "app-1" })
        );
        assert_eq!(s.sent[0].status, Sent::Sending);
        assert_eq!(s.last_project, Some(key.clone()));

        let echo = json!({ "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "template": "feature", "reason": "named in the order" });
        let out = s.apply(result(id, json!({ "workstreamId": "W7", "echo": echo })));
        assert_eq!(tools_of(&out), ["asks_list", "orders_board"], "the project's board is refetched for the new card");
        assert!(matches!(&s.sent[0].status, Sent::Placed { workstream_id, project: Some(p), .. } if workstream_id == "W7" && *p == key));
        let board = calls(&out).into_iter().find(|c| c.1 == "orders_board").unwrap().0;
        s.apply(result(&board, board_json("p1", "W7")));
        assert!(s.sent.is_empty(), "the real card replaced it");
        assert_eq!(s.live.orders(&key)[0].workstream_id, "W7");
    }

    #[test]
    fn unplaced_failed_and_retried_orders_keep_their_card() {
        let mut s = synced();
        let AppClientMessage::Call { id, input, .. } = &s.submit_order(order(None, "fix it", "app-2"))[0] else { panic!() };
        assert!(input.get("projectId").is_none());
        s.apply(result(id, json!({ "askId": "A9" })));
        assert_eq!(s.sent[0].status, Sent::Unrouted { ask_id: "A9".into() });

        let AppClientMessage::Call { id, .. } = &s.submit_order(order(None, "again", "app-3"))[0] else { panic!() };
        s.apply(error(id, ErrorCode::Forbidden, "This key can't send orders.", Some("Pair again with fleetd pair.")));
        assert_eq!(s.sent[1].status, Sent::Failed("This key can't send orders. Pair again with fleetd pair.".into()));
        let AppClientMessage::Call { input, .. } = &s.retry_order("app-3")[0] else { panic!() };
        assert_eq!(input["clientRequestId"], "app-3", "a retry reuses the id, so the hub answers it once");
        assert_eq!(s.sent[1].status, Sent::Sending);
        assert_eq!(s.take_sent("app-3").map(|o| o.text), Some("again".into()), "Edit takes the text back");

        // No lead could start: the card says why.
        let key: ProjectKey = ("lab-a".into(), "p1".into());
        let AppClientMessage::Call { id, .. } = &s.submit_order(order(Some(&key), "ship it", "app-4"))[0] else { panic!() };
        let why = "claude is not logged in on this machine On lab-a: claude auth login.";
        s.apply(result(id, json!({ "workstreamId": "W8", "leadWaiting": why })));
        assert!(matches!(&s.sent[1].status, Sent::Placed { lead_waiting: Some(w), .. } if w == why));

        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: Duration::from_secs(4) });
        assert!(s.submit_order(order(None, "offline", "app-5")).is_empty(), "not sent offline");
        assert!(!s.sent.iter().any(|o| o.request_id == "app-5"));
    }

    #[test]
    fn order_events_refetch_their_board_and_the_open_order() {
        let mut s = synced();
        let mut e = json!({ "seq": 9, "at": AT, "type": "task.started", "summary": "T31 started", "machineId": "lab-a", "projectId": "p2",
                            "data": { "workstreamId": "W3", "taskId": "T31" } });
        assert_eq!(tools_of(&s.apply(hub_event(e.clone()))), ["orders_board"]);
        assert!(s.apply(hub_event(e.clone())).is_empty(), "coalesced while in flight");
        assert_eq!(s.order_events("W3").count(), 2);

        // A focused order also refetches its detail.
        s.order = Some(OrderView {
            workstream_id: "W3".into(),
            key: Some(("lab-a".into(), "p2".into())),
            card: None,
            claims: Vec::new(),
            loaded: true,
            error: None,
            notes: Vec::new(),
            stopping: false,
        });
        e["type"] = json!("review.verdict");
        assert_eq!(tools_of(&s.apply(hub_event(e))), ["order_get"]);
    }

    #[test]
    fn notes_wait_for_the_leads_wake_and_steered_ones_are_remembered() {
        let mut s = synced();
        let key: ProjectKey = ("lab-a".into(), "p1".into());
        s.order = Some(OrderView {
            workstream_id: "W7".into(),
            key: Some(key),
            card: None,
            claims: Vec::new(),
            loaded: true,
            error: None,
            notes: Vec::new(),
            stopping: false,
        });
        let AppClientMessage::Call { id, tool, input } = &s.note("also cover the stalled case", false, Vec::new(), Vec::new(), "n-1")[0] else {
            panic!()
        };
        assert_eq!(tool.as_str(), "order_note");
        assert_eq!(input, &json!({ "workstreamId": "W7", "text": "also cover the stalled case", "urgent": false, "clientRequestId": "n-1" }));
        s.apply(result(id, json!({ "noteId": "N1", "wakesAt": AT })));
        let AppClientMessage::Call { id, .. } = &s.note("stop editing digest.rs", true, Vec::new(), Vec::new(), "n-2")[0] else { panic!() };
        s.apply(result(id, json!({ "noteId": "N2", "wakesAt": AT })));
        let notes = &s.order.as_ref().unwrap().notes;
        assert!(notes.iter().all(|n| n.status == NoteStatus::Queued));
        assert_eq!(s.steered.iter().collect::<Vec<_>>(), ["stop editing digest.rs"]);

        s.apply(event("lead.woken", Some("p2"), None));
        assert_eq!(s.order.as_ref().unwrap().notes.len(), 2, "another project's lead waking changes nothing");
        s.apply(event("lead.woken", Some("p1"), None));
        assert!(s.order.as_ref().unwrap().notes.is_empty(), "the lead has them now");
    }

    #[test]
    fn switching_orders_never_shows_the_previous_projects_lead_log() {
        let mut s = synced();
        let p1: ProjectKey = ("lab-a".into(), "p1".into());
        s.open_project(p1);
        s.detail.as_mut().unwrap().version = 3;
        // An order the app can't place yet: no lead log until its detail names the project.
        let out = s.open_order("W99");
        assert_eq!(tools_of(&out), ["order_get"]);
        assert!(s.detail.is_none());
        let mut detail: Value =
            serde_json::from_str(include_str!("../../../crates/fleetd-contracts/tests/fixtures/live/order_get.output.json")).unwrap();
        detail["order"] = board_json("p2", "W99")["orders"][0].clone();
        let id = calls(&out)[0].0.clone();
        let out = s.apply(result(&id, detail));
        assert_eq!(tools_of(&out), ["project_get", "thread_tail"], "the order's own project and lead");
        assert_eq!(s.detail.as_ref().map(|d| d.key.1.as_str()), Some("p2"));
    }

    #[test]
    fn the_live_subscription_follows_the_screen_and_a_hub_without_it_stays_quiet() {
        let mut s = synced();
        assert_eq!(s.subscribe_live(true, None, false), vec![AppClientMessage::Live { board: true, focus: None }]);
        assert!(s.subscribe_live(true, None, false).is_empty(), "unchanged: not sent again");
        assert_eq!(s.subscribe_live(true, None, true).len(), 1, "the window came back: a fresh full frame");
        let focus = s.subscribe_live(false, Some("W14"), false);
        assert_eq!(focus, vec![AppClientMessage::Live { board: false, focus: Some(WorkstreamId::new("W14").unwrap()) }]);
        // This hub doesn't stream yet: its session error is not a banner, and the app stops asking.
        let e = AppError { id: None, code: ErrorCode::Invalid, message: "This hub does not stream live frames yet.".into(), fix: None };
        s.apply(Incoming::Message(AppServerMessage::Error(e)));
        assert_eq!(s.notice, None);
        assert!(s.subscribe_live(true, None, true).is_empty());
    }

    #[test]
    fn the_router_guess_runs_one_at_a_time_and_a_hub_without_it_changes_nothing() {
        let mut s = synced();
        let AppClientMessage::Call { id, .. } = &s.preview("harden the lead digest")[0] else { panic!() };
        assert!(s.guessing());
        assert!(s.preview("harden the lead digest more").is_empty(), "one in flight");
        let echo = json!({ "projectRef": { "machineId": "lab-a", "projectId": "p2" }, "template": "feature", "reason": "about the digest" });
        s.apply(result(id, json!({ "echo": echo })));
        assert_eq!(s.guess, Some(("harden the lead digest".into(), Some(("lab-a".into(), "p2".into())))));
        let AppClientMessage::Call { id, .. } = &s.preview("something else entirely")[0] else { panic!() };
        s.apply(error(id, ErrorCode::NotFound, "No tool intake_preview.", None));
        assert_eq!(s.guess, Some(("something else entirely".into(), None)));
        assert_eq!(s.echo, None);
    }

    #[test]
    fn call_errors_land_where_the_call_was_for() {
        let mut s = synced();
        let id = calls(&s.apply(event("ask.created", None, None)))[0].0.clone();
        s.apply(error(&id, ErrorCode::NotFound, "No tool asks_list.", Some("Upgrade the hub.")));
        assert_eq!(s.asks_error.as_deref(), Some("No tool asks_list. Upgrade the hub."));
        assert!(s.inflight.is_empty());
    }

    #[test]
    fn open_project_tails_its_lead_and_lead_thread_events_refresh_it() {
        let mut s = synced();
        let key: ProjectKey = ("lab-a".into(), "p1".into());
        let out = calls(&s.open_project(key.clone()));
        assert_eq!(out.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["project_get", "thread_tail"]);
        let tail_id = &out[1].0;
        let thread = json!({ "machineId": "lab-a", "threadId": "lead-1", "projectId": "p1", "title": "lead", "status": "running",
            "headline": "", "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT });
        let items = json!([{ "kind": "message", "at": AT, "role": "assistant", "text": "newest" },
                           { "kind": "message", "at": AT, "role": "user", "text": "oldest" }]);
        s.apply(result(tail_id, json!({ "items": items, "thread": thread })));
        let detail = s.detail.as_ref().unwrap();
        assert!(matches!(&detail.tail[0], TailItem::Message(m) if m.text == "oldest"));
        assert_eq!(detail.version, 1);

        assert!(calls(&s.apply(event("thread.completed", None, Some("other")))).is_empty());
        let out = calls(&s.apply(event("thread.completed", None, Some("lead-1"))));
        assert_eq!(out.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["thread_tail"]);
    }

    #[test]
    fn poll_refreshes_the_tail_only_while_the_lead_works() {
        let mut s = synced();
        let key: ProjectKey = ("lab-a".into(), "p1".into());
        for (id, _) in calls(&s.open_project(key.clone())) {
            s.apply(result(
                &id,
                if s.pending[&id] == Purpose::Tail(key.clone()) {
                    json!({ "items": [], "thread": {
                "machineId": "lab-a", "threadId": "lead-1", "projectId": "p1", "title": "lead", "status": "idle", "headline": "",
                "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT } })
                } else {
                    outcome("p1", Some("lead-1"), "idle")
                },
            ));
        }
        assert!(s.poll(0).is_empty());
        let id = calls(&s.apply(event("lead.woken", Some("p1"), None)))[0].0.clone();
        s.apply(result(&id, outcome("p1", Some("lead-1"), "working")));
        // The project refresh already asked for the tail; a poll meanwhile doesn't double it.
        assert!(s.poll(0).is_empty());
    }

    fn check(id: &str, status: &str, fix: Option<Value>) -> Value {
        let mut c = json!({ "id": id, "scope": "hub", "status": status, "message": format!("{id} is {status}") });
        if let Some(fix) = fix {
            c["fix"] = fix;
        }
        c
    }

    #[test]
    fn doctor_loads_on_open_and_refreshes_on_doctor_changed() {
        let mut s = synced();
        assert!(s.apply(event("doctor.changed", None, None)).is_empty(), "nothing to refresh before the screen opened");
        let out = s.open_doctor();
        let AppClientMessage::Call { id, tool, input } = &out[0] else { panic!() };
        assert_eq!((tool.as_str(), input), ("doctor_list", &json!({})));
        s.apply(result(id, json!({ "checks": [check("hub/gh_auth", "ok", None)], "checkedAt": AT })));
        assert_eq!(s.doctor.as_ref().unwrap().checks.len(), 1);

        let refresh = calls(&s.apply(event("doctor.changed", None, None)));
        assert_eq!(refresh.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["doctor_list"]);
        assert!(s.apply(event("doctor.changed", None, None)).is_empty(), "coalesced while in flight");
        let again = calls(&s.apply(result(&refresh[0].0, json!({ "checks": [], "checkedAt": AT }))));
        assert_eq!(again.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["doctor_list"]);

        let AppClientMessage::Call { input, .. } = &s.rerun_doctor()[0] else { panic!() };
        assert_eq!(input, &json!({ "rerun": true }));
    }

    #[test]
    fn a_doctor_fix_replaces_its_check_and_echoes_what_ran() {
        let mut s = synced();
        let id = calls(&s.open_doctor())[0].0.clone();
        let auto = json!({ "kind": "auto", "label": "Restart the node" });
        s.apply(result(&id, json!({ "checks": [check("hub/gh_auth", "ok", None), check("lab-a/node", "fail", Some(auto))], "checkedAt": AT })));

        let out = s.fix_doctor(&check_id("lab-a/node"));
        let AppClientMessage::Call { id, tool, input } = &out[0] else { panic!() };
        assert_eq!((tool.as_str(), input), ("doctor_fix", &json!({ "checkId": "lab-a/node" })));
        assert!(s.doctor_fixing(&check_id("lab-a/node")));
        assert!(s.fix_doctor(&check_id("lab-a/node")).is_empty(), "one fix at a time per check");
        s.apply(result(id, json!({ "ran": "Restarted the node on lab-a.", "check": check("lab-a/node", "ok", None) })));
        let checks = &s.doctor.as_ref().unwrap().checks;
        assert_eq!(
            checks.iter().map(|c| (c.id.as_str(), c.status)).collect::<Vec<_>>(),
            [("hub/gh_auth", DoctorStatus::Ok), ("lab-a/node", DoctorStatus::Ok)]
        );
        assert_eq!(s.echo, Some(Echo { text: "Restarted the node on lab-a.".into(), ok: true }));

        let AppClientMessage::Call { id, .. } = &s.fix_doctor(&check_id("hub/gh_auth"))[0] else { panic!() };
        s.apply(error(id, ErrorCode::Invalid, "This fix is manual.", Some("Run gh auth login on the hub.")));
        assert_eq!(s.echo, Some(Echo { text: "This fix is manual. Run gh auth login on the hub.".into(), ok: false }));
        assert!(!s.doctor_fixing(&check_id("hub/gh_auth")));
    }

    fn machine_json(id: &str, status: &str, box_key: Option<&str>) -> Value {
        let mut m = json!({ "machineId": id, "name": id, "tags": [], "status": status, "lastSeenAt": AT, "nodeVersion": "0.0.0" });
        if let Some(k) = box_key {
            m["boxPubKey"] = json!(k);
        }
        m
    }

    fn secret_ask(id: &str, sink: &str) -> Ask {
        serde_json::from_value(json!({ "askId": id, "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "kind": "secret",
            "key": "stripe.key", "class": "credential", "text": "Stripe key?", "sink": sink, "blocks": "the deploy",
            "proceededOnRec": false, "state": "open", "batchId": "B1", "number": 1, "createdAt": AT }))
        .unwrap()
    }

    #[test]
    fn a_secret_goes_to_its_sink_machine_only_when_that_machine_can_take_it() {
        let mut s = synced();
        let machines =
            [machine_json("lab-a", "online", Some(BOX_KEY)), machine_json("lab-b", "online", None), machine_json("lab-c", "offline", Some(BOX_KEY))];
        s.machines = machines.iter().map(|m| serde_json::from_value(m.clone()).unwrap()).collect();
        assert_eq!(s.secret_target(&secret_ask("A1", "env:lab-a:/w/p1/.env")), Ok(("lab-a".into(), BOX_KEY.into())));
        assert_eq!(s.secret_target(&secret_ask("A1", "file:lab-a:/home/x/key")).unwrap().0, "lab-a");
        assert!(s.secret_target(&secret_ask("A1", "env:lab-b:/w/.env")).unwrap_err().contains("no box key"));
        assert!(s.secret_target(&secret_ask("A1", "env:lab-c:/w/.env")).unwrap_err().contains("offline"));
        assert!(s.secret_target(&secret_ask("A1", "env:lab-z:/w/.env")).unwrap_err().contains("doesn't know"));
        // The contract refuses a secret ask without a sink; the app still won't guess one.
        let no_sink = Ask { sink: None, ..secret_ask("A1", "env:lab-a:/w/.env") };
        assert!(s.secret_target(&no_sink).unwrap_err().contains("no valid sink"));
    }

    #[test]
    fn submit_secret_sends_the_sealed_value_and_echoes_the_fingerprint() {
        let mut s = synced();
        s.asks.insert("A1".into(), secret_ask("A1", "env:lab-a:/w/p1/.env"));
        let out = s.submit_secret("A1", "lab-a", sealed());
        let AppClientMessage::Call { id, tool, input } = &out[0] else { panic!() };
        assert_eq!((tool.as_str(), input), ("secret_submit", &json!({ "askId": "A1", "sealed": sealed() })));
        assert!(s.secret_submitting("A1"));
        assert!(s.submit_secret("A1", "lab-a", sealed()).is_empty(), "one submit at a time");
        let refresh = calls(&s.apply(result(id, json!({ "askId": "A1", "fingerprint": "0a1b2c3d" }))));
        assert_eq!(s.echo, Some(Echo { text: "stripe.key saved on lab-a, fingerprint 0a1b2c3d".into(), ok: true }));
        assert_eq!(refresh[0].1, "asks_list");

        let AppClientMessage::Call { id, .. } = &s.submit_secret("A1", "lab-a", sealed())[0] else { panic!() };
        s.apply(error(id, ErrorCode::MachineOffline, "lab-a's node did not take the secret.", None));
        assert_eq!(s.echo, Some(Echo { text: "lab-a's node did not take the secret.".into(), ok: false }));
    }

    #[test]
    fn saved_secrets_and_gated_runs_refresh_the_inbox() {
        let mut s = synced();
        for kind in ["ask.secret_saved", "gated.ran"] {
            let out = calls(&s.apply(event(kind, None, None)));
            assert_eq!(out.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["asks_list"], "{kind}");
            s.apply(result(&out[0].0, json!({ "batches": [], "asks": [] })));
        }
    }

    fn loud(kind: &str, summary: &str, ask: Option<&str>, attention: Attention) -> Incoming {
        let mut e = json!({ "seq": 10, "at": AT, "type": kind, "summary": summary, "attention": attention });
        if let Some(id) = ask {
            e["data"] = json!({ "askId": id });
        }
        hub_event(e)
    }

    const NOW: i64 = 1_792_231_200_000;

    #[test]
    fn loud_events_notify_once_the_policy_is_known_unless_answered_first() {
        let mut s = State::default();
        s.apply(Incoming::Ready);
        let out = calls(&s.apply(snapshot(&[], 0)));
        s.apply(loud("usage.breaker", "lab-a breaker open", None, Attention::Loud));
        assert_eq!(s.take_notification(NOW), None, "held until the policy is known");
        s.apply(result(&out[0].0, json!({ "batches": [], "asks": [] })));
        assert_eq!(out[1].1, "attention_policy");
        s.apply(result(&out[1].0, json!({ "coalesceSec": 60, "quiet": [] })));
        assert_eq!(s.take_notification(NOW).unwrap().body, "lab-a breaker open");

        // An ask answered before the window reopens never notifies: the refetch it caused no longer lists it.
        let fetch = calls(&s.apply(loud("ask.created", "A7 [money] pay: Buy?", Some("A7"), Attention::Urgent)));
        let asks = fetch.iter().find(|c| c.1 == "asks_list").unwrap();
        s.apply(result(&asks.0, json!({ "batches": [], "asks": [] })));
        assert_eq!(s.take_notification(NOW + 60_000), None);

        let fetch = calls(&s.apply(loud("ask.created", "A8 [money] pay: Buy?", Some("A8"), Attention::Urgent)));
        let asks = fetch.iter().find(|c| c.1 == "asks_list").unwrap();
        s.apply(result(&asks.0, json!({ "batches": [], "asks": [ask("A8", 1, "open")] })));
        assert_eq!(s.take_notification(NOW + 60_000).unwrap().body, "A8 [money] pay: Buy?");
    }

    #[test]
    fn the_policy_is_fetched_again_on_decisions_and_after_its_last_window() {
        let mut s = synced();
        let out = calls(&s.apply(event("decision.recorded", None, None)));
        let policy = out.iter().find(|c| c.1 == "attention_policy").unwrap().0.clone();
        s.apply(result(&policy, json!({ "coalesceSec": 1200, "quiet": [{ "from": "2026-10-17T09:00:00.000Z", "to": "2026-10-17T11:00:00.000Z" }] })));
        assert!(calls(&s.poll(NOW)).is_empty());
        assert_eq!(calls(&s.poll(NOW + 3_600_000)).iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["attention_policy"]);
    }

    #[test]
    fn an_older_hub_without_attention_policy_gets_the_default_window() {
        let mut s = State::default();
        s.apply(Incoming::Ready);
        let out = s.apply(snapshot(&[], 0));
        let policy = calls(&out).into_iter().find(|c| c.1 == "attention_policy").unwrap();
        s.apply(error(&policy.0, ErrorCode::NotFound, "No tool attention_policy.", None));
        assert_eq!(s.policy, Some(Policy::fallback()));
    }

    #[test]
    fn a_refused_key_stops_everything() {
        let mut s = synced();
        s.apply(Incoming::Unauthorized("Unknown agent key.".into()));
        assert_eq!(s.conn, Conn::Refused("Unknown agent key.".into()));
        assert!(s.open_project(("lab-a".into(), "p1".into())).is_empty());
        assert!(s.open_order("W1").is_empty());
    }
}
