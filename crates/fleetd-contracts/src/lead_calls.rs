//! Lead-side `fleetd` CLI calls. The CLI connects to the local node's unix socket, writes one `lead_call` frame as a
//! line of JSON, reads one `lead_result` line back, and closes. The node forwards the frame over its link to the hub
//! under a node-chosen id and relays the answer. The hub attributes the call to `lead:<projectRef>` by matching `cwd`
//! against project workspace roots and refuses calls from outside every workspace.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::checked;
use crate::effort::Effort;
use crate::ledger::{
    AskBlocks, AskId, AskKind, AskOptions, AskState, AskSteps, AskText, BriefDraft, BriefHash,
    CheckSpec, Decision, DecisionId, DecisionKey, DecisionValue, DecisionWhy, EnvName,
    GATED_MAX_TIMEOUT_SEC, GatedArgv, GatedClass, GatedCwd, GatedTimeoutSec, IntakeText,
    PlaybookName, PlaybookRef, SecretEnv, Serves, Tier, WorkstreamId, WorkstreamState,
    ask_blocks_nothing, ask_kind_rule,
};
use crate::mcp::McpToolError;
use crate::prim::{Count, Line, List, NonEmpty, NonNegative, Text};
use crate::secrets::SecretSink;
use crate::tasks::{
    AbsolutePath, PrUrl, Task, TaskAreas, TaskId, TaskKind, TaskPrompt, TaskState, TaskTitle,
    task_areas_rule, task_spawn_rule,
};
use crate::train::{Change, ChangeId, GitHubPrUrl};
use crate::verification::{Claim, ClaimId, ReviewVerdict};

/// Under the node user's home directory; mode 0600.
pub const NODE_SOCKET_PATH: &str = ".fleetd/node/node.sock";

/// `fleetd brief create --workstream W12 --json '<Brief>'`. Freezes the brief and moves a draft to running. `tier`
/// may be left out: the workstream's pinned playbook fills its `tierDefault`, and the hub refuses it when there is
/// none.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefCreateCall {
    pub workstream_id: WorkstreamId,
    pub brief: BriefDraft,
    /// `--amend`: the human-answered ask that approved changing an already frozen brief.
    pub amend: Option<AskId>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AskCallKind {
    #[default]
    Decide,
    Do,
    Secret,
}

impl From<AskCallKind> for AskKind {
    fn from(kind: AskCallKind) -> Self {
        match kind {
            AskCallKind::Decide => AskKind::Decide,
            AskCallKind::Do => AskKind::Do,
            AskCallKind::Secret => AskKind::Secret,
        }
    }
}

/// `fleetd ask [--kind decide|do|secret] --key k --class c --text t --rec r [--options a,b] [--steps '<json>']
/// [--verify '<CheckSpec>'] [--sink env:<machine>:<path> [--env-name N]] [--blocks "step"] [--proceeded]
/// [--workstream W12]`. Approve asks come only from `fleetd gated run`, so the command they run is stored with them.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct AskCall {
    #[serde(default)]
    pub kind: AskCallKind,
    pub key: DecisionKey,
    /// Any string: the hub refuses classes outside AskClass with the "decide this yourself" fix text.
    pub class: NonEmpty,
    pub text: AskText,
    pub recommendation: Option<DecisionValue>,
    pub options: Option<AskOptions>,
    pub steps: Option<AskSteps>,
    /// do only.
    pub verify: Option<CheckSpec>,
    /// Required for secret; the ask's key names the secret.
    pub sink: Option<SecretSink>,
    /// `--env-name`: an env: sink's variable, when the key's own name (`secret_env_name`) is not wanted or valid.
    pub env_name: Option<EnvName>,
    #[serde(default = "ask_blocks_nothing")]
    pub blocks: AskBlocks,
    #[serde(default)]
    pub proceeded_on_rec: bool,
    pub workstream_id: Option<WorkstreamId>,
}
checked!(AskCall, |call| ask_kind_rule(
    call.kind.into(),
    Some(call.class.as_str()),
    call.recommendation.is_some(),
    call.steps.as_ref().map(|steps| steps.len()),
    call.sink.as_deref(),
    call.env_name.is_some(),
    false,
    None,
    false,
    call.verify.is_some(),
));

fn gated_max_timeout() -> GatedTimeoutSec {
    GatedTimeoutSec::unchecked(GATED_MAX_TIMEOUT_SEC)
}

/// `fleetd gated run --class irreversible|money|credential --argv '<json array>' --reason r [--cwd /abs]
/// [--secret-env NAME=<secret key>]... [--timeout <sec>] [--workstream W12]`. Creates an approve ask storing exactly
/// this command; the project's node runs it after a human answers "go", and the result arrives in a wake.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedRunCall {
    pub argv: GatedArgv,
    pub cwd: Option<GatedCwd>,
    pub class: GatedClass,
    pub reason: AskText,
    pub secret_env: Option<SecretEnv>,
    #[serde(default = "gated_max_timeout")]
    pub timeout_sec: GatedTimeoutSec,
    pub workstream_id: Option<WorkstreamId>,
}

/// `fleetd ask withdraw A7 [--use D3]`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskWithdrawCall {
    pub ask_id: AskId,
    /// The existing decision that answers it.
    pub r#use: Option<DecisionId>,
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

/// `fleetd status set "<one line>" [--workstream W12]`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusSetCall {
    pub text: Line<1, 280>,
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

/// `fleetd task spawn --workstream W1 --title t --prompt p [--kind write|read|review] [--areas a,b] [--model m]
/// [--effort e] [--tier S|M|L] [--estimate <min>] [--serves s] [--pr <url>] [--qa]`. Absent model and effort resolve
/// from the policy file, then the project, then claude-opus-5-5/high. A write task needs `--serves`, a review task
/// `--pr`; `--qa` marks a review task as a QA run.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct TaskSpawnCall {
    pub workstream_id: WorkstreamId,
    pub title: TaskTitle,
    #[serde(default = "default_task_kind")]
    pub kind: TaskKind,
    pub prompt: TaskPrompt,
    #[serde(default)]
    pub areas: TaskAreas,
    pub model: Option<NonEmpty>,
    pub effort: Option<Effort>,
    pub tier: Option<Tier>,
    pub estimate_minutes: Option<NonNegative>,
    pub serves: Option<Serves>,
    pub pr: Option<PrUrl>,
    pub qa: Option<bool>,
}
checked!(TaskSpawnCall, |call| {
    task_areas_rule(call.kind, call.areas.len())?;
    task_spawn_rule(call.kind, call.serves.is_some(), call.qa, call.pr.is_some())
});

/// `fleetd task list [--state s] [--workstream W1]`, within the calling project.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskListCall {
    pub state: Option<TaskState>,
    pub workstream_id: Option<WorkstreamId>,
}

/// `fleetd task status T1`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusCall {
    pub task_id: TaskId,
}

/// `fleetd task message T1 "<text>"`. Continues the task's thread, which re-takes a slot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskMessageCall {
    pub task_id: TaskId,
    pub message: TaskPrompt,
}

/// `fleetd task cancel T1 [--reason r]`. Interrupts the thread and releases its slot and leases.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskCancelCall {
    pub task_id: TaskId,
    pub reason: Option<Text<1, 200>>,
}

/// `fleetd claim done --workstream W1`. Moves the workstream to verifying and runs its frozen done-when checks.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimDoneCall {
    pub workstream_id: WorkstreamId,
}

/// `fleetd change enqueue <PR URL> [--task T1] [--workstream W1] [--serves s] [--tier S|M|L]`. Absent fields come
/// from the task, then the workstream's brief; the tier may be raised above the brief's, never lowered.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEnqueueCall {
    pub task_id: Option<TaskId>,
    pub pr_url: GitHubPrUrl,
    pub workstream_id: Option<WorkstreamId>,
    pub serves: Option<Serves>,
    pub tier: Option<Tier>,
}

/// `fleetd change status X1`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeStatusCall {
    pub change_id: ChangeId,
}

/// `fleetd workstream spawn --text "<intent>" --serves issue:<#n|url>|defect:<text>|done:<n> [--template t]`: a
/// finish-all lead starts a child workstream in its own project, for one item with a value source.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkstreamSpawnCall {
    pub text: IntakeText,
    pub serves: Serves,
    pub template: Option<PlaybookName>,
}

/// `fleetd inventory`: the project's open work, ranked, as plain text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InventoryCall {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum LeadCall {
    BriefCreate(BriefCreateCall),
    Ask(AskCall),
    AskWithdraw(AskWithdrawCall),
    Decide(DecideCall),
    StatusSet(StatusSetCall),
    DecisionsSearch(DecisionsSearchCall),
    TaskSpawn(TaskSpawnCall),
    TaskList(TaskListCall),
    TaskStatus(TaskStatusCall),
    TaskMessage(TaskMessageCall),
    TaskCancel(TaskCancelCall),
    ClaimDone(ClaimDoneCall),
    /// `fleetd review verdict --task T4 --sha <head> --blocking 0 --non-blocking 2 --summary s`, the last step of a
    /// review task.
    ReviewVerdict(ReviewVerdict),
    ChangeEnqueue(ChangeEnqueueCall),
    ChangeStatus(ChangeStatusCall),
    GatedRun(GatedRunCall),
    WorkstreamSpawn(WorkstreamSpawnCall),
    Inventory(InventoryCall),
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefCreateResult {
    pub workstream_id: WorkstreamId,
    pub brief_hash: BriefHash,
    pub state: WorkstreamState,
    /// Hint for the lead's next step; the CLI prints it after the result.
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskResult {
    /// "auto": answered from the log, see `decision`. "open": a new ask, or an existing one with the same key
    /// (`attached`).
    pub state: AskState,
    pub ask_id: AskId,
    pub decision: Option<Decision>,
    pub attached: Option<bool>,
    /// Decisions that may already answer it; withdraw with `--use` if one does.
    pub candidates: Option<List<Decision, 0, 5>>,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskWithdrawResult {
    pub ask_id: AskId,
    pub state: AskState,
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
#[serde(rename_all = "camelCase")]
pub struct StatusSetResult {
    pub workstream_id: WorkstreamId,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DecisionsSearchResult {
    pub decisions: List<Decision, 0, 20>,
    pub next: Option<String>,
}

/// The task as stored: queued with `queued_reason`, or running. Also the answer to task status, message and cancel.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TaskResultFrame {
    pub task: Task,
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

/// `claim` is present when every check finished within the call; otherwise the outcome arrives in a wake.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimDoneResult {
    pub claim_id: ClaimId,
    pub workstream_id: WorkstreamId,
    pub state: WorkstreamState,
    pub claim: Option<Claim>,
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

/// The approve ask, open until a human answers it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedRunResult {
    pub ask_id: AskId,
    pub state: AskState,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamSpawnResult {
    pub workstream_id: WorkstreamId,
    pub parent: WorkstreamId,
    pub playbook: Option<PlaybookRef>,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InventoryResult {
    /// The ranked list, one item per line.
    pub text: String,
    /// Items with a value source that no open child serves yet.
    pub spawnable: Count,
    /// The project's finish-all workstream went (or stayed) idle: nothing left with a value source.
    pub idle: bool,
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum LeadCallResult {
    BriefCreate(BriefCreateResult),
    Ask(AskResult),
    AskWithdraw(AskWithdrawResult),
    Decide(DecideResult),
    StatusSet(StatusSetResult),
    DecisionsSearch(DecisionsSearchResult),
    TaskSpawn(TaskResultFrame),
    TaskList(TaskListResult),
    TaskStatus(TaskResultFrame),
    TaskMessage(TaskResultFrame),
    TaskCancel(TaskResultFrame),
    ClaimDone(ClaimDoneResult),
    ReviewVerdict(ReviewVerdictResult),
    ChangeEnqueue(ChangeResult),
    ChangeStatus(ChangeResult),
    GatedRun(GatedRunResult),
    WorkstreamSpawn(WorkstreamSpawnResult),
    Inventory(InventoryResult),
}

/// CLI -> node on the local socket, and node -> hub on the link.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LeadCallFrame {
    pub id: NonEmpty,
    /// The caller's absolute working directory.
    pub cwd: AbsolutePath,
    pub call: LeadCall,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(json: serde_json::Value) -> Result<LeadCall, serde_json::Error> {
        serde_json::from_value(json)
    }

    #[test]
    fn ask_call_applies_decode_defaults() {
        let LeadCall::Ask(ask) =
            call(serde_json::json!({ "op": "ask", "key": "api.path", "class": "product", "text": "Which path?", "recommendation": "/health" })).unwrap()
        else {
            panic!("not an ask");
        };
        assert_eq!(ask.kind, AskCallKind::Decide);
        assert_eq!(ask.blocks.as_str(), "nothing");
        assert!(!ask.proceeded_on_rec);
    }

    #[test]
    fn ask_call_runs_the_kind_rule() {
        let base = serde_json::json!({ "op": "ask", "key": "stripe.test_key", "class": "credential", "text": "Need the key", "kind": "secret" });
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
                serde_json::json!({ "sink": "env:forge:/srv/app/.env", "envName": "STRIPE_KEY" })
            ))
            .is_ok()
        );
        assert!(
            call(with(
                serde_json::json!({ "sink": "file:forge:/srv/app/key", "envName": "STRIPE_KEY" })
            ))
            .is_err()
        );
        assert!(call(base.clone()).is_err(), "a secret ask needs a sink");
    }

    #[test]
    fn task_spawn_defaults_to_write_and_runs_its_rules() {
        let spawn = serde_json::json!({ "op": "task_spawn", "workstreamId": "W1", "title": "t", "prompt": "p", "areas": ["docs"], "serves": "done:0" });
        let LeadCall::TaskSpawn(task) = call(spawn.clone()).unwrap() else {
            panic!("not a spawn")
        };
        assert_eq!(task.kind, TaskKind::Write);
        let mut no_areas = spawn.clone();
        no_areas.as_object_mut().unwrap().remove("areas");
        assert!(call(no_areas).is_err(), "a write task needs an area");
        let mut qa = spawn;
        qa["qa"] = true.into();
        assert!(call(qa).is_err(), "--qa applies only to review");
    }

    #[test]
    fn gated_run_defaults_to_thirty_minutes_and_refuses_longer() {
        let gated = serde_json::json!({ "op": "gated_run", "argv": ["echo", "hi"], "class": "irreversible", "reason": "deploy" });
        let LeadCall::GatedRun(run) = call(gated.clone()).unwrap() else {
            panic!("not a gated run")
        };
        assert_eq!(run.timeout_sec.get(), 1800);
        let mut longer = gated;
        longer["timeoutSec"] = 1801.into();
        assert!(call(longer).is_err());
    }

    #[test]
    fn result_frame_carries_exactly_one_of_result_and_error() {
        let error = serde_json::json!({ "t": "lead_result", "id": "1", "error": { "code": "invalid", "message": "no" } });
        assert!(serde_json::from_value::<LeadSocketFrame>(error.clone()).is_ok());
        let mut both = error;
        both["result"] =
            serde_json::json!({ "op": "inventory", "text": "", "spawnable": 0, "idle": true });
        assert!(serde_json::from_value::<LeadSocketFrame>(both).is_err());
    }
}
