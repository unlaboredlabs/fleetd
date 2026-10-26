//! Lead-side `fleetd` CLI calls. The CLI connects to the local node's unix socket, writes one `lead_call` frame as a
//! line of JSON, reads one `lead_result` line back, and closes. The node forwards the frame over its link to the hub
//! under a node-chosen id and relays the answer. The hub attributes the call to `lead:<projectRef>` by matching `cwd`
//! against project workspace roots and refuses calls from outside every workspace.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::automations::{
    AutomationCreateCall, AutomationDeleteCall, AutomationDeleteResult, AutomationListCall,
    AutomationListResult, AutomationPauseCall, AutomationResult, AutomationRunCall,
    AutomationRunResult, AutomationRunsCall, AutomationRunsResult, AutomationUpdateCall,
};
use crate::browser::{
    BrowserCallFrame, BrowserRecordingPartCall, BrowserRecordingPartResult, BrowserResultFrame,
    BrowserSessionCall, BrowserSessionResult,
};
use crate::chat::ChatRequestId;
use crate::checked;
use crate::checklist::{ChecklistCall, ChecklistResult};
use crate::effort::TaskProfile;
use crate::ids::{MachineId, ThreadId};
use crate::ledger::{
    Brief, Decision, DecisionKey, DecisionValue, DecisionWhy, EnvName, GATED_DEFAULT_TIMEOUT_SEC,
    GatedArgv, GatedClass, GatedCwd, GatedTimeoutSec, IntakeText, RequestState, SecretEnv,
    WorkstreamId, WorkstreamState,
};
use crate::mcp::McpToolError;
use crate::memory::{MemoryReadCall, MemoryReadResult, RememberCall, RememberResult};
use crate::prim::{Count, Line, List, NonEmpty, Text};
use crate::secrets::SecretSink;
use crate::skills::{SkillInstallCall, SkillInstallResult};
use crate::steer::SteerId;
use crate::tasks::{
    AbsolutePath, PrUrl, SPAWN_PATHS_MAX, Task, TaskId, TaskKind, TaskPrompt, TaskState, TaskTitle,
    task_spawn_rule,
};
use crate::train::{Change, GitHubPrUrl};
use crate::verification::ReviewVerdict;
use crate::work::WorkPath;

/// Under the node user's home directory; mode 0600.
pub const NODE_SOCKET_PATH: &str = ".fleetd/node/node.sock";

/// `fleetd brief create (--workstream W12 | --text "<intent>") --json '<Brief>'`. Without a workstream it
/// opens one for the work the lead took from the chat; then it sets or edits the brief, and a draft moves to running.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct BriefCreateCall {
    pub workstream_id: Option<WorkstreamId>,
    /// The order in the human's words, when this opens the workstream.
    pub text: Option<IntakeText>,
    pub brief: Brief,
}
checked!(BriefCreateCall, |call| {
    match (&call.workstream_id, &call.text) {
        (None, None) => {
            Err("give workstreamId to brief an open workstream, or text to open one".into())
        }
        (Some(_), Some(_)) => Err("text opens a workstream; leave it out with workstreamId".into()),
        _ => Ok(()),
    }
});

/// `request_secret`: the human enters a secret in a masked field in the app; it is sealed to the sink's machine and
/// written there (0600). The lead only ever sees its fingerprint, in a later wake.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct RequestSecretCall {
    /// The secret's name, a dotted slug such as "stripe.test_key".
    pub key: DecisionKey,
    /// Where the value is written: env:<machine>:<file> (one NAME=value line), file:<machine>:<path>, or
    /// order:<machine>:<order id> (one variable of that order's agents on the project's machine, until it closes).
    pub sink: SecretSink,
    /// One line on why it is needed.
    pub text: Text<1, 500>,
    /// An env: or order: sink's variable, when not the one the key names.
    pub env_name: Option<EnvName>,
    pub workstream_id: Option<WorkstreamId>,
}
checked!(RequestSecretCall, |call| {
    if call.env_name.is_some() && !call.sink.starts_with("env:") && !call.sink.starts_with("order:")
    {
        return Err("only an env: or order: sink has an env name".into());
    }
    Ok(())
});

fn gated_default_timeout() -> GatedTimeoutSec {
    GatedTimeoutSec::unchecked(GATED_DEFAULT_TIMEOUT_SEC)
}

/// `request_withdraw`: the lead takes back a secret request it no longer needs (the human said so in chat), or a
/// command approval nobody answered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestWithdrawCall {
    pub request_id: ChatRequestId,
}

/// `gated_run`: a request storing exactly this command, shown in chat with Approve / Deny; the project's node runs it
/// once a human approves, and the result arrives in a wake.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedRunCall {
    pub argv: GatedArgv,
    pub cwd: Option<GatedCwd>,
    pub class: GatedClass,
    pub reason: Text<1, 500>,
    pub secret_env: Option<SecretEnv>,
    #[serde(default = "gated_default_timeout")]
    pub timeout_sec: GatedTimeoutSec,
    pub workstream_id: Option<WorkstreamId>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecideScope {
    Project,
    #[default]
    Workstream,
}

/// `fleetd decide --key k --value v [--why w] [--scope project|workstream] [--workstream W12]`. Writes source "lead".
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecideCall {
    pub key: DecisionKey,
    pub value: DecisionValue,
    pub why: Option<DecisionWhy>,
    #[serde(default)]
    pub scope: DecideScope,
    pub workstream_id: Option<WorkstreamId>,
}

/// `fleetd decisions search "<q>"`, within the calling project's scope chain.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DecisionsSearchCall {
    pub query: Text<1, 200>,
}

fn default_task_kind() -> TaskKind {
    TaskKind::Write
}

/// `fleetd task spawn --workstream W1 --title t --prompt p [--kind write|read|review]
/// [--profile high|medium] [--pr <url>] [--qa]`. The profile defaults to high; a review task, and
/// every task of a project with medium off, runs high whatever it says. A review task needs `--pr`; `--qa` marks a
/// review task as a QA run.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct TaskSpawnCall {
    pub workstream_id: WorkstreamId,
    pub title: TaskTitle,
    #[serde(default = "default_task_kind")]
    pub kind: TaskKind,
    pub prompt: TaskPrompt,
    pub profile: Option<TaskProfile>,
    pub pr: Option<PrUrl>,
    pub qa: Option<bool>,
    /// The files a writer will change, repo-relative (`app/theme.ts`, `app/settings/**`): matched against the work
    /// in flight.
    pub paths: Option<List<WorkPath, 1, SPAWN_PATHS_MAX>>,
    /// A writer refused as a possible duplicate: the ids it was refused for (`T12`, `C7`), when this is different
    /// work. Needs `notDuplicateWhy`.
    pub not_duplicate_of: Option<List<Line<1, 300>, 1, NOT_DUPLICATE_MAX>>,
    /// Why it is different work, in one line; kept in the hub's log.
    pub not_duplicate_why: Option<Line<1, 200>>,
}
checked!(TaskSpawnCall, |call| {
    task_spawn_rule(call.kind, call.qa, call.pr.is_some())?;
    if call.not_duplicate_of.is_some() && call.not_duplicate_why.is_none() {
        return Err(
            "notDuplicateOf needs notDuplicateWhy: one line on why it is different work".into(),
        );
    }
    Ok(())
});

pub const NOT_DUPLICATE_MAX: usize = 10;

/// `fleetd task list [--task T1] [--state s] [--workstream W1]`, within the calling project.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskListCall {
    /// Just this task.
    pub task_id: Option<TaskId>,
    pub state: Option<TaskState>,
    pub workstream_id: Option<WorkstreamId>,
}

/// `fleetd task message T1 "<text>" [--now]`. A steer from the lead: a running task takes it in at its next tool
/// boundary (`--now`: stops its current step), a queued one gets it with its prompt, and an ended one continues in
/// its thread, which re-takes a slot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskMessageCall {
    pub task_id: TaskId,
    pub message: TaskPrompt,
    #[serde(default)]
    pub now: bool,
}

/// `fleetd task cancel T1 [--reason r]`. Interrupts the thread and releases its slot.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskCancelCall {
    pub task_id: TaskId,
    pub reason: Option<Text<1, 200>>,
}

/// `close`: the lead says a workstream is done, and why. fleetd records it and stops nothing: what still runs keeps
/// running until the lead stops it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloseCall {
    pub workstream_id: WorkstreamId,
    /// One line on why it is done, as the human would read it.
    pub why: Text<1, 500>,
}

/// `fleetd change enqueue <PR URL> [--task T1] [--workstream W1]`. The workstream defaults to the task's.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEnqueueCall {
    pub task_id: Option<TaskId>,
    pub pr_url: GitHubPrUrl,
    pub workstream_id: Option<WorkstreamId>,
}

/// A worker's question for its lead (the `ask_lead` MCP tool). The lead is woken with it and answers with
/// `message_agent`, which reaches the worker as a steer; the worker carries on meanwhile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AskLeadCall {
    pub question: Text<1, 4000>,
}

/// `usage_resume` for a lead: lifts the usage pause on the machine its project runs on (the only one it may name) and
/// sends every thread parked there "continue". At most once per 10 minutes per machine; recorded as the lead's.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageResumeCall {
    /// The project's machine; absent means it.
    pub machine_id: Option<MachineId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum LeadCall {
    BriefCreate(BriefCreateCall),
    RequestSecret(RequestSecretCall),
    RequestWithdraw(RequestWithdrawCall),
    Decide(DecideCall),
    DecisionsSearch(DecisionsSearchCall),
    TaskSpawn(TaskSpawnCall),
    TaskList(TaskListCall),
    TaskMessage(TaskMessageCall),
    TaskCancel(TaskCancelCall),
    Close(CloseCall),
    /// `fleetd review verdict --task T4 --sha <head> --blocking 0 --non-blocking 2 --summary s`, the last step of a
    /// review task.
    ReviewVerdict(ReviewVerdict),
    ChangeEnqueue(ChangeEnqueueCall),
    GatedRun(GatedRunCall),
    AskLead(AskLeadCall),
    Remember(RememberCall),
    MemoryRead(MemoryReadCall),
    AutomationCreate(AutomationCreateCall),
    AutomationList(AutomationListCall),
    AutomationUpdate(AutomationUpdateCall),
    AutomationPause(AutomationPauseCall),
    AutomationDelete(AutomationDeleteCall),
    AutomationRun(AutomationRunCall),
    AutomationRuns(AutomationRunsCall),
    Checklist(ChecklistCall),
    SkillInstall(SkillInstallCall),
    UsageResume(UsageResumeCall),
    /// Made by the node for a session's browser, never by the session itself (the node refuses that).
    BrowserSession(BrowserSessionCall),
    BrowserRecordingPart(BrowserRecordingPartCall),
}

/// The call's `op` tag, as on the wire.
pub fn op_name(call: &LeadCall) -> String {
    serde_json::to_value(call)
        .ok()
        .and_then(|v| v.get("op")?.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefCreateResult {
    pub workstream_id: WorkstreamId,
    pub state: WorkstreamState,
    /// Hint for the lead's next step; the CLI prints it after the result.
    pub next: Option<String>,
}

/// A secret or approval request, open until a human answers it in chat.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestResult {
    pub request_id: ChatRequestId,
    pub state: RequestState,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DecideResult {
    pub decision: Decision,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DecisionsSearchResult {
    pub decisions: List<Decision, 0, 20>,
    pub next: Option<String>,
}

/// The task as stored: queued with `queued_reason`, or running. Also the answer to task spawn, message and cancel.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TaskResultFrame {
    pub task: Task,
    /// Task message: the steer it was sent as.
    pub steer_id: Option<SteerId>,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TaskListResult {
    /// Newest first.
    pub tasks: List<Task, 0, 50>,
    pub truncated: Option<bool>,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloseResult {
    pub workstream_id: WorkstreamId,
    pub state: WorkstreamState,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReviewVerdictResult {
    pub verdict: ReviewVerdict,
    pub next: Option<String>,
}

/// The answer to change enqueue and change status.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChangeResult {
    pub change: Change,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskLeadResult {
    pub task_id: TaskId,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageResumeResult {
    pub machine_id: MachineId,
    /// Parked threads sent "continue".
    pub resumed: Count,
    /// The pause was lifted.
    pub breaker_cleared: bool,
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum LeadCallResult {
    BriefCreate(BriefCreateResult),
    RequestSecret(RequestResult),
    RequestWithdraw(RequestResult),
    Decide(DecideResult),
    DecisionsSearch(DecisionsSearchResult),
    TaskSpawn(TaskResultFrame),
    TaskList(TaskListResult),
    TaskMessage(TaskResultFrame),
    TaskCancel(TaskResultFrame),
    Close(CloseResult),
    ReviewVerdict(ReviewVerdictResult),
    ChangeEnqueue(ChangeResult),
    GatedRun(RequestResult),
    AskLead(AskLeadResult),
    Remember(RememberResult),
    MemoryRead(MemoryReadResult),
    AutomationCreate(AutomationResult),
    AutomationList(AutomationListResult),
    AutomationUpdate(AutomationResult),
    AutomationPause(AutomationResult),
    AutomationDelete(AutomationDeleteResult),
    AutomationRun(AutomationRunResult),
    AutomationRuns(AutomationRunsResult),
    Checklist(ChecklistResult),
    SkillInstall(SkillInstallResult),
    UsageResume(UsageResumeResult),
    BrowserSession(BrowserSessionResult),
    BrowserRecordingPart(BrowserRecordingPartResult),
}

/// CLI -> node on the local socket, and node -> hub on the link.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LeadCallFrame {
    pub id: NonEmpty,
    /// The caller's absolute working directory.
    pub cwd: AbsolutePath,
    pub call: LeadCall,
    /// The fleetd session the call comes from (`FLEETD_THREAD_ID`, which the node sets in every session and its MCP
    /// server). The hub tells a lead from a task by it; absent from a person's own shell.
    pub thread_id: Option<ThreadId>,
}

/// Node -> CLI on the local socket, and hub -> node on the link. Exactly one of `result` and `error`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self")]
pub struct LeadResultFrame {
    pub id: NonEmpty,
    pub result: Option<LeadCallResult>,
    pub error: Option<McpToolError>,
}
checked!(LeadResultFrame, |frame| {
    if frame.result.is_none() == frame.error.is_none() {
        return Err("exactly one of result and error".into());
    }
    Ok(())
});

/// A line on the node's local socket, with its `t`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum LeadSocketFrame {
    LeadCall(LeadCallFrame),
    LeadResult(LeadResultFrame),
    /// `fleetd browser-mcp` to its node, which answers it itself: the session's browser lives there.
    BrowserCall(BrowserCallFrame),
    BrowserResult(BrowserResultFrame),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(json: serde_json::Value) -> Result<LeadCall, serde_json::Error> {
        serde_json::from_value(json)
    }

    #[test]
    fn a_secret_request_names_a_sink_and_only_an_env_sink_has_an_env_name() {
        let base = serde_json::json!({ "op": "request_secret", "key": "stripe.test_key", "text": "Need the key" });
        let with = |extra: serde_json::Value| {
            let mut value = base.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            value
        };
        assert!(
            call(with(
                serde_json::json!({ "sink": "env:devbox:/srv/app/.env", "envName": "STRIPE_KEY" })
            ))
            .is_ok()
        );
        assert!(
            call(with(
                serde_json::json!({ "sink": "file:devbox:/srv/app/key", "envName": "STRIPE_KEY" })
            ))
            .is_err()
        );
        assert!(call(base.clone()).is_err(), "a secret request needs a sink");
        assert!(
            call(serde_json::json!({ "op": "ask", "key": "a.b", "class": "product", "text": "?" }))
                .is_err(),
            "there is no ask call"
        );
    }

    #[test]
    fn task_spawn_defaults_to_write_and_runs_its_rules() {
        let spawn = serde_json::json!({ "op": "task_spawn", "workstreamId": "W1", "title": "t", "prompt": "p" });
        let LeadCall::TaskSpawn(task) = call(spawn.clone()).unwrap() else {
            panic!("not a spawn")
        };
        assert_eq!(task.kind, TaskKind::Write);
        let mut qa = spawn;
        qa["qa"] = true.into();
        assert!(call(qa).is_err(), "--qa applies only to review");
    }

    #[test]
    fn gated_run_defaults_to_thirty_minutes_and_refuses_past_four_hours() {
        let gated = serde_json::json!({ "op": "gated_run", "argv": ["echo", "hi"], "class": "irreversible", "reason": "deploy" });
        let LeadCall::GatedRun(run) = call(gated.clone()).unwrap() else {
            panic!("not a gated run")
        };
        assert_eq!(run.timeout_sec.get(), 1800);
        let mut four_hours = gated.clone();
        four_hours["timeoutSec"] = 14_400.into();
        let LeadCall::GatedRun(run) = call(four_hours).unwrap() else {
            panic!("not a gated run")
        };
        assert_eq!(run.timeout_sec.get(), 14_400);
        let mut longer = gated;
        longer["timeoutSec"] = 14_401.into();
        assert!(call(longer).is_err());
        // The node takes the same four hours from the hub.
        let run = |timeout: i64| {
            serde_json::from_value::<crate::node_link::GatedRun>(serde_json::json!({
                "id": "g1", "argv": ["./deploy.sh"], "cwd": "/work/app", "timeoutSec": timeout,
            }))
        };
        assert!(run(14_400).is_ok());
        assert!(run(14_401).is_err());
    }

    #[test]
    fn result_frame_carries_exactly_one_of_result_and_error() {
        let error = serde_json::json!({ "t": "lead_result", "id": "1", "error": { "code": "invalid", "message": "no" } });
        assert!(serde_json::from_value::<LeadSocketFrame>(error.clone()).is_ok());
        let mut both = error;
        both["result"] = serde_json::json!({ "op": "status_set", "workstreamId": "W1" });
        assert!(serde_json::from_value::<LeadSocketFrame>(both).is_err());
    }
}
