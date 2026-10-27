//! M3 ledger objects: leads, workstreams and briefs, asks and batches, decisions.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_with::skip_serializing_none;

use crate::ids::{ProjectRef, ThreadId, Timestamp};
use crate::prim::{Count, Int, Line, List, NonEmpty, Text, js_len};
use crate::secrets::{SecretFingerprint, SecretSink};
use crate::usage::UsageParked;
use crate::{brand, checked};

brand!(
    /// "W" plus a positive integer, unique per hub, e.g. "W12".
    WorkstreamId, name = "WorkstreamId", pattern = r"^W[1-9][0-9]*$"
);
brand!(
    /// "D" plus a positive integer, unique per hub.
    DecisionId, name = "DecisionId", pattern = r"^D[1-9][0-9]*$"
);

static DECISION_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9]+(\.[a-z0-9_-]+)*$").unwrap());

brand!(
    /// Lowercase dotted slug such as "api.health.path", at most 80 characters.
    DecisionKey,
    name = "DecisionKey",
    check = |s| js_len(s) <= 80 && DECISION_KEY.is_match(s),
    expected = "a lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)*, at most 80",
    pattern = r"^[a-z0-9]+(\.[a-z0-9_-]+)*$",
    description = "Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)*, at most 80"
);

/// One line of status, as shown next to a workstream.
pub type Headline = Line<0, 280>;

// Leads

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LeadState {
    Starting,
    Idle,
    Working,
    Stalled,
    Stopped,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Lead {
    pub project_ref: ProjectRef,
    /// The current lead thread on the project's machine; earlier ones stay on the node as history.
    pub thread_id: ThreadId,
    pub state: LeadState,
    pub started_at: Timestamp,
    pub last_wake_at: Option<Timestamp>,
    /// Bumped by each `lead_start {fresh}`.
    pub session_generation: Count,
    /// M4: the lead thread hit a usage limit; derived from the usage layer when read.
    pub parked: Option<UsageParked>,
}

// Briefs

/// One line of what done looks like. Writers and reviewers read it; fleetd runs none of it, and the lead closes the
/// workstream with why.
pub type DoneWhen = Text<1, 2000>;

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub goal: Text<1, 1000>,
    pub why: Text<1, 2000>,
    pub pointers: List<Text<1, 500>, 0, 20>,
    pub constraints: List<Text<1, 500>, 0, 20>,
    /// At least one.
    pub done_when: List<DoneWhen, 1, 20>,
}

// Workstreams

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkstreamState {
    /// A draft (no brief yet) or running: which one is the brief's to say. Older records read back as open.
    #[serde(
        alias = "draft",
        alias = "running",
        alias = "converging",
        alias = "verifying"
    )]
    Open,
    Done,
    #[serde(alias = "failed")]
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-open" = true))]
pub enum IntakeChannel {
    // The removed phone app wrote "phone"; old records read back as the app.
    #[serde(alias = "phone")]
    App,
    Mcp,
    Lead,
    /// A run of one of the project's automations; `by` is "automation:<automationId>".
    Automation,
    /// The merge train's watch after a merge: a check it doesn't wait for failed on the base; `by` is "hub:train".
    Train,
}

/// The one-line intent as submitted.
pub type IntakeText = Text<1, 4000>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamSource {
    pub text: IntakeText,
    pub channel: IntakeChannel,
    /// Who submitted it: an agent keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: String,
    pub at: Timestamp,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Workstream {
    pub workstream_id: WorkstreamId,
    pub project_ref: ProjectRef,
    pub title: Text<0, 200>,
    pub source: WorkstreamSource,
    /// Absent while draft.
    pub brief: Option<Brief>,
    pub state: WorkstreamState,
    pub headline: Option<Headline>,
    pub headline_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// The person whose message started it: the writer of the human message the lead was answering when it opened the
    /// order, or the person who sent it as an order. Absent for an automation's, a train fix's or an agent's order, and
    /// from a hub before people.
    pub started_by: Option<crate::people::PersonRef>,
}

// Decisions

pub type DecisionValue = Text<1, 2000>;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum DecisionScope {
    Global,
    Project { project_ref: ProjectRef },
    Workstream { workstream_id: WorkstreamId },
}

/// Filled by the hub from the caller: a human device, an agent key, or a lead-side call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DecisionSource {
    Human,
    Lead,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DecisionState {
    Active,
    Superseded,
    Retired,
}

pub type DecisionWhy = Text<1, 2000>;

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub decision_id: DecisionId,
    pub key: DecisionKey,
    pub scope: DecisionScope,
    pub value: DecisionValue,
    pub why: Option<DecisionWhy>,
    pub source: DecisionSource,
    /// Who recorded it: the agent key name, "lead:<machineId>/<projectId>" or "human:<device>".
    pub by: Option<String>,
    /// The person who recorded it, for a human key's decision. Absent from a hub before people.
    pub person: Option<crate::people::PersonRef>,
    /// The earlier active decision on the same key and scope that this one replaced.
    pub supersedes: Option<DecisionId>,
    pub state: DecisionState,
    pub at: Timestamp,
    /// Who took it back, when a person revoked it (`decisions_overturn` without a value).
    pub retired: Option<DecisionRetired>,
}

/// A revoke: by "human:<device>", at, and the person's why.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRetired {
    pub by: String,
    /// The person who took it back. Absent from a hub before people.
    pub person: Option<crate::people::PersonRef>,
    pub at: Timestamp,
    pub why: Option<DecisionWhy>,
}

// Asks

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GatedClass {
    Irreversible,
    Money,
    Credential,
}

impl GatedClass {
    pub fn as_str(self) -> &'static str {
        match self {
            GatedClass::Irreversible => "irreversible",
            GatedClass::Money => "money",
            GatedClass::Credential => "credential",
        }
    }
}

brand!(
    /// A process environment variable name.
    EnvName, name = "EnvName", pattern = r"^[A-Za-z_][A-Za-z0-9_]{0,127}$"
);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretEnvEntry {
    pub name: EnvName,
    pub secret_key: DecisionKey,
}

/// `--secret-env NAME=<secret key>`: the node reads the value from that secret's sink; it never crosses the hub.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct SecretEnv(pub List<SecretEnvEntry, 0, 20>);

impl SecretEnv {
    pub fn new(entries: Vec<SecretEnvEntry>) -> Result<Self, String> {
        let list = List::new(entries)?;
        if list
            .iter()
            .enumerate()
            .any(|(i, entry)| list[..i].iter().any(|earlier| earlier.name == entry.name))
        {
            return Err("each env name at most once".into());
        }
        Ok(Self(list))
    }
}

impl std::ops::Deref for SecretEnv {
    type Target = Vec<SecretEnvEntry>;
    fn deref(&self) -> &Vec<SecretEnvEntry> {
        &self.0
    }
}

impl Serialize for SecretEnv {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

impl<'de> Deserialize<'de> for SecretEnv {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(Vec::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for SecretEnv {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "SecretEnv".into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        List::<SecretEnvEntry, 0, 20>::json_schema(generator)
    }
}

/// The node runs at most 4 hours.
pub const GATED_MAX_TIMEOUT_SEC: i64 = 14_400;
/// A gated run without a timeout gets 30 minutes.
pub const GATED_DEFAULT_TIMEOUT_SEC: i64 = 1800;
pub type GatedTimeoutSec = Int<1, GATED_MAX_TIMEOUT_SEC>;

/// argv only, no shell unless argv itself invokes one; at most 64 entries like a `cmd` check.
pub type GatedArgv = List<String, 1, 64>;

brand!(
    /// Absolute; absent means the project workspace. The node refuses a cwd outside its command roots.
    GatedCwd,
    check = |s| js_len(s) <= 1000 && s.starts_with('/'),
    expected = "an absolute path of at most 1000 characters",
    pattern = r"^/"
);

/// Stored with the approval and never changed: the human approves exactly these bytes.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedRunSpec {
    pub argv: GatedArgv,
    pub cwd: Option<GatedCwd>,
    pub class: GatedClass,
    pub reason: Text<1, 500>,
    pub secret_env: Option<SecretEnv>,
    pub timeout_sec: GatedTimeoutSec,
}

/// An approval raised by a session's tool permission prompt instead of a gated command: answering it answers the prompt
/// on the project's node. Its machine is the request's project's.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolPermission {
    pub thread_id: ThreadId,
    pub request_id: NonEmpty,
    pub tool_name: NonEmpty,
    /// The command, the path, or the tool's own description.
    pub summary: Text<0, 2000>,
}

/// What a lead needs a person for that chat can't carry safely: a secret value (entered in a masked field and sealed to
/// the sink's node, never in a transcript), or an approval of a risky command (a gated run, or a session's tool
/// prompt). The lead asks everything else in chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    Secret,
    Approval,
}

/// The state names of the chat items that show it (`SecretRequestState`, `CommandApprovalState`). secret: open →
/// stored | withdrawn. approval: open → approved → ran | failed, or open → denied; an approval the node could not run
/// goes back to open with the reason in `evidence`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestState {
    Open,
    Stored,
    Withdrawn,
    Approved,
    Denied,
    Ran,
    Failed,
}

impl RequestState {
    pub fn as_str(self) -> &'static str {
        match self {
            RequestState::Open => "open",
            RequestState::Stored => "stored",
            RequestState::Withdrawn => "withdrawn",
            RequestState::Approved => "approved",
            RequestState::Denied => "denied",
            RequestState::Ran => "ran",
            RequestState::Failed => "failed",
        }
    }

    /// Nothing more happens to it.
    pub fn is_final(self) -> bool {
        !matches!(self, RequestState::Open | RequestState::Approved)
    }
}

/// A secret request: the secret's name and where the node writes it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequest {
    /// The secret's name, a dotted slug such as "stripe.test_key".
    pub key: DecisionKey,
    pub sink: SecretSink,
    /// An env: or order: sink's variable, when not the one the key names (`secret_env_name`).
    pub env_name: Option<EnvName>,
    /// Set once the node has written the sink; the value itself never reaches the hub in plain text.
    pub fingerprint: Option<SecretFingerprint>,
}

/// One human request, as stored and as every client shows it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct HumanRequest {
    pub request_id: crate::chat::ChatRequestId,
    pub project_ref: ProjectRef,
    pub workstream_id: Option<WorkstreamId>,
    pub kind: RequestKind,
    /// One line on why the lead needs it.
    pub text: Text<1, 500>,
    pub state: RequestState,
    /// secret only.
    pub secret: Option<SecretRequest>,
    /// approval of a gated run: exactly the bytes the node runs.
    pub gated: Option<GatedRunSpec>,
    /// approval of a session's tool prompt, instead of a gated run.
    pub permission: Option<ToolPermission>,
    /// approval of an agent's proposed preview setting (preview_config_propose), instead of a gated run: approving it
    /// saves it as the project's `preview`.
    pub preview_config: Option<crate::preview::PreviewConfigProposeCall>,
    /// What happened, in one line: "fingerprint ab12cd34", "exit 0 on devbox, approved by human:desk", or why it did
    /// not run (and so is open again).
    pub evidence: Option<Text<0, 2000>>,
    /// An approval that ran: its exit code (absent when a signal or the timeout ended it) and the end of its output,
    /// with every injected secret value scrubbed.
    pub exit_code: Option<i64>,
    pub output_tail: Option<Text<0, 2000>>,
    pub created_at: Timestamp,
    pub answered_at: Option<Timestamp>,
    /// "human:<device>".
    pub answered_by: Option<String>,
    /// The person who answered it: approved or denied it, or entered the secret. Absent from a hub before people.
    pub answered_by_person: Option<crate::people::PersonRef>,
    /// An approved command: when its result came back (ran or failed), so a client can say how long it took.
    pub finished_at: Option<Timestamp>,
}
checked!(HumanRequest, |r| request_kind_rule(r));

/// Each kind carries its own fields only: a secret its `secret`; an approval exactly one of `gated`, `permission` and
/// `previewConfig`.
pub fn request_kind_rule(r: &HumanRequest) -> Result<(), String> {
    match r.kind {
        RequestKind::Secret => {
            if r.secret.is_none()
                || r.gated.is_some()
                || r.permission.is_some()
                || r.preview_config.is_some()
            {
                return Err("a secret request has a secret and nothing else".into());
            }
            if let Some(secret) = &r.secret
                && secret.env_name.is_some()
                && !secret.sink.starts_with("env:")
                && !secret.sink.starts_with("order:")
            {
                return Err("only an env: or order: sink has an env name".into());
            }
        }
        RequestKind::Approval => {
            let held = [
                r.gated.is_some(),
                r.permission.is_some(),
                r.preview_config.is_some(),
            ];
            if r.secret.is_some() || held.iter().filter(|h| **h).count() != 1 {
                return Err(
                    "an approval has exactly one of a gated run, a tool prompt and a preview setting".into(),
                );
            }
        }
    }
    let allowed: &[RequestState] = match r.kind {
        RequestKind::Secret => &[
            RequestState::Open,
            RequestState::Stored,
            RequestState::Withdrawn,
        ],
        RequestKind::Approval => &[
            RequestState::Open,
            RequestState::Approved,
            RequestState::Denied,
            RequestState::Ran,
            RequestState::Failed,
        ],
    };
    if !allowed.contains(&r.state) {
        return Err(format!(
            "a {:?} request is never {}",
            r.kind,
            r.state.as_str()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn accepts<T: serde::de::DeserializeOwned>(value: Value) -> bool {
        serde_json::from_value::<T>(value).is_ok()
    }

    #[test]
    fn decision_keys_are_lowercase_dotted_slugs_up_to_80() {
        for key in [
            "api",
            "api.health.path",
            "pref.dark_mode",
            "a1.b-2",
            &format!("a.{}", "x".repeat(78)),
        ] {
            assert!(DecisionKey::new(key).is_ok(), "{key}");
        }
        for key in [
            "",
            "Api",
            "api.",
            ".api",
            "api..path",
            "_api",
            "api-x.y",
            "api path",
            &format!("a.{}", "x".repeat(79)),
        ] {
            assert!(DecisionKey::new(key).is_err(), "{key}");
        }
    }

    #[test]
    fn hub_serial_ids_are_the_prefix_plus_a_positive_integer() {
        for id in ["W1", "W12"] {
            assert!(WorkstreamId::new(id).is_ok());
        }
        for id in ["W0", "W01", "w1", "A1", "W", "W1x"] {
            assert!(WorkstreamId::new(id).is_err(), "{id}");
        }
    }

    fn with(mut value: Value, patch: Value) -> Value {
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        value
    }

    fn request(kind: &str, extra: Value) -> Value {
        let mut value = json!({
            "requestId": "Q1", "projectRef": { "machineId": "devbox", "projectId": "p1" }, "kind": kind,
            "text": "Need it to deploy", "state": "open", "createdAt": "2026-10-19T09:00:00.000Z",
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    }

    #[test]
    fn a_request_carries_its_own_kinds_fields_and_states_only() {
        let secret =
            json!({ "secret": { "key": "stripe.test_key", "sink": "env:devbox:/srv/app/.env" } });
        let gated = json!({ "gated": { "argv": ["./deploy.sh"], "class": "irreversible", "reason": "prod deploy", "timeoutSec": 60 } });
        assert!(accepts::<HumanRequest>(request("secret", secret.clone())));
        assert!(accepts::<HumanRequest>(request("approval", gated.clone())));
        assert!(
            !accepts::<HumanRequest>(request("secret", gated.clone())),
            "a secret has no command"
        );
        assert!(
            !accepts::<HumanRequest>(request("approval", json!({}))),
            "an approval names what it approves"
        );
        let mut stored = request("approval", gated);
        stored["state"] = "stored".into();
        assert!(
            !accepts::<HumanRequest>(stored),
            "an approval is never stored"
        );
        let mut file_env = request("secret", secret);
        file_env["secret"]["sink"] = "file:devbox:/srv/key".into();
        file_env["secret"]["envName"] = "KEY".into();
        assert!(
            !accepts::<HumanRequest>(file_env),
            "only an env: sink has an env name"
        );
    }

    #[test]
    fn briefs_need_a_done_when_line() {
        let brief = json!({
            "goal": "g", "why": "w", "pointers": [], "constraints": [],
            "doneWhen": ["the health page answers 200"],
        });
        assert!(accepts::<Brief>(brief.clone()));
        assert!(!accepts::<Brief>(with(
            brief.clone(),
            json!({ "doneWhen": [] })
        )));
        assert!(!accepts::<Brief>(with(brief, json!({ "doneWhen": [""] }))));
    }

    #[test]
    fn secret_env_names_are_unique() {
        let entry = |name: &str| json!({ "name": name, "secretKey": "stripe.key" });
        assert!(accepts::<SecretEnv>(json!([entry("A"), entry("B")])));
        assert!(!accepts::<SecretEnv>(json!([entry("A"), entry("A")])));
    }
}
