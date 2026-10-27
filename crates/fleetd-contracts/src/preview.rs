//! Try it yourself (W58, docs/design/try-it.md, D162): a preview is a PR's or an order's branch running on a machine
//! for the person to use, from the app (a browser session they hold) or from their own devices on the tailnet. It runs
//! only because someone asked: the person with Try it, or the lead in a turn answering the person. An agent may only
//! suggest one. It ends on End, after the project's idle time, at the 4 hour cap, or when the PR merges or closes.
//!
//! The wire, in three parts:
//! - the project's `preview` setting ([`PreviewConfig`], in project_settings_get/set);
//! - the hub and the app: the `preview_*` tools in mcp.rs and the `preview.state` event ([`PreviewEventData`]);
//! - agents and the hub, as lead calls: [`PreviewSuggestCall`], [`PreviewConfigProposeCall`] and the lead's
//!   [`PreviewStartCall`];
//! - the hub and the node: [`PreviewRunFrame`] and [`PreviewStopFrame`] to a node that lists
//!   [`crate::node_link::CAP_PREVIEWS`], answered by [`PreviewRunResult`], and [`PreviewReport`] from the node as the
//!   run moves on.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::browser::BrowserSessionId;
use crate::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::mcp::McpToolError;
use crate::prim::{Count, Int, Line, List, NonEmpty, Positive, Text, UniqueList};
use crate::project_settings::{SETUP_INPUTS_MAX, SetupCommand, SetupInput};
use crate::train::GitHubRepo;
use crate::{brand, checked};

/// A project's idle time when it sets none: a preview no one used for this long ends (D162).
pub const PREVIEW_IDLE_DEFAULT_MIN: i64 = 30;
/// The longest any preview runs, used or not (D162).
pub const PREVIEW_CAP_MIN: i64 = 240;
/// Setup commands a preview may run before its build.
pub const PREVIEW_SETUP_MAX: usize = 20;

brand!(
    /// "P" plus 32 hex digits, minted by the hub when a preview is asked for.
    PreviewId, name = "PreviewId", pattern = r"^P[0-9a-f]{32}$"
);

brand!(
    /// The path the node asks until the started app answers it (2xx or 3xx): `/`, `/healthz`.
    ReadyPath,
    name = "ReadyPath",
    check = |s| s.starts_with('/') && s.len() <= 300 && !s.chars().any(char::is_whitespace),
    expected = "a path starting with /, at most 300 characters, no spaces"
);

/// What a preview runs: phase 1 is the web; Android, iOS and the desktop follow (docs/design/try-it.md, Phases).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum PreviewTarget {
    #[default]
    Web,
}

impl PreviewTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
        }
    }
}

/// How a project's web app is built and run for a preview, each command with `sh -c` in the preview's worktree and
/// the project's variables, as setup commands run (#501).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebPreview {
    /// Run first, in order: install dependencies, generate code. Skipped when `inputs` haven't changed since a
    /// preview of this project last ran them on this machine.
    #[serde(default)]
    pub setup: List<SetupCommand, 0, PREVIEW_SETUP_MAX>,
    /// Builds the app; none for an app the start command builds itself.
    pub build: Option<SetupCommand>,
    /// Serves the app on `127.0.0.1:$PORT`; it runs until the preview ends.
    pub start: SetupCommand,
    /// Asked until it answers, for at most 2 minutes after the start.
    #[serde(default = "ready_default")]
    pub ready: ReadyPath,
    /// Files whose contents decide what setup makes, such as lockfiles.
    #[serde(default)]
    pub inputs: UniqueList<SetupInput, 0, SETUP_INPUTS_MAX>,
}

fn ready_default() -> ReadyPath {
    ReadyPath::new("/").expect("/ is a ready path")
}

/// A project's preview setting (Settings › Projects › Try it, or `project_settings_set {preview}`). Nothing runs
/// because of it: it says how to run a preview someone asks for.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConfig {
    pub web: Option<WebPreview>,
    /// A preview no one used for this many minutes ends.
    #[serde(default = "idle_default")]
    pub idle_minutes: Int<5, PREVIEW_CAP_MIN>,
}

fn idle_default() -> Int<5, PREVIEW_CAP_MIN> {
    Int::unchecked(PREVIEW_IDLE_DEFAULT_MIN)
}

impl PreviewConfig {
    /// The targets it says how to run.
    pub fn targets(&self) -> Vec<PreviewTarget> {
        self.web.iter().map(|_| PreviewTarget::Web).collect()
    }
}

/// What a preview is of: one PR, or an order's PRs merged together onto their base on a scratch branch (D162).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewOf {
    #[serde(rename_all = "camelCase")]
    Pr { repo: GitHubRepo, number: Positive },
    #[serde(rename_all = "camelCase")]
    Order { workstream_id: WorkstreamId },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum PreviewState {
    /// Checking out, setting up, building or starting: `steps` says which.
    Starting,
    /// It answers: the person can use it.
    Ready,
    /// Thrown away: its processes, port and worktree are gone. `endReason` says why.
    Ended,
    /// A step failed: `steps` names it with the end of its output. Nothing of it runs.
    Failed,
}

impl PreviewState {
    pub fn is_over(self) -> bool {
        matches!(self, Self::Ended | Self::Failed)
    }
}

/// Why a preview ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum PreviewEndReason {
    /// Someone pressed End (preview_end).
    Ended,
    /// No one used it for the project's idle time.
    Idle,
    /// It ran for [`PREVIEW_CAP_MIN`].
    Cap,
    /// Its PR merged or closed, or its order closed.
    Done,
    /// Its machine's node restarted or went away.
    Lost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStepState {
    Queued,
    Running,
    Done,
    /// Not needed this time: setup with unchanged inputs, a build cached for the same commit.
    Reused,
    Failed,
}

/// One step of a preview's start, in the words the app shows: "Build: pnpm build", "reused: pnpm-lock.yaml hasn't
/// changed".
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStep {
    pub words: Line<1, 300>,
    pub state: PreviewStepState,
    pub detail: Option<Line<1, 300>>,
    /// How long it took, once over.
    pub took_ms: Option<Count>,
    /// A failed step's output, its end, masked.
    pub output_tail: Option<Text<1, 4000>>,
}

/// Who asked for a preview, in the words the app shows ("you", "the lead, because you asked at 09:02").
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAsker {
    pub words: Line<1, 200>,
    /// The person's chat message a lead started it for.
    pub message_id: Option<crate::chat::ChatMessageId>,
}

/// One preview as the hub keeps it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub preview_id: PreviewId,
    pub project_ref: ProjectRef,
    pub of: PreviewOf,
    pub target: PreviewTarget,
    /// Where it runs.
    pub machine_id: MachineId,
    pub state: PreviewState,
    pub asked_by: PreviewAsker,
    /// The commit it runs: the PR's head, or the order's merge, once checked out.
    pub head: Option<Line<7, 64>>,
    #[serde(default)]
    pub steps: List<PreviewStep, 0, 40>,
    /// Where the person's own devices open it on the tailnet, once ready: `http://devbox:8414`.
    pub url: Option<Line<1, 300>>,
    /// The browser session the app shows it in, held by the person from the start.
    pub session_id: Option<BrowserSessionId>,
    pub started_at: Timestamp,
    pub ready_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    pub end_reason: Option<PreviewEndReason>,
    /// When it ends if no one uses it, while it runs.
    pub idle_until: Option<Timestamp>,
    /// One plain line when something needs saying: why it failed, that a newer commit is on the PR.
    pub note: Option<Line<1, 500>>,
}

/// An agent's suggestion to try a PR: one line with a Try it button, once per PR. Nothing runs from it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSuggestion {
    pub project_ref: ProjectRef,
    pub of: PreviewOf,
    /// Who suggests it: "#14's writer".
    pub by: Line<1, 200>,
    /// Why a person should try it, in a line.
    pub why: Line<1, 300>,
    pub at: Timestamp,
}

/// `preview.state`: a preview started, moved a step, became ready, ended or failed. previews_list reads the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEventData {
    pub project_ref: ProjectRef,
    pub preview_id: PreviewId,
    pub of: PreviewOf,
    pub state: PreviewState,
}

/// A point the person marked on a preview's screen, and what they said about it. `x` and `y` are where across and
/// down, in ten-thousandths of the screen.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPin {
    pub x: Int<0, 10_000>,
    pub y: Int<0, 10_000>,
    /// The person's words; none: see the screenshot.
    pub note: Option<Text<1, 2000>>,
    /// What is under the pin, as the page names it: `the button "Pay"`.
    pub what: Option<Line<1, 300>>,
    /// The page's address or screen when it was marked.
    pub at: Option<Line<1, 500>>,
}

// ---- agents -> hub, as lead calls ----

/// `preview_suggest`: a writer or lead suggests the person try a PR where a human test clearly matters. Shown once
/// per PR, as one line with a Try it button; nothing runs from it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSuggestCall {
    pub pr_url: crate::train::GitHubPrUrl,
    pub why: Line<1, 300>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSuggestResult {
    /// False: this PR was suggested before, and nothing new shows.
    pub shown: bool,
}

/// `preview_config_propose`: how to run the project's preview, for the person to approve as a card in the chat.
/// Nothing is saved until they do. Answered with the request, as `gated_run` is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConfigProposeCall {
    pub config: PreviewConfig,
    pub why: Line<1, 300>,
}

/// The lead's `preview_start`: only in a turn answering a message of the person's that asks for it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStartCall {
    pub of: PreviewOf,
    #[serde(default)]
    pub target: PreviewTarget,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStartResult {
    pub preview: Preview,
}

// ---- hub -> node, and back ----

/// One branch to check out: a PR's head, or each of an order's PRs merged in turn onto `base`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHead {
    pub branch: Line<1, 255>,
    /// The commit the hub saw; the node fails the run when the branch has moved past it unseen.
    pub sha: Line<7, 64>,
}

/// Start a preview on this node: check out, set up, build, start, wait until it answers, then open it to the person.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct PreviewRunFrame {
    pub id: NonEmpty,
    pub preview_id: PreviewId,
    pub project_id: ProjectId,
    pub target: PreviewTarget,
    /// The base an order's heads are merged onto; absent for one PR.
    pub base: Option<Line<1, 255>>,
    pub heads: List<PreviewHead, 1, 50>,
    pub web: Option<WebPreview>,
    pub idle_minutes: Int<5, PREVIEW_CAP_MIN>,
    /// The tailnet login whose devices may open it (the hub owner's); absent: the node's own tailnet user's.
    pub owner_login: Option<Line<1, 300>>,
    /// The order whose variables it gets on top of the project's: the order previewed, or the order a PR is part of.
    pub order_id: Option<WorkstreamId>,
}
checked!(PreviewRunFrame, |frame| {
    match frame.target {
        PreviewTarget::Web if frame.web.is_none() => Err("a web preview needs web".into()),
        _ if frame.base.is_none() && frame.heads.len() > 1 => {
            Err("several heads need a base".into())
        }
        _ => Ok(()),
    }
});

/// The node took the run (it reports as it goes) or refused it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRunResult {
    pub id: NonEmpty,
    pub error: Option<McpToolError>,
}

/// End a preview: the node throws it away and reports it ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStopFrame {
    pub preview_id: PreviewId,
    pub reason: PreviewEndReason,
}

/// The node's word on a preview, whenever it moves: a step, ready, used (which pushes `idleUntil`), ended, failed.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReport {
    pub preview_id: PreviewId,
    pub state: PreviewState,
    pub head: Option<Line<7, 64>>,
    #[serde(default)]
    pub steps: List<PreviewStep, 0, 40>,
    pub url: Option<Line<1, 300>>,
    pub session_id: Option<BrowserSessionId>,
    pub idle_until: Option<Timestamp>,
    pub end_reason: Option<PreviewEndReason>,
    pub note: Option<Line<1, 500>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_web_preview_takes_its_defaults() {
        let config: PreviewConfig =
            serde_json::from_value(json!({ "web": { "start": "pnpm preview --port $PORT" } }))
                .unwrap();
        assert_eq!(config.idle_minutes.get(), PREVIEW_IDLE_DEFAULT_MIN);
        let web = config.web.as_ref().unwrap();
        assert_eq!(web.ready.as_str(), "/");
        assert!(web.setup.is_empty() && web.build.is_none());
        assert_eq!(config.targets(), vec![PreviewTarget::Web]);
        assert!(serde_json::from_value::<PreviewConfig>(json!({ "idleMinutes": 4 })).is_err());
        assert!(
            serde_json::from_value::<PreviewConfig>(json!({ "idleMinutes": PREVIEW_CAP_MIN + 1 }))
                .is_err()
        );
    }

    #[test]
    fn a_ready_path_is_a_path() {
        for good in ["/", "/healthz", "/app/?x=1"] {
            assert!(ReadyPath::new(good).is_ok(), "{good}");
        }
        for bad in ["", "healthz", "/a b", "http://x/"] {
            assert!(ReadyPath::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_preview_is_of_a_pr_or_an_order() {
        let pr: PreviewOf =
            serde_json::from_value(json!({ "kind": "pr", "repo": "acme/shop", "number": 14 }))
                .unwrap();
        assert!(matches!(pr, PreviewOf::Pr { .. }));
        let order: PreviewOf =
            serde_json::from_value(json!({ "kind": "order", "workstreamId": "W12" })).unwrap();
        assert!(matches!(order, PreviewOf::Order { .. }));
    }

    #[test]
    fn a_run_needs_what_its_target_runs_and_a_base_for_several_heads() {
        let frame = |web: bool, base: bool, heads: usize| {
            let mut v = json!({
                "id": "1",
                "previewId": format!("P{}", "a".repeat(32)),
                "projectId": "p1",
                "target": "web",
                "heads": (0..heads).map(|i| json!({ "branch": format!("b{i}"), "sha": "3f2a91c" })).collect::<Vec<_>>(),
                "idleMinutes": 30,
            });
            if web {
                v["web"] = json!({ "start": "pnpm preview --port $PORT" });
            }
            if base {
                v["base"] = json!("main");
            }
            serde_json::from_value::<PreviewRunFrame>(v)
        };
        assert!(frame(true, false, 1).is_ok());
        assert!(frame(false, false, 1).is_err());
        assert!(frame(true, false, 2).is_err());
        assert!(frame(true, true, 2).is_ok());
    }
}
