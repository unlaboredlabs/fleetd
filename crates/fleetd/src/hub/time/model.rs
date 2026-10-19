//! The in-memory shapes the pure parts of the time area read: stored spans as rows, and what a critical path walk
//! needs about an order.
use std::collections::HashMap;

use fleetd_contracts::time::{Category, SpanExtra, SpanKind, SpanStatus};

/// A stored span. Open spans are cut at the query's `until` by the loader, so `end_ms` is always set.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub id: i64,
    pub kind: SpanKind,
    pub start_ms: i64,
    pub end_ms: i64,
    /// Exclusive time. 0 on envelopes (`run`, `model.message` when its phases tile it) and on detail spans that sit
    /// beside the lane's tiling (`ci.check`, `ci.queue`, `slots.full`, `ask.info`, `gap`).
    pub excl_ms: i64,
    pub lane: String,
    pub parent_id: Option<i64>,
    pub label_id: Option<i64>,
    pub label: Option<String>,
    /// The program: "cargo test", "git push", "Read", "mcp__x__y".
    pub family: Option<String>,
    pub exit_code: Option<i64>,
    pub out_bytes: Option<i64>,
    pub status: SpanStatus,
    pub machine_id: Option<String>,
    pub project_id: Option<String>,
    pub workstream_id: Option<String>,
    pub task_id: Option<String>,
    pub thread_id: Option<String>,
    /// The session's role: "lead", "implementer", "reviewer"…; absent on spans outside a lead's or task's session.
    pub role: Option<String>,
    pub extra: SpanExtra,
}

impl Row {
    pub fn cat(&self) -> Category {
        self.kind.category()
    }
    pub fn dur(&self) -> i64 {
        (self.end_ms - self.start_ms).max(0)
    }
}

/// Which span owns an instant its lane shares with another span (see `crate::tiles`). A permission prompt sits
/// inside its tool; a retry or compaction inside the model's time; overlapping tool calls go to their group.
pub fn rank(kind: SpanKind) -> u8 {
    use SpanKind::*;
    match kind {
        WaitPermission => 9,
        WaitRetryApi | Compaction => 8,
        ToolsParallel => 7,
        ToolBash | ToolRead | ToolEdit | ToolWeb | ToolMcp | ToolOther | Git | CheckClaim => 6,
        ModelFirstToken | ModelThinking | ModelOutput => 4,
        // Waits that may overlap a session's runs (a wake or send arriving mid-turn, a park, a queued write) yield to
        // whatever the node measured in the run.
        WakeDebounce | RunQueued | RunStartup | ParkUsage | WaitOffline | WaitRetryNode => 1,
        ModelMessage => 3,
        Run | Gap | CiCheck | CiQueue | SlotsFull | AskInfo => 0,
        _ => 5,
    }
}

/// Spans that sit beside a lane's tiling instead of in it: they never own an instant, and a critical path never
/// steps onto them (a check's own interval is read from `ci.check` for the `ci_check_critical` rule only).
pub fn is_detail(kind: SpanKind) -> bool {
    matches!(
        kind,
        SpanKind::Run
            | SpanKind::CiCheck
            | SpanKind::CiQueue
            | SpanKind::SlotsFull
            | SpanKind::AskInfo
            | SpanKind::Gap
    )
}

/// What a critical-path walk needs about one order.
#[derive(Clone, Debug, Default)]
pub struct PathInput {
    /// `intake.route` start or `workstream.created`.
    pub start_ms: i64,
    /// `workstream.done`, or now.
    pub end_ms: i64,
    /// The order's spans (all kinds; the walk keeps what it may step on).
    pub rows: Vec<Row>,
    /// Lane -> the lanes it waits on: a task lane on the lead lane that spawned it, a change lane on its writer's
    /// lane, a review lane on its change, the lead lane on the lanes whose events woke it.
    pub waits_on: HashMap<String, Vec<String>>,
}

/// The inputs of the insight rules over one period.
#[derive(Clone, Debug, Default)]
pub struct RuleInput {
    pub since_ms: i64,
    pub until_ms: i64,
    pub rows: Vec<Row>,
    /// Critical paths of the orders in range that have one (finished orders, from `time_paths`; running orders
    /// computed on read).
    pub paths: Vec<(String, fleetd_contracts::time::CriticalPath)>,
    /// Task id -> its title, for messages ("in T88 add the login page").
    pub task_titles: HashMap<String, String>,
    /// The slot cap now.
    pub slot_cap: i64,
    /// What the serial-wait rules read beyond the scope's spans.
    pub serial: Serial,
}

/// A plan item of a running order that could have started: open, every `after` item done, no task spawned for it
/// and no blocking ask open on its order. One per stretch, clipped to the period.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ready {
    /// `<machine>/<project>`.
    pub project: String,
    pub workstream_id: String,
    /// "P3".
    pub item_id: String,
    pub title: String,
    pub from_ms: i64,
    pub to_ms: i64,
}

/// One run of a project's lead session.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LeadRun {
    pub project: String,
    pub span_id: i64,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// How the train batches now: the most PRs one CI run takes (0: not known, so no train findings), and the repos
/// GitHub refused batch merges for, with why.
#[derive(Clone, Debug, Default)]
pub struct Batching {
    pub max: i64,
    pub off: HashMap<String, String>,
}

/// Fleet-wide facts for the serial-wait rules, read whatever the scope: whether a slot was free is a fleet fact.
#[derive(Clone, Debug, Default)]
pub struct Serial {
    pub ready: Vec<Ready>,
    /// `slots.full` spells.
    pub slots_full: Vec<(i64, i64)>,
    /// Every `queue.slot` wait in the fleet: while one waits, new work would wait too.
    pub slot_queued: Vec<(i64, i64)>,
    /// Per machine: when it was parked on a usage limit or offline, so its leads and tasks could not run.
    pub machine_blocked: HashMap<String, Vec<(i64, i64)>>,
    pub batching: Batching,
    /// The runs of the leads of the projects in `ready`.
    pub lead_runs: Vec<LeadRun>,
    /// `<machine>/<project>` -> its title.
    pub project_titles: HashMap<String, String>,
}
