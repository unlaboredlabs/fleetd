//! The hub admin's setup (docs/design/setup.md): one list of steps that `fleetd init`, the app's first run and
//! Administration › Setup all render. A step is a guide (why, numbered parts with the values to paste and the
//! provider's pages, the fields for what comes back) around a few doctor checks, which decide its status. The only
//! state the hub keeps is which steps the admin put off for later.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::doctor::DoctorFix;

/// The steps, in the order they are listed.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum SetupStepId {
    Address,
    Machines,
    Claude,
    Github,
    People,
    Google,
    Notion,
}

impl SetupStepId {
    pub const ALL: [SetupStepId; 7] = [
        Self::Address,
        Self::Machines,
        Self::Claude,
        Self::Github,
        Self::People,
        Self::Google,
        Self::Notion,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Address => "address",
            Self::Machines => "machines",
            Self::Claude => "claude",
            Self::Github => "github",
            Self::People => "people",
            Self::Google => "google",
            Self::Notion => "notion",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|id| id.as_str() == s)
    }
}

/// Where a step sits in the list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum SetupGroup {
    /// This hub: where it listens, its machines.
    Hub,
    Accounts,
    People,
    Integrations,
}

/// When a step must be done. Nothing blocks using fleetd before then.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SetupNeed {
    /// Agents can't run without it.
    Required,
    /// Needed only before a feature's first use: `what` is that use, "the first PR".
    Before {
        what: String,
    },
    Optional,
}

/// Read from the step's checks, never from how far a wizard got.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum SetupStatus {
    /// One way's checks all pass.
    Done,
    /// Not set up: no check yet, or "unknown".
    Todo,
    /// Set up, but a check fails or warns.
    Look,
    /// Not set up, and the admin said later.
    Skipped,
}

/// A provider's page, opened in the browser.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SetupLink {
    pub label: String,
    pub url: String,
}

/// A value for the provider's form, computed for this hub.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SetupValue {
    pub label: String,
    pub value: String,
    /// How to paste it, or where.
    pub note: Option<String>,
    /// Words, not a value: what to pick, tick or leave alone.
    pub plain: Option<bool>,
    /// Filled in by fleetd (a manifest, a link): shown to read, never copied.
    pub filled: Option<bool>,
    /// A command to run, rather than a value to paste.
    pub command: Option<bool>,
}

/// One numbered part of a step: what to open, then what to fill in there.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SetupPart {
    pub title: String,
    /// The step works without it.
    pub optional: Option<bool>,
    pub note: Option<String>,
    #[serde(default)]
    pub links: Vec<SetupLink>,
    #[serde(default)]
    pub values: Vec<SetupValue>,
}

/// A field for what the provider gives back. A secret one is sealed on the admin's device, never sent in the clear and
/// never shown again.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SetupField {
    pub name: String,
    pub label: String,
    pub secret: Option<bool>,
    pub optional: Option<bool>,
    /// A pasted file (a JSON key): several lines.
    pub multiline: Option<bool>,
    pub placeholder: Option<String>,
    /// Where a secret is sealed to, when not every machine.
    pub note: Option<String>,
}

/// One way to complete a step: its doctor checks, `hub/<name>`, or `*/<name>` for every machine's. Its status is the
/// worst of them.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SetupWay {
    /// Names the way where a step has several: "the hub's API key".
    pub label: Option<String>,
    pub checks: Vec<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub id: SetupStepId,
    pub group: SetupGroup,
    pub title: String,
    /// Why it matters, in one line.
    pub why: String,
    pub need: SetupNeed,
    pub status: SetupStatus,
    /// What its checks say now: the deciding one's message.
    pub said: Option<String>,
    /// The way in use, where a step has several: the one done, else the one that wants a look.
    pub way: Option<String>,
    /// The deciding check's fix, when a command fixes it.
    pub fix: Option<DoctorFix>,
    pub parts: Vec<SetupPart>,
    /// What comes back from the provider, entered where the step says (`place`).
    #[serde(default)]
    pub fields: Vec<SetupField>,
    /// What happens after the fields are saved.
    pub fields_note: Option<String>,
    /// Where in the app the fields are saved, an Administration section ("google"), where the terminal can't seal
    /// them.
    pub place: Option<String>,
    /// What Test does, in a few words.
    pub test: Option<String>,
    /// The ways to complete it; one is enough.
    pub ways: Vec<SetupWay>,
}

impl SetupStep {
    /// Required and not done: until none is left, the admin's app keeps setup in front.
    pub fn required_left(&self) -> bool {
        self.need == SetupNeed::Required && self.status != SetupStatus::Done
    }
}

/// Whether a way's check pattern (`hub/<name>`, `*/<name>`) names this check id.
pub fn matches_check(pattern: &str, id: &str) -> bool {
    match pattern.strip_prefix("*/") {
        Some(name) => !id.starts_with("hub/") && id.split_once('/').is_some_and(|(_, n)| n == name),
        None => pattern == id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_star_pattern_names_every_machines_check_and_no_hub_one() {
        assert!(matches_check("*/online", "devbox/online"));
        assert!(matches_check("*/online", "lab-a/online"));
        assert!(!matches_check("*/online", "hub/online"));
        assert!(!matches_check("*/online", "devbox/onlines"));
        assert!(matches_check("hub/google", "hub/google"));
        assert!(!matches_check("hub/google", "devbox/google"));
        assert_eq!(SetupStepId::parse("github"), Some(SetupStepId::Github));
        assert_eq!(SetupStepId::parse("nope"), None);
    }
}
