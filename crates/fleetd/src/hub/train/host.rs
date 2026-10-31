//! What the train and the review gate take from other hub areas: tasks, workstreams, decisions, the event log and
//! wakes. One port, so the logic tests run on a fake
//! and the hub provides it from its services (`HubHost`).
use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use super::contract::{ProjectRef, TaskId, WorkstreamId};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The parts of a Task the train and reviews read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskView {
    pub task_id: TaskId,
    pub project_ref: ProjectRef,
    pub workstream_id: WorkstreamId,
    /// "write", "review", ...
    pub kind: String,
    /// "done", "failed", "running", ...
    pub state: String,
    /// `result.prUrl`.
    pub pr_url: Option<String>,
    /// `result.tail`.
    pub result_tail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkstreamView {
    pub workstream_id: WorkstreamId,
    pub project_ref: ProjectRef,
    pub has_brief: bool,
    /// Neither done nor stopped: tasks, reviewers included, run only for an open workstream.
    pub open: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventView {
    pub seq: i64,
    pub event_type: String,
    pub data: Value,
}

/// A review task as Tasks.spawn takes it (kind "review", so the default profile), from the caller `by` in `project_ref`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewSpawn {
    pub project_ref: ProjectRef,
    pub by: &'static str,
    pub workstream_id: WorkstreamId,
    pub title: String,
    pub prompt: String,
    pub pr: String,
}

/// How a command the train ran on a node ended: its exit code (None when it timed out or could not run) and the tail
/// of its output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeRun {
    pub exit_code: Option<i64>,
    pub output_tail: String,
}

pub trait TrainHost: Send + Sync + 'static {
    fn task(&self, task_id: &TaskId) -> Option<TaskView>;
    /// The project's write tasks that are running or done, with their branches, whose ready PRs the train takes as
    /// slices.
    fn writers(&self, project_ref: &ProjectRef) -> Vec<(TaskId, String)>;
    /// Tasks.message from `by`; the error is its message.
    fn message_task<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        by: &'static str,
        task_id: &'a TaskId,
        text: String,
    ) -> BoxFut<'a, Result<(), String>>;
    /// Tasks.cancel from `by`, with `reason` as its result; the error is its message.
    fn cancel_task<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        by: &'static str,
        task_id: &'a TaskId,
        reason: String,
    ) -> BoxFut<'a, Result<(), String>>;
    /// Tasks.spawn of a review task; the error is its message.
    fn spawn_review(&self, spawn: ReviewSpawn) -> BoxFut<'_, Result<TaskView, String>>;
    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<WorkstreamView>;
    /// EventLog.append at now, on the project.
    fn append_event(
        &self,
        project_ref: &ProjectRef,
        event_type: &'static str,
        summary: String,
        data: Value,
    );
    fn events_head(&self) -> i64;
    /// EventLog.wait: the events after `cursor` of these types, and the new cursor.
    fn events_wait<'a>(
        &'a self,
        cursor: i64,
        types: &'a [&'static str],
        timeout_sec: u64,
    ) -> BoxFut<'a, (Vec<EventView>, i64)>;
    /// The project's checkout (`workspaceRoot`) on its machine; None once the project is removed.
    fn project_root(&self, project_ref: &ProjectRef) -> Option<String>;
    /// The project's repos on GitHub, each as `owner/name` lowercased, with the node checkout holding its files; empty
    /// while the hub knows none with a GitHub remote (a plain directory, or a repo whose remote isn't read yet). A
    /// project with two or more takes PRs only from them; any other takes a PR from any repo, as before.
    fn github_repos(&self, _project_ref: &ProjectRef) -> Vec<(String, ProjectRef)> {
        Vec::new()
    }
    /// Runs `argv` (never through a shell) in `cwd` on the machine of `checkout`, the repo's checkout, for at most
    /// `timeout_sec`: only on a linked node whose role takes agents, as agent and review work runs, never on the hub's
    /// own machine for that. The error says why it can't run there now.
    fn node_run<'a>(
        &'a self,
        _checkout: &'a ProjectRef,
        _cwd: &'a str,
        _argv: Vec<String>,
        _timeout_sec: u32,
    ) -> BoxFut<'a, Result<NodeRun, String>> {
        Box::pin(async { Err("this hub runs nothing on its nodes for the train".to_string()) })
    }
    /// LeadWakes.trigger(ref, { kind: "train", line }).
    fn wake_lead<'a>(&'a self, project_ref: &'a ProjectRef, line: String) -> BoxFut<'a, ()>;
    /// The project's branch prefix (its policy's `branchPrefix`, default `fleetd/`); None when the policy can't be
    /// read now. The train's scratch batch branches live under
    /// `<prefix>train/`, so fleets sharing one repo never collide.
    fn branch_prefix<'a>(&'a self, _project_ref: &'a ProjectRef) -> BoxFut<'a, Option<String>> {
        Box::pin(async { Some(fleetd_contracts::tasks::DEFAULT_BRANCH_PREFIX.to_string()) })
    }
    /// Opens an order for the project's lead (the ledger's intake, channel `train`) with `text`; the same `request_id`
    /// finds the order the first call opened. The order's id, or why it couldn't be opened.
    fn open_order<'a>(
        &'a self,
        _project_ref: &'a ProjectRef,
        _text: String,
        _request_id: String,
    ) -> BoxFut<'a, Result<WorkstreamId, String>> {
        Box::pin(async { Err("this hub opens no orders".to_string()) })
    }
    /// Whether the work ledger's landing scanner watches `repo`'s `base`: it then tells the leads about each merge
    /// there that didn't go through the train, so the train doesn't.
    fn landings_watched(&self, _repo: &str, _base: &str) -> bool {
        false
    }
    /// Where the train's state and CI spans go; none in tests.
    fn time(&self) -> Option<crate::hub::time::TimeSink> {
        None
    }
}
