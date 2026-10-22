//! The agent time inspector: spans (one interval of one lane), the node-to-hub span frames, and the shapes the
//! `time_*` tools return. Every `ms` here is milliseconds since the Unix epoch on the hub clock, or a duration.
//! Node stamps are moved onto the hub clock when the hub stores them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use crate::ledger::WorkstreamId;
use crate::live::AgentRole;
use crate::prim::{AnyInt, Count, Line, List, Text};
use crate::tasks::TaskId;

/// Which color a span gets in every view, and which breakdown row it adds to.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Model,
    Tools,
    /// Waiting on the machine or the provider: retries, startup, compaction, claude-local time.
    Machine,
    Queue,
    /// Waiting on a person.
    Human,
    /// CI, review and the merge train.
    Pipeline,
    /// A session alive with no run and nobody waiting on it. Never on a critical path.
    Idle,
}

impl Category {
    pub const ALL: [Category; 7] = [
        Category::Model,
        Category::Tools,
        Category::Machine,
        Category::Queue,
        Category::Human,
        Category::Pipeline,
        Category::Idle,
    ];

    pub fn code(self) -> i64 {
        self as i64
    }

    pub fn from_code(code: i64) -> Option<Self> {
        Self::ALL.get(usize::try_from(code).ok()?).copied()
    }

    /// The critical path's tie-break order: a wait on a person wins over CI, and so on down to model time.
    pub fn path_rank(self) -> u8 {
        match self {
            Category::Human => 0,
            Category::Pipeline => 1,
            Category::Queue => 2,
            Category::Machine => 3,
            Category::Tools => 4,
            Category::Model => 5,
            Category::Idle => 6,
        }
    }
}

macro_rules! span_kinds {
    ($($(#[$meta:meta])* $variant:ident = $code:literal, $name:literal, $cat:ident;)*) => {
        /// What a span measures. Each kind belongs to exactly one [`Category`]. The code is the stored integer and
        /// never changes; new kinds take new codes.
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
        pub enum SpanKind {
            $($(#[$meta])* #[serde(rename = $name)] $variant,)*
        }

        impl SpanKind {
            pub const ALL: &'static [SpanKind] = &[$(SpanKind::$variant,)*];

            pub fn as_str(self) -> &'static str {
                match self { $(SpanKind::$variant => $name,)* }
            }

            pub fn parse(name: &str) -> Option<Self> {
                match name { $($name => Some(SpanKind::$variant),)* _ => None }
            }

            pub fn code(self) -> i64 {
                match self { $(SpanKind::$variant => $code,)* }
            }

            pub fn from_code(code: i64) -> Option<Self> {
                match code { $($code => Some(SpanKind::$variant),)* _ => None }
            }

            pub fn category(self) -> Category {
                match self { $(SpanKind::$variant => Category::$cat,)* }
            }
        }
    };
}

span_kinds! {
    /// A run's envelope, lifecycle started to its end. Its leaves tile it; it has no exclusive time of its own.
    Run = 1, "run", Machine;
    /// One assistant message, from the previous visible stream event to `message_stop`.
    ModelMessage = 2, "model.message", Model;
    /// Previous visible stream event to `message_start`: claude-local work, network, API queueing and prefill.
    ModelFirstToken = 3, "model.first_token", Model;
    ModelThinking = 4, "model.thinking", Model;
    ModelOutput = 5, "model.output", Model;
    ToolBash = 10, "tool.bash", Tools;
    /// Read, Grep, Glob, LS.
    ToolRead = 11, "tool.read", Tools;
    /// Edit, MultiEdit, Write, NotebookEdit.
    ToolEdit = 12, "tool.edit", Tools;
    ToolWeb = 13, "tool.web", Tools;
    ToolMcp = 14, "tool.mcp", Tools;
    ToolOther = 15, "tool.other", Tools;
    /// Overlapping tool calls from one message; the calls are its children.
    ToolsParallel = 16, "tools.parallel", Tools;
    /// Train git, and agent Bash whose program is `git` or `gh`.
    Git = 17, "git", Tools;
    CheckClaim = 18, "check.claim", Tools;
    WaitRetryApi = 20, "wait.retry.api", Machine;
    WaitRetryNode = 21, "wait.retry.node", Machine;
    RunStartup = 22, "run.startup", Machine;
    Compaction = 23, "compaction", Machine;
    /// Time inside a run that no other span covers: claude-local work between stream events.
    #[default]
    ClaudeOther = 24, "claude.other", Machine;
    /// A write waiting in the hub's queue for an offline machine.
    WaitOffline = 25, "wait.offline", Machine;
    QueueSlot = 30, "queue.slot", Queue;
    QueueLease = 31, "queue.lease", Queue;
    QueueUsage = 32, "queue.usage", Queue;
    QueueOffline = 33, "queue.offline", Queue;
    /// A send waiting behind the session's active run.
    RunQueued = 34, "run.queued", Queue;
    WakeDebounce = 35, "wake.debounce", Queue;
    ParkUsage = 36, "park.usage", Queue;
    /// The fleet's slots were all held. On the fleet lane.
    SlotsFull = 37, "slots.full", Queue;
    /// A permission prompt, inside its tool span; `extra.decidedBy` says who answered.
    WaitPermission = 40, "wait.permission", Human;
    /// A secret or approval request, opened to settled.
    WaitRequest = 41, "wait.request", Human;
    ChangeReview = 50, "change.review", Pipeline;
    /// Waiting in the train's line.
    ChangeQueue = 51, "change.queue", Pipeline;
    ChangeRebase = 52, "change.rebase", Pipeline;
    ChangeCi = 53, "change.ci", Pipeline;
    /// One check run, GitHub's own `started_at` to `completed_at`.
    CiCheck = 54, "ci.check", Pipeline;
    /// The train's push to the check's start.
    CiQueue = 55, "ci.queue", Pipeline;
    ChangeMerge = 56, "change.merge", Pipeline;
    /// needs_rebase or ci_failed until the next head.
    ChangeBlocked = 57, "change.blocked", Pipeline;
    /// Intake, from submit to placed.
    IntakeRoute = 58, "intake.route", Pipeline;
    Idle = 60, "idle", Idle;
    /// Lost data: spans the node dropped or the hub could not take. `extra.count` says how many.
    Gap = 61, "gap", Idle;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpanStatus {
    #[default]
    Ok,
    Failed,
    Cancelled,
    /// Still open when it was cut, e.g. a check still running when a red one decided.
    Incomplete,
}

impl SpanStatus {
    pub fn code(self) -> i64 {
        self as i64
    }
    pub fn from_code(code: i64) -> Self {
        match code {
            1 => SpanStatus::Failed,
            2 => SpanStatus::Cancelled,
            3 => SpanStatus::Incomplete,
            _ => SpanStatus::Ok,
        }
    }
}

/// Who answered a permission prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecidedBy {
    /// The node's own policy, at once.
    Policy,
    /// A project tool rule on the hub.
    HubRule,
    Lead,
    Human,
}

/// Small per-kind facts. Every field is optional and bounded.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpanExtra {
    /// `ci.check`: the check name and its page.
    pub check: Option<Text<1, 200>>,
    pub url: Option<Text<1, 500>>,
    pub decided_by: Option<DecidedBy>,
    /// Who answered, e.g. a key's label. Never a secret.
    pub answered_by: Option<Text<1, 80>>,
    /// Free text from the source, e.g. a queue reason or a stop reason.
    pub reason: Option<Text<0, 200>>,
    pub attempt: Option<Count>,
    /// `wait.retry.*`: the delay claude or the node announced. The span is the real wait.
    pub stated_delay_ms: Option<Count>,
    /// `wait.retry.api`: the HTTP status claude retried on.
    pub http_status: Option<Count>,
    /// `model.message`.
    pub stop_reason: Option<Line<1, 40>>,
    pub output_tokens: Option<Count>,
    pub thinking_tokens: Option<Count>,
    /// `tool.*`: claude's own figure for the call, when the result carries one.
    pub claude_ms: Option<Count>,
    /// `run`: the result line's `duration_ms` and `duration_api_ms`.
    pub duration_ms: Option<Count>,
    pub duration_api_ms: Option<Count>,
    /// The node's own start stamp, kept when the clock offset was above 100 ms.
    pub node_start_ms: Option<Count>,
    /// `slots.full`: the peak count of tasks queued for a slot, and the cap.
    pub peak_queued: Option<Count>,
    pub cap: Option<Count>,
    /// `gap`: how many spans were lost.
    pub count: Option<Count>,
    /// `wait.permission`: the node's request id, joined to the hub's approval request.
    pub request_id: Option<Text<1, 120>>,
    /// `wait.request`: the secret's key.
    pub key: Option<Text<1, 200>>,
    /// The tool's name, for tool and permission spans.
    pub tool: Option<Line<1, 120>>,
}

/// A span as the node sends it. `key` is unique within the node (`<session>/<tool_use_id>`,
/// `<session>/msg/<message_id>`, `<session>/<run>/gap/<n>`), so a resend is a no-op on the hub.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpanWire {
    pub key: Text<1, 300>,
    pub kind: SpanKind,
    pub session_id: ThreadId,
    pub run_id: Option<Text<1, 120>>,
    /// The parent's `key`.
    pub parent: Option<Text<1, 300>>,
    /// Node clock.
    pub start_ms: Count,
    pub end_ms: Count,
    /// Exclusive time within its run, computed when the run ended. Absent on spans outside a run.
    pub excl_ms: Option<Count>,
    /// The command, the path, or the tool and its detail; worktree paths shown as `<wt>`.
    pub label: Option<Text<0, 500>>,
    pub exit_code: Option<AnyInt>,
    /// The full output size, before any cap.
    pub out_bytes: Option<Count>,
    #[serde(default)]
    pub status: SpanStatus,
    pub extra: Option<SpanExtra>,
}

/// A stored span, as the tools return it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub id: Count,
    pub kind: SpanKind,
    pub cat: Category,
    /// `thread:<machine>/<thread>`, `change:<id>`, `requests:<order>`, `train:<repo>`, `fleet`, `order:<id>`.
    pub lane: Text<1, 300>,
    pub start_ms: Count,
    /// Absent while open.
    pub end_ms: Option<Count>,
    /// Exclusive time: the part no child covers. Absent while open and on envelopes.
    pub excl_ms: Option<Count>,
    pub machine_id: Option<MachineId>,
    pub project_id: Option<ProjectId>,
    pub workstream_id: Option<WorkstreamId>,
    pub task_id: Option<TaskId>,
    pub thread_id: Option<ThreadId>,
    pub run_id: Option<Text<1, 120>>,
    pub parent: Option<Count>,
    pub label: Option<Text<0, 500>>,
    /// The program, e.g. "cargo test", "git push", "Read", "mcp__x__y".
    pub family: Option<Text<0, 120>>,
    pub exit_code: Option<AnyInt>,
    pub out_bytes: Option<Count>,
    pub status: SpanStatus,
    /// The item id in the thread (claude's tool_use or message id), for `thread_window`.
    pub item_id: Option<Text<1, 200>>,
    pub extra: Option<SpanExtra>,
}

/// What the numbers cover.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TimeScope {
    Fleet,
    Machine {
        machine_id: MachineId,
    },
    Project {
        project_ref: ProjectRef,
    },
    /// The project's lead sessions, split across orders by the workstreams each wake served.
    Lead {
        project_ref: ProjectRef,
    },
    Order {
        workstream_id: WorkstreamId,
    },
    /// Includes the task's subagents (tasks it spawned).
    Task {
        task_id: TaskId,
    },
    Thread {
        machine_id: MachineId,
        thread_id: ThreadId,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Period {
    pub since: Timestamp,
    pub until: Timestamp,
}

#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimeFilters {
    pub project_ref: Option<ProjectRef>,
    pub machine_id: Option<MachineId>,
    pub role: Option<AgentRole>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GapWhy {
    /// The node runs a fleetd without the span outbox.
    NodeOlder,
    /// The node's outbox passed its 7-day or 500k-row bound and dropped its oldest spans.
    NodeDropped,
    /// The hub's span writer was full.
    HubDropped,
    /// A session lane with no node spans.
    NoNodeSpans,
    /// The critical path found time with nothing running.
    NothingRunning,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub why: GapWhy,
    pub lane: Option<Text<1, 300>>,
    pub machine_id: Option<MachineId>,
    pub from_ms: Count,
    pub to_ms: Count,
    pub count: Option<Count>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub complete: bool,
    pub gaps: List<Gap, 0, 50>,
    /// Spans are kept only from here (retention): span lists, commands, CI checks and insights start here, while
    /// category totals before it come from the daily roll-ups.
    pub detail_since: Option<Timestamp>,
    /// The read hit its span cap and kept the newest spans.
    pub capped: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KindTotal {
    pub kind: SpanKind,
    pub ms: Count,
    pub n: Count,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotal {
    pub cat: Category,
    /// Exclusive agent time.
    pub ms: Count,
    pub n: Count,
    pub kinds: List<KindTotal, 0, 64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandStat {
    pub label: Text<0, 500>,
    pub family: Text<0, 120>,
    pub n: Count,
    /// Per call: each call's own interval, which may overlap others.
    pub total_ms: Count,
    pub p50_ms: Count,
    pub max_ms: Count,
    pub failed: Count,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepeatStat {
    pub label: Text<0, 500>,
    pub thread_id: ThreadId,
    pub task_id: Option<TaskId>,
    /// Runs in a row with no edit between them.
    pub n: Count,
    pub total_ms: Count,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CiCheckStat {
    pub name: Text<1, 200>,
    pub n: Count,
    pub total_ms: Count,
    pub p50_ms: Count,
    pub max_ms: Count,
    /// Time this check added on critical paths past the second-latest check.
    pub critical_excess_ms: Count,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LongestWait {
    pub span_id: Count,
    pub ms: Count,
    /// The secret's key, or the tool for a permission prompt.
    pub label: Option<Text<0, 200>>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HumanWait {
    pub total_ms: Count,
    pub n: Count,
    pub longest: Option<LongestWait>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathSegment {
    /// Absent on a "nothing running" gap.
    pub span_id: Option<Count>,
    pub lane: Text<1, 300>,
    pub kind: SpanKind,
    pub cat: Category,
    pub start_ms: Count,
    pub end_ms: Count,
    pub label: Option<Text<0, 500>>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMs {
    pub cat: Category,
    pub ms: Count,
    /// The same total by kind, e.g. `change.ci`, `change.review` and `change.queue` within pipeline.
    pub kinds: Option<List<KindTotal, 0, 64>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CriticalPath {
    pub start_ms: Count,
    pub end_ms: Count,
    /// Oldest first; they add up to `end_ms - start_ms`.
    pub segments: List<PathSegment, 0, 400>,
    /// True when the order had more segments than fit; the totals still cover them all.
    pub segments_truncated: bool,
    pub totals: List<CategoryMs, 0, 8>,
    /// Time with nothing running, which points at missing data.
    pub nothing_running_ms: Count,
    /// Agent time minus the path.
    pub off_path_ms: Count,
}

/// The numbers of one period, for a comparison.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PeriodBreakdown {
    pub since: Timestamp,
    pub until: Timestamp,
    pub wall_ms: Count,
    pub agent_ms: Count,
    pub by_category: List<CategoryTotal, 0, 8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum InsightRule {
    FullSuiteRepeat,
    RepeatNoChange,
    FailingRepeat,
    SlowCommands,
    CiCheckCritical,
    CiReaction,
    SlotsFull,
    HumanWait,
    ApprovalRule,
    UsageParks,
    Retries,
    ReviewShare,
    TrainLine,
    RebaseLoops,
    FirstToken,
    Startup,
    Offline,
    Coverage,
    /// Serial waits: work that waited while capacity existed. A task queued for a slot while the fleet had free
    /// ones (a project's max agents, the lead band), or a PR that waited out another PR's train cycle.
    QueueWait,
    /// Tasks serialized on one shared resource: an area lease, or one machine's usage limit.
    Contention,
    /// A lead was idle while its running order had a plan item ready to start and slots were free.
    IdleLead,
    /// Two or more ready plan items of a project waited side by side for a start while slots were free.
    SlotsUnderused,
    /// A rule this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InsightNumber {
    pub name: Line<1, 40>,
    pub value: AnyInt,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub rule: InsightRule,
    pub message: Text<1, 600>,
    /// The numbers the message was built from (durations in ms).
    pub numbers: List<InsightNumber, 0, 12>,
    /// At most 200; `time_spans { rule }` lists them all.
    pub span_ids: List<Count, 0, 200>,
    /// The same numbers for the compare period. Present on every insight when a compare period was asked for,
    /// also when the rule fired in only one of the two.
    pub compare: Option<List<InsightNumber, 0, 12>>,
    /// Which periods the rule fired in, with a compare period.
    pub fired_in: Option<FiredIn>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FiredIn {
    Current,
    Compare,
    Both,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_codes_and_names_are_unique_and_round_trip() {
        let mut codes = std::collections::HashSet::new();
        for kind in SpanKind::ALL {
            assert!(codes.insert(kind.code()), "{kind:?}");
            assert_eq!(SpanKind::from_code(kind.code()), Some(*kind));
            assert_eq!(SpanKind::parse(kind.as_str()), Some(*kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        for cat in Category::ALL {
            assert_eq!(Category::from_code(cat.code()), Some(cat));
        }
    }

    #[test]
    fn a_rule_from_a_newer_hub_degrades_instead_of_failing_the_insights() {
        let rule: InsightRule = serde_json::from_value(serde_json::json!("brand_new")).unwrap();
        assert_eq!(rule, InsightRule::Unknown);
        let known: InsightRule = serde_json::from_value(serde_json::json!("idle_lead")).unwrap();
        assert_eq!(known, InsightRule::IdleLead);
    }
}
