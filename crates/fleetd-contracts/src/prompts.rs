//! The prompts a person can edit, as the human sees them: the registry entries, their default, global and per-project
//! texts, the warnings an edit gets, the exact first message a session was sent, and edits to prompts a release
//! retired.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{MachineId, ProjectRef, ThreadId, Timestamp};

brand!(
    /// A registry id: `lead.start`, `task.brief.write`, `instructions`. A retired one keeps its id (`wake.intent`).
    PromptId,
    name = "PromptId",
    pattern = r"^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$",
    description = "Prompt registry id, dotted lowercase words"
);
brand!(
    /// `<id>@<first 10 hex of the text's git blob SHA>`: one exact text of one prompt.
    PromptRef,
    name = "PromptRef",
    pattern = r"^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*@[0-9a-f]{10}$",
    description = "<prompt id>@<10 lowercase hex of the text's git blob SHA>"
);

/// How the text reaches the model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PromptKind {
    /// The first message of a session.
    Start,
    /// A later message into a running session.
    Msg,
    /// The input of a tool-less one-shot `claude -p`. None ships now; kept while the app names its group.
    Oneshot,
    /// The human's custom instructions, appended to every lead and task first message.
    Instructions,
}

/// Where the app lists it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PromptGroup {
    Lead,
    Tasks,
    ReviewsAndChecks,
    Messages,
    OneShots,
    Instructions,
}

/// Which text is meant: the one shipped in the binary, the hub-wide override, or one project's override.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PromptScope {
    Default,
    Global,
    Project,
}

/// A `{{name}}` the code fills in. A required one missing from an edit gets a warning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Placeholder {
    pub name: String,
    pub required: bool,
    pub description: String,
}

/// Who keeps a safety rule when the prompt no longer says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Enforcement {
    /// fleetd refuses the action anyway; agents just stop being told why.
    Code,
    /// Only the prompt says it; nothing else enforces it.
    Prompt,
}

/// A rule the default text carries, found in a text by `needle` (a case-insensitive regex).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SafetyRule {
    /// Stable, e.g. `secrets-via-ask`.
    pub id: String,
    pub label: String,
    pub needle: String,
    pub enforced: Enforcement,
    /// In `PromptDetail`: whether the effective text still matches `needle`.
    pub present: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PromptWarningCode {
    PlaceholderMissing,
    PlaceholderUnknown,
    SafetyRuleMissing,
    TooLong,
}

/// What an edit may break. Never a refusal: the text is saved anyway.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptWarning {
    pub code: PromptWarningCode,
    pub message: String,
    /// `placeholder_*`: its name.
    pub placeholder: Option<String>,
    /// `safety_rule_missing`: the rule's id and who still enforces it.
    pub rule: Option<String>,
    pub enforced: Option<Enforcement>,
}

/// One exact text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersion {
    pub r#ref: PromptRef,
    pub text: String,
}

/// A human's override: its text and the default it was edited from (absent for a hand-made file).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptOverride {
    pub r#ref: PromptRef,
    pub text: String,
    pub base: Option<PromptRef>,
}

/// An override edited from an older default than the one this release ships. It stays in effect until the human
/// saves it again with `base` = `current.ref`, or resets it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StalePrompt {
    pub scope: PromptScope,
    /// The default it was edited from; absent when the file has no `base` or that text is unknown to this hub.
    pub base: Option<PromptVersion>,
    pub current: PromptVersion,
    pub yours: PromptVersion,
    /// A line 3-way merge of base → current into yours; with `<<<<<<<` markers where they conflict.
    pub merged: String,
    pub conflicts: bool,
}

/// A row of `prompts_list`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptSummary {
    pub id: PromptId,
    pub title: String,
    pub kind: PromptKind,
    pub group: PromptGroup,
    pub sent_when: String,
    /// Which text is in effect for the asked project (or hub-wide).
    pub scope: PromptScope,
    pub default_ref: PromptRef,
    /// The override in effect, when `scope` is not `default`.
    pub override_ref: Option<PromptRef>,
    pub stale: bool,
}

/// `prompt_get`: every level of one prompt for the asked project (or hub-wide).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptDetail {
    pub id: PromptId,
    pub title: String,
    pub kind: PromptKind,
    pub group: PromptGroup,
    pub sent_when: String,
    /// False for a one-shot: it has the hub-wide level only.
    pub per_project: bool,
    pub default: PromptVersion,
    pub global: Option<PromptOverride>,
    pub project: Option<PromptOverride>,
    /// The scope of `effective`.
    pub scope: PromptScope,
    pub effective: PromptVersion,
    pub placeholders: Vec<Placeholder>,
    /// The default's rules, with `present` for `effective`.
    pub safety_rules: Vec<SafetyRule>,
    pub warnings: Vec<PromptWarning>,
    pub stale: Option<StalePrompt>,
}

/// One prompt a session pinned at its start; every later message to it renders from this text.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptRef {
    pub id: PromptId,
    pub r#ref: PromptRef,
    pub scope: PromptScope,
}

/// `session_prompt_get`: exactly what a session was told at its start.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrompt {
    pub machine_id: MachineId,
    pub thread_id: ThreadId,
    pub project_ref: Option<ProjectRef>,
    pub started_at: Timestamp,
    /// The exact first message.
    pub text: String,
    /// The text's full git blob SHA.
    pub text_sha: String,
    pub refs: Vec<SessionPromptRef>,
    /// Tools the claude runner never offers a fleetd session.
    pub disallowed_tools: Vec<String>,
}

/// An override of a prompt a release retired (merged into another, or replaced by fixed text), kept so the human can
/// carry what they wrote into a prompt that still exists. Its file stays until `prompt_reset` on its id.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetiredPromptOverride {
    /// The retired id.
    pub id: PromptId,
    pub title: String,
    /// `global` or `project`.
    pub scope: PromptScope,
    pub project_ref: Option<ProjectRef>,
    pub text: String,
    /// The prompt that now covers what this one said, when one does. fleetd never copies the text over itself.
    pub suggested_target: Option<PromptId>,
    /// What replaced it, in one line.
    pub why: String,
}
