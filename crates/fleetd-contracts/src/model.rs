use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectId, ThreadId, Timestamp};
use crate::ledger::{Lead, Workstream};
use crate::prim::{AnyInt, Count, List, Text};
use crate::secrets::BoxPublicKey;
use crate::sessions::RunEnd;
use crate::tasks::Task;
use crate::train::TrainState;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MachineStatus {
    Online,
    Offline,
    Degraded,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub machine_id: MachineId,
    pub name: String,
    pub tags: Vec<String>,
    pub status: MachineStatus,
    pub last_seen_at: Timestamp,
    pub node_version: String,
    /// Plain language, set while status is "degraded".
    pub degraded_reason: Option<String>,
    /// M8: the node's X25519 key from its hello; clients seal this machine's secrets to it. Absent: it takes no
    /// secrets.
    pub box_pub_key: Option<BoxPublicKey>,
    /// The machine's latest sleep its node reported on waking.
    pub last_slept: Option<SleptSpan>,
}

/// A span a machine spent asleep, epoch milliseconds; `machine.slept` carries the same fields as its data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct SleptSpan {
    pub from_ms: Count,
    pub to_ms: Count,
}
crate::checked!(SleptSpan, |span| {
    if span.to_ms <= span.from_ms {
        return Err("toMs must be after fromMs".into());
    }
    Ok(())
});

/// Status views show a sleep for this long after the machine woke.
pub const SLEPT_SHOWN_MS: i64 = 60 * 60 * 1000;

impl SleptSpan {
    pub fn new(from_ms: i64, to_ms: i64) -> Result<Self, String> {
        if to_ms <= from_ms {
            return Err("toMs must be after fromMs".into());
        }
        Ok(Self {
            from_ms: Count::new(from_ms)?,
            to_ms: Count::new(to_ms)?,
        })
    }

    pub fn ms(&self) -> i64 {
        self.to_ms.get() - self.from_ms.get()
    }

    /// "slept 10m46s", while the wake is under [`SLEPT_SHOWN_MS`] old at `now_ms`.
    pub fn recent_text(&self, now_ms: i64) -> Option<String> {
        (now_ms - self.to_ms.get() < SLEPT_SHOWN_MS)
            .then(|| format!("slept {}", duration_text(self.ms())))
    }
}

/// "46s", "10m46s", "2h05m".
pub fn duration_text(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m{:02}s", s / 60, s % 60),
        _ => format!("{}h{:02}m", s / 3600, s % 3600 / 60),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadCounts {
    pub running: Count,
    pub waiting: Count,
    pub idle: Count,
    pub failed: Count,
}

/// A project's tasks by state, all time.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TaskCounts {
    pub queued: Count,
    pub running: Count,
    pub idle: Count,
    pub done: Count,
    pub failed: Count,
    pub cancelled: Count,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub machine_id: MachineId,
    pub project_id: ProjectId,
    pub title: String,
    pub workspace_root: String,
    pub threads: ThreadCounts,
    pub last_activity_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus {
    Running,
    Waiting,
    Idle,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadError {
    pub class: String,
    pub message: String,
    /// The model the failure names, when the runner read one off it (a gateway with no account for it).
    pub model: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub machine_id: MachineId,
    pub thread_id: ThreadId,
    pub project_id: ProjectId,
    pub title: String,
    pub status: ThreadStatus,
    /// First line of the latest visible assistant text.
    pub headline: Text<0, 280>,
    pub latest_message_tail: Text<0, 4096>,
    pub last_error: Option<ThreadError>,
    pub usage_limit_reset_at: Option<Timestamp>,
    /// Why its latest run ended; absent while it runs and from older nodes.
    pub end_cause: Option<RunEnd>,
    pub last_progress_at: Timestamp,
    pub model: Option<String>,
    /// As reported by the runner; not narrowed to Effort because it may report other levels.
    pub effort: Option<String>,
    pub stale: bool,
    pub as_of: Timestamp,
}

/// The one-call project outcome, returned as-is by project_get.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOutcome {
    pub project: ProjectSummary,
    /// Newest activity first. Task threads are left out; they show under `tasks`.
    pub threads: List<ThreadSummary, 0, 20>,
    /// Absent until lead_start.
    pub lead: Option<Lead>,
    /// Whether the lead may run a task on the medium profile (`project_set`); absent from older hubs, where it is on.
    pub medium_allowed: Option<bool>,
    /// Open workstreams (not done, stopped or failed), newest first.
    pub workstreams: Option<List<Workstream, 0, 20>>,
    /// Absent until the project has a task.
    pub task_counts: Option<TaskCounts>,
    /// Newest first.
    pub tasks: Option<List<Task, 0, 20>>,
    /// The merge trains of the project's repos; absent until one of its PRs was enqueued.
    pub trains: Option<List<TrainState, 0, 10>>,
    pub stale: bool,
    pub as_of: Timestamp,
    /// Hint for the next call.
    pub next: Option<String>,
    /// True when `threads`, `workstreams` or `tasks` was trimmed to its limit.
    pub truncated: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Command,
    FileChange,
    ToolCall,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    Completed,
    Failed,
    Running,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub at: Timestamp,
    pub kind: ActionKind,
    pub status: ActionStatus,
    /// The command, path or tool.
    pub summary: Text<0, 200>,
    pub output_tail: Option<Text<0, 1024>>,
    /// Only when the runner reports one or the output says "Exit code N".
    pub exit_code: Option<AnyInt>,
    pub failed: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    #[default]
    FullAccess,
    ApprovalRequired,
}
