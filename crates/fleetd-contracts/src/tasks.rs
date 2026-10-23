//! M5 objects: fleetd-owned tasks, slots and the repo policy file.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::effort::Effort;
use crate::ids::{ProjectRef, ThreadRef, Timestamp};
use crate::ledger::{SERVES_FIX, Serves, Tier, WorkstreamId};
use crate::prim::{Count, Line, List, NonEmpty, NonNegative, Positive, Text, is_http_url, js_len};
use crate::usage::UsageParked;

brand!(
    /// "T" plus a positive integer, unique per hub, e.g. "T7".
    TaskId, name = "TaskId", pattern = r"^T[1-9][0-9]*$"
);

/// Only write tasks get a worktree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Write,
    Read,
    Review,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Queued,
    Running,
    Idle,
    Done,
    Failed,
    Cancelled,
}

/// It also becomes the branch slug, so one line.
pub type TaskTitle = Line<1, 80>;
pub type TaskPrompt = Text<1, 8000>;

/// A write task must say what it serves; a review task names its PR; only review tasks may be QA runs.
pub fn task_spawn_rule(
    kind: TaskKind,
    serves: bool,
    qa: Option<bool>,
    pr: bool,
) -> Result<(), String> {
    if kind == TaskKind::Write && !serves {
        return Err(format!("a write task needs --serves: {SERVES_FIX}"));
    }
    if kind == TaskKind::Review && !pr {
        return Err("a review task needs --pr <PR URL>".into());
    }
    if qa == Some(true) && kind != TaskKind::Review {
        return Err("--qa applies only to --kind review".into());
    }
    Ok(())
}

/// Counted by the hub from the task's thread items, never from its prose.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Receipts {
    pub commands: Count,
    pub commands_failed: Count,
    pub files_changed: Count,
    pub tool_calls: Count,
}

brand!(
    PrUrl,
    check = is_http_url,
    expected = "an absolute http:// or https:// URL"
);

brand!(
    /// An absolute path.
    AbsolutePath, pattern = r"^/"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskResultStatus {
    Done,
    Failed,
    Cancelled,
}

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub status: TaskResultStatus,
    /// The latest assistant message, trimmed to its last 2000 characters.
    pub tail: Text<0, 2000>,
    pub branch: Option<NonEmpty>,
    pub pr_url: Option<PrUrl>,
    /// Absent on results stored before M6.
    pub receipts: Option<Receipts>,
    /// The tail claims success ("tests pass", "fixed", ...) while `receipts.commands` is 0. Absent before M6.
    pub claims_unverified: Option<bool>,
    pub at: Timestamp,
}

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub task_id: TaskId,
    pub project_ref: ProjectRef,
    pub workstream_id: WorkstreamId,
    pub title: TaskTitle,
    pub kind: TaskKind,
    pub prompt: TaskPrompt,
    pub model: NonEmpty,
    /// Always explicit; resolved at spawn.
    pub effort: Effort,
    pub tier: Option<Tier>,
    pub estimate_minutes: Option<NonNegative>,
    /// Required at spawn for write tasks; optional here for tasks stored before M6.
    pub serves: Option<Serves>,
    /// A review task spawned with `--qa`.
    pub qa: Option<bool>,
    /// The PR a review task reviews. Required at spawn for review; absent on hub-spawned judge tasks and older rows.
    pub pr: Option<PrUrl>,
    /// The plan item it was spawned for (`--item`).
    #[serde(default)]
    pub item_id: Option<crate::plan::PlanItemId>,
    pub state: TaskState,
    /// Why it is queued, e.g. "slots: 40/40 in use".
    pub queued_reason: Option<Text<1, 200>>,
    pub thread_ref: Option<ThreadRef>,
    /// `fleetd/<taskId>-<slug>`; write tasks only.
    pub branch: Option<NonEmpty>,
    pub worktree_path: Option<AbsolutePath>,
    /// M4: its thread hit a usage limit; the task is idle until fleetd sends "continue" at `resumeAt`.
    pub parked: Option<UsageParked>,
    /// 1 for the first launch.
    pub attempt: Positive,
    pub result: Option<TaskResult>,
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlotStatePerProject {
    pub project_ref: ProjectRef,
    /// The most of the project's agents (its tasks: writers, readers, reviewers) that run at once; its lead's own
    /// turns don't count. The fleet `cap` until set.
    pub max_agents: Count,
    /// Its agents running now. Above `maxAgents` right after the cap was lowered: nothing is stopped for it.
    pub running: Count,
    /// Its agents waiting for a slot, paused ones included.
    pub queued: Count,
    /// Every slot it holds, its lead's turns included.
    pub used: Count,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlotState {
    /// Global cap on running turns.
    pub cap: Count,
    pub used: Count,
    pub queued: Count,
    /// Slots of the cap only lead turns may take.
    pub reserved_band: Count,
    pub per_project: List<SlotStatePerProject, 0, 50>,
}

/// Fields `HubEvent.data` carries on `task.*` events.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventData {
    pub task_id: TaskId,
    pub workstream_id: Option<WorkstreamId>,
    /// When the task was spawned: a `task.started` for a task spawned before a turn is not that turn's start.
    pub created_at: Option<Timestamp>,
    pub queued_reason: Option<String>,
    pub branch: Option<String>,
}

/// `agents.cap` data: a project's max agents or the fleet cap changed. The event's summary is the one quiet line its
/// chat shows.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentsCapData {
    /// Absent for the fleet cap.
    pub project_ref: Option<ProjectRef>,
    pub from: Count,
    pub to: Count,
    /// The project's agents (or, for the fleet cap, every slot) running and queued just after the change.
    pub running: Count,
    pub queued: Count,
    /// Agents told to push their work and wait (`pauseExtras`).
    pub paused: Option<List<TaskId, 0, 1000>>,
}

/// Repo-relative.
pub const POLICY_FILE_PATH: &str = ".fleetd/policy.yaml";

/// What every branch fleetd names starts with, by default.
pub const DEFAULT_BRANCH_PREFIX: &str = "fleetd/";

/// A git branch name prefix ending in `/`: components of letters, digits, `.`, `_` and `-`, none empty, none starting
/// with `.` or ending with `.lock`, no `..`, not starting with `-`. Stricter than git, so every task branch under it is
/// a valid ref.
fn is_branch_prefix(s: &str) -> bool {
    let Some(dirs) = s.strip_suffix('/') else {
        return false;
    };
    js_len(s) <= 100
        && !dirs.is_empty()
        && !dirs.starts_with('-')
        && dirs.split('/').all(|c| {
            !c.is_empty()
                && !c.starts_with('.')
                && !c.ends_with(".lock")
                && !c.contains("..")
                && c.chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        })
}

brand!(
    /// A branch name prefix such as "fleetd/" or "slot/3/".
    BranchPrefix,
    check = is_branch_prefix,
    expected = "a branch prefix ending in /, such as fleetd/ (letters, digits, . _ - between the slashes)"
);

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFileDefaults {
    pub model: Option<NonEmpty>,
    pub effort: Option<Effort>,
}

/// Tool permission rules in claude's own syntax (`Bash(npm test:*)`, `Read`, `mcp__github`). They become the
/// session's `--allowedTools` / `--disallowedTools`, and the hub answers a prompt that one of them matches itself.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFileTools {
    #[serde(default)]
    pub allow: List<Text<1, 200>, 0, 100>,
    #[serde(default)]
    pub deny: List<Text<1, 200>, 0, 100>,
}

/// The repo policy file, as decoded from YAML. Keys it doesn't know are ignored.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFile {
    pub defaults: Option<PolicyFileDefaults>,
    pub tools: Option<PolicyFileTools>,
    /// What the branches fleetd names start with (default `fleetd/`), for several fleets sharing one repo.
    pub branch_prefix: Option<BranchPrefix>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn accepts<T: serde::de::DeserializeOwned>(value: Value) -> bool {
        serde_json::from_value::<T>(value).is_ok()
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;
        base
    }

    #[test]
    fn task_id_is_t_plus_a_positive_integer() {
        for id in ["T1", "T42"] {
            assert!(TaskId::new(id).is_ok(), "{id}");
        }
        for id in ["T0", "T01", "t1", "W1", "T", "T1a"] {
            assert!(TaskId::new(id).is_err(), "{id}");
        }
    }

    #[test]
    fn spawn_rules() {
        let err = task_spawn_rule(TaskKind::Write, false, None, false).unwrap_err();
        assert!(err.contains(
            "say what this serves: serves done:<n> | issue:<ref> | defect:<text> | decision:<key>"
        ));
        assert!(task_spawn_rule(TaskKind::Review, false, Some(true), true).is_ok());
        assert!(task_spawn_rule(TaskKind::Review, false, None, false).is_err());
        assert!(task_spawn_rule(TaskKind::Write, true, Some(true), false).is_err());
    }

    #[test]
    fn task_caps_the_result_tail() {
        let at = "2026-10-17T10:00:00.000Z";
        let task = json!({
            "taskId": "T1",
            "projectRef": { "machineId": "devbox", "projectId": "p1" },
            "workstreamId": "W1",
            "title": "add file",
            "kind": "write",
            "prompt": "create docs/x.md",
            "model": "claude-opus-5-5",
            "effort": "high",
            "state": "done",
            "attempt": 1,
            "result": { "status": "done", "tail": "x".repeat(2000), "branch": "fleetd/T1-add-file", "at": at },
            "createdAt": at,
        });
        assert!(accepts::<Task>(task.clone()));
        // Tasks stored while writers leased areas still read.
        assert!(accepts::<Task>(with(
            task.clone(),
            "areas",
            json!(["docs"])
        )));
        let mut long_tail = task.clone();
        long_tail["result"]["tail"] = json!("x".repeat(2001));
        assert!(!accepts::<Task>(long_tail));
        let mut bad_pr = task.clone();
        bad_pr["result"]["prUrl"] = json!("javascript:alert(1)");
        assert!(!accepts::<Task>(bad_pr));
        // Round trip keeps the wire shape.
        let decoded: Task = serde_json::from_value(task.clone()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), task);
    }

    #[test]
    fn policy_file_ignores_keys_it_does_not_know() {
        let decoded: PolicyFile = serde_json::from_value(
            json!({ "areas": { "docs": ["docs/**"] }, "defaults": { "effort": "high" } }),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&decoded).unwrap(),
            json!({ "defaults": { "effort": "high" } })
        );
        assert!(!accepts::<PolicyFile>(
            json!({ "defaults": { "effort": "medium-ish" } })
        ));
    }

    #[test]
    fn branch_prefixes_are_ref_safe_and_end_in_a_slash() {
        for prefix in ["fleetd/", "slot/3/", "noci/1/", "team_a/bots-2/", "v1.2/"] {
            assert!(BranchPrefix::new(prefix).is_ok(), "{prefix}");
        }
        for prefix in [
            "", "/", "fleetd", "/fleetd/", "slot//3/", "-x/", ".hidden/", "a/.b/", "a..b/",
            "x.lock/", "a b/", "a~b/", "a^b/", "a:b/", "a?b/", "a*b/", "a[b/", "a\\b/", "a@{b/",
            "ünï/",
        ] {
            assert!(BranchPrefix::new(prefix).is_err(), "{prefix}");
        }
        assert!(BranchPrefix::new(format!("{}/", "x".repeat(100))).is_err());
        assert!(accepts::<PolicyFile>(json!({ "branchPrefix": "slot/3/" })));
        assert!(!accepts::<PolicyFile>(json!({ "branchPrefix": "slot 3" })));
    }
}
