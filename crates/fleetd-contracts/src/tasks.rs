//! M5 objects: fleetd-owned tasks, slots and the repo policy file.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::effort::TaskProfile;
use crate::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{Count, Line, List, NonEmpty, Positive, Text, is_http_url, js_len};
use crate::sessions::{RunEnd, WorktreeBase};
use crate::usage::UsageParked;

brand!(
    /// "T" plus a positive integer, unique per hub, e.g. "T7".
    TaskId, name = "TaskId", pattern = r"^T[1-9][0-9]*$"
);

/// Every task gets its own worktree: a writer on its own branch, a reader or reviewer detached.
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

/// Paths a writer's spawn may declare.
pub const SPAWN_PATHS_MAX: usize = 50;

/// A review task names its PR; only review tasks may be QA runs.
pub fn task_spawn_rule(kind: TaskKind, qa: Option<bool>, pr: bool) -> Result<(), String> {
    if kind == TaskKind::Review && !pr {
        return Err("a review task needs --pr <PR URL>".into());
    }
    if qa == Some(true) && kind != TaskKind::Review {
        return Err("--qa applies only to --kind review".into());
    }
    Ok(())
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
    /// Why its last run ended (the node stopped, claude exited, a limit, context full, …); absent on results an
    /// older hub recorded, and when it never ran.
    pub end_cause: Option<RunEnd>,
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
    /// Resolved at spawn. Rows stored with a model and effort read as `high` (the hub migrates its own).
    #[serde(default)]
    pub profile: TaskProfile,
    /// A review task spawned with `--qa`.
    pub qa: Option<bool>,
    /// The PR a review task reviews. Required at spawn for review; absent on older rows (hub-spawned judges).
    pub pr: Option<PrUrl>,
    /// The plan item it was spawned for (`--item`).
    #[serde(default)]
    pub item_id: Option<crate::plan::PlanItemId>,
    /// The files the lead said a writer will change (`spawn_agent` `paths`), matched against later work.
    pub paths: Option<List<crate::work::WorkPath, 1, SPAWN_PATHS_MAX>>,
    pub state: TaskState,
    /// Why it is queued, e.g. "fleet cap: 40 of 40 running".
    pub queued_reason: Option<Text<1, 200>>,
    pub thread_ref: Option<ThreadRef>,
    /// The threads it ran in before `threadRef`, oldest first: fleetd restarted it fresh (its context filled up, or its
    /// thread could not resume), on the same branch and worktree.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_threads: Vec<ThreadRef>,
    /// `fleetd/<taskId>-<slug>`; write tasks only.
    pub branch: Option<NonEmpty>,
    /// Where its worktree's branch started, as the node reported at launch; write tasks only, absent before a launch
    /// or from an older node.
    #[serde(default)]
    pub base: Option<WorktreeBase>,
    pub worktree_path: Option<AbsolutePath>,
    /// M4: its thread hit a usage limit; the task is idle until fleetd sends "continue" at `resumeAt`.
    pub parked: Option<UsageParked>,
    /// 1 for the first launch.
    pub attempt: Positive,
    /// Set once a run of it died (its node stopped, claude was killed, a stall) and fleetd resumed it or will.
    #[serde(default)]
    pub recovery: Option<TaskRecovery>,
    pub result: Option<TaskResult>,
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
}

/// A task fleetd resumes on its own after its run died: in the same thread and worktree, with a note to continue.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecovery {
    /// Automatic recoveries used of `max`; a resumed run that died again before doing anything counts twice. A node
    /// going away never counts here.
    pub count: Count,
    pub max: Count,
    /// Resumes after its node went away (stopped, upgraded, crashed, powered off): not the task's doing, so outside
    /// `count`, with a high ceiling of its own only so a node that keeps dying can't loop it forever.
    #[serde(default)]
    pub node_lost: Count,
    /// How its last run ended.
    pub last_cause: RunEnd,
    /// The same, in plain words: "the node on devbox stopped", "claude was killed by signal 9".
    pub last_cause_text: Text<1, 200>,
    /// What tells one death from another (its cause, exit and last tool); the same one twice is not resumed again.
    /// Cleared when the lead continues the task itself.
    pub signature: Option<Text<1, 400>>,
    /// Deaths in a row with this signature, the latest one included.
    pub streak: Positive,
    /// When the resume goes out; absent once it has.
    pub next_at: Option<Timestamp>,
    /// When the last resume went out.
    pub resumed_at: Option<Timestamp>,
    /// How it goes on.
    #[serde(default)]
    pub mode: RecoveryMode,
}

/// How a recovering task goes on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryMode {
    /// In its thread (`claude --resume`), with a note to continue.
    #[default]
    Resume,
    /// Its context is full: `/compact` in its thread first, then the note.
    Compact,
    /// In a new thread on its branch and worktree, with its brief and a handoff from the last one.
    Fresh,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlotStatePerProject {
    pub project_ref: ProjectRef,
    /// The most of the project's agents (its tasks: writers, readers, reviewers) that run at once; its lead is not
    /// one. Its machine's `cap` until set.
    pub max_agents: Count,
    /// Its agents running now. Above `maxAgents` right after the cap was lowered: nothing is stopped for it.
    pub running: Count,
    /// Its agents waiting for a slot, paused ones included.
    pub queued: Count,
}

/// One machine's share of the board: what it fits, and what runs there.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlotStatePerMachine {
    pub machine_id: MachineId,
    /// The most agents that run on it at once: a person's setting for the machine, else `auto`.
    pub cap: Count,
    /// What the machine fits: one agent per CPU less a reserve, and 2 GB of memory each after the OS's share, at
    /// most 64.
    pub auto: Count,
    /// The term that sets `auto`, e.g. "memory 18 GB" or "14 of 16 CPUs".
    pub why: Text<1, 200>,
    /// Agents running there now.
    pub running: Count,
    /// New agents its free disk has room for now, above the guard's floor; absent while the node reports no disk.
    pub disk_room: Option<Count>,
}

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlotState {
    /// Agents running at once across every project: `fleetCap` when set, else the sum of the machines' caps.
    pub cap: Count,
    /// The fleet cap a person (or an older hub) saved; absent: none beyond the machines' own caps.
    pub fleet_cap: Option<Count>,
    pub used: Count,
    pub queued: Count,
    pub per_project: List<SlotStatePerProject, 0, 50>,
    #[serde(default)]
    pub per_machine: List<SlotStatePerMachine, 0, 50>,
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
    /// On `task.started` for a new worktree: where its branch started.
    pub base: Option<WorktreeBase>,
}

/// `project.fetch_failed` data: the start that found the remote unfetchable.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FetchFailedData {
    pub project_ref: ProjectRef,
    pub task_id: TaskId,
    pub base: WorktreeBase,
    /// The whole line, which the summary may cut: what failed, the fix, and where agents start from meanwhile.
    pub message: String,
    /// A command for a person to run, e.g. "gh auth login".
    pub fix: Option<String>,
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
    // An older file's `defaults` (model, effort) is ignored: the lead picks a TaskProfile per task.
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
        assert!(task_spawn_rule(TaskKind::Write, None, false).is_ok());
        assert!(task_spawn_rule(TaskKind::Review, Some(true), true).is_ok());
        assert!(task_spawn_rule(TaskKind::Review, None, false).is_err());
        assert!(task_spawn_rule(TaskKind::Write, Some(true), false).is_err());
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
            "profile": "medium",
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
        // Results stored with receipts still read, and drop them on the next write.
        let mut with_receipts = task.clone();
        with_receipts["result"]["receipts"] =
            json!({ "commands": 0, "commandsFailed": 0, "filesChanged": 1, "toolCalls": 2 });
        with_receipts["result"]["claimsUnverified"] = json!(true);
        let decoded: Task = serde_json::from_value(with_receipts).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), task);
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
        // An older file's areas and defaults are ignored, whatever they say.
        let decoded: PolicyFile = serde_json::from_value(
            json!({ "areas": { "docs": ["docs/**"] }, "defaults": { "effort": "medium-ish" } }),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), json!({}));
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
