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
    /// beside the lane's tiling (`ci.check`, `ci.queue`, `gap`).
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
    /// A task's profile, "high" for a lead; absent on spans of neither.
    pub profile: Option<String>,
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
        ToolBash | ToolRead | ToolEdit | ToolWeb | ToolMcp | ToolOther | Git => 6,
        ModelFirstToken | ModelThinking | ModelOutput => 4,
        // Waits that may overlap a session's runs (a wake or send arriving mid-turn, a park, a queued write) yield to
        // whatever the node measured in the run.
        WakeDebounce | RunQueued | RunStartup | ParkUsage | WaitOffline | WaitRetryNode => 1,
        ModelMessage => 3,
        Run | Gap | CiCheck | CiQueue => 0,
        _ => 5,
    }
}

/// Spans that sit beside a lane's tiling instead of in it: they never own an instant, and a critical path never
/// steps onto them.
pub fn is_detail(kind: SpanKind) -> bool {
    matches!(
        kind,
        SpanKind::Run | SpanKind::CiCheck | SpanKind::CiQueue | SpanKind::Gap
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
    pub rows: Vec<Row>,
    /// Task id -> its title, for messages ("in T88 add the login page").
    pub task_titles: HashMap<String, String>,
}
