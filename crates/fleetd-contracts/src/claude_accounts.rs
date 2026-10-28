//! Teams step 8 (D200): which Claude account each agent runs on. A hub may have an API configuration (the admin's
//! Claude API key and an optional endpoint), and each person may connect their own subscription (a long-lived token,
//! what `claude setup-token` makes). Each secret is sealed in the desktop app to each machine's box key, as MCP
//! secrets are: the hub relays the boxes and keeps only each node's fingerprint; the node keeps the value, gives it
//! to the sessions of that account and masks it in what they report.
//!
//! Whose account runs what (the hub decides at each launch, and the session keeps it for its life):
//! - an order's writers, readers and reviewers: the choice of the person who started it (`Workstream.startedBy`);
//! - a Navi's lead and agents: its owner's choice;
//! - a project's lead, and work nobody started (automations, train fixes, the nightly memory refresh): the hub's API
//!   configuration, else the hub owner's subscription;
//! - with none of it set up, the machine's own `claude login`, as before.
//!
//! One person's subscription is never used for anyone else's work.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{MachineId, Timestamp};
use crate::people::{PersonId, PersonRef};
use crate::secrets::{SealedSecret, SecretFingerprint};

/// The variable a subscription's token reaches claude in.
pub const OAUTH_TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";
/// The variable the hub's API key reaches claude in.
pub const API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// The variable the hub's endpoint reaches claude in, when it has one.
pub const BASE_URL_ENV: &str = "ANTHROPIC_BASE_URL";
/// What a session on an account never keeps from the machine's own setup: another credential or gateway would
/// outrank or redirect the account's.
pub const ACCOUNT_CLEARS: &[&str] = &[
    OAUTH_TOKEN_ENV,
    API_KEY_ENV,
    BASE_URL_ENV,
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

/// The refusal for someone with no way to run: no subscription, and the hub's API not theirs to use.
pub const CONNECT_REFUSAL: &str = "Connect your Claude to start this order.";

brand!(
    /// A custom endpoint for the hub's API key, as `ANTHROPIC_BASE_URL` takes it: an http or https URL, one line.
    ClaudeEndpoint,
    name = "ClaudeEndpoint",
    pattern = r"^https?://[^\s]{1,500}$",
    description = "an http:// or https:// URL of at most 500 characters, no spaces"
);

/// The account a session runs on, as a launch names it. The node resolves it from the secrets it holds: `hub` is
/// the hub's API key (`ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` with an endpoint), `person` that person's
/// subscription (`CLAUDE_CODE_OAUTH_TOKEN`).
#[derive(
    Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeAccount {
    Hub,
    #[serde(rename_all = "camelCase")]
    Person {
        person_id: PersonId,
    },
}

impl ClaudeAccount {
    /// `hub`, or the person's id: how the hub and the node key an account's records and usage.
    pub fn key(&self) -> &str {
        match self {
            ClaudeAccount::Hub => "hub",
            ClaudeAccount::Person { person_id } => person_id.as_str(),
        }
    }

    /// The inverse of [`Self::key`]; `None` for anything else.
    pub fn from_key(key: &str) -> Option<Self> {
        if key == "hub" {
            return Some(ClaudeAccount::Hub);
        }
        PersonId::new(key)
            .ok()
            .map(|person_id| ClaudeAccount::Person { person_id })
    }
}

/// What a person picked in their own settings. Unset: their subscription once they connect one, else the hub's API.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeChoice {
    Subscription,
    HubApi,
}

/// One machine's box of an account's secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSeal {
    pub machine_id: MachineId,
    /// `crypto_box_seal` of the key or token to that machine's `boxPubKey`.
    pub sealed: SealedSecret,
}

/// A machine whose node holds an account's secret, with the fingerprint it computed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSealedOn {
    pub machine_id: MachineId,
    pub fingerprint: SecretFingerprint,
}

/// The last Test of an account: one tiny `claude -p` call made with it on one machine.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTest {
    pub at: Timestamp,
    pub machine_id: MachineId,
    pub ok: bool,
    /// What went wrong, in claude's words with the secret masked; absent when it worked.
    pub error: Option<String>,
}

/// The hub's API configuration as the hub keeps it: never the key, only where it is.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHubApi {
    pub endpoint: Option<ClaudeEndpoint>,
    /// Each machine whose node holds the key. A machine missing here runs nothing on it.
    pub sealed_on: Vec<ClaudeSealedOn>,
    pub updated_at: Timestamp,
    pub updated_by: Option<PersonRef>,
    pub last_test: Option<ClaudeTest>,
}

/// A person's connected subscription: never the token, only where it is.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSubscription {
    pub sealed_on: Vec<ClaudeSealedOn>,
    pub connected_at: Timestamp,
    pub last_test: Option<ClaudeTest>,
}

/// What some work runs on now: an account, the machines' own login, or a refusal.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeRunsOn {
    /// Nothing is set up for it: each machine's own `claude login`, as before teams step 8.
    MachineLogin,
    /// This account.
    Account { account: ClaudeAccount },
    /// Nothing it may use: what to do.
    Refused { message: String, fix: String },
}

/// One person's Claude setup.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PersonClaude {
    pub person: PersonRef,
    /// Absent: their subscription once connected, else the hub's API.
    pub choice: Option<ClaudeChoice>,
    pub subscription: Option<ClaudeSubscription>,
    /// Whether the hub's API is theirs to use: it is set up, and they administer the hub or members may use it.
    pub may_use_hub_api: bool,
    /// What the orders they start, and their Navi, run on now.
    pub runs_on: ClaudeRunsOn,
}

/// Hub-wide Claude settings (Administration).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    /// Members may run their work on the hub's API configuration (on by default). Off, each member connects their
    /// own subscription; it never affects owners and admins, projects' leads or work nobody started.
    pub members_use_hub_api: bool,
}

impl Default for ClaudeSettings {
    fn default() -> Self {
        Self {
            members_use_hub_api: true,
        }
    }
}

/// Which account `claude_account_test` tries: the hub's API key (admins), or the caller's own subscription.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeTestTarget {
    HubApi,
    Mine,
}

/// The seals of one secret name no machine twice.
pub fn seals_distinct(seals: &[ClaudeSeal]) -> Result<(), String> {
    let mut machines = std::collections::BTreeSet::new();
    match seals
        .iter()
        .find(|s| !machines.insert(s.machine_id.as_str()))
    {
        Some(twice) => Err(format!("sealed to {} twice", twice.machine_id)),
        None => Ok(()),
    }
}

/// Hub -> node: an account's secret, sealed to the node's box key.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSecretSet {
    /// The key or token; absent keeps the one the node holds (an endpoint change alone).
    pub sealed: Option<SealedSecret>,
    /// The hub's endpoint, for `hub` only.
    pub endpoint: Option<ClaudeEndpoint>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_keys_round_trip() {
        let person = ClaudeAccount::Person {
            person_id: PersonId::unchecked("p_abcdefgh"),
        };
        for account in [ClaudeAccount::Hub, person] {
            assert_eq!(ClaudeAccount::from_key(account.key()), Some(account));
        }
        assert_eq!(ClaudeAccount::from_key("devbox"), None);
        assert_eq!(
            serde_json::to_value(ClaudeAccount::Person {
                person_id: PersonId::unchecked("p_abcdefgh")
            })
            .unwrap(),
            serde_json::json!({ "kind": "person", "personId": "p_abcdefgh" })
        );
    }

    #[test]
    fn endpoints_are_one_http_url() {
        assert!(ClaudeEndpoint::new("https://gateway.devbox.example/v1").is_ok());
        assert!(ClaudeEndpoint::new("http://127.0.0.1:8317").is_ok());
        for bad in ["gateway.example", "https://a b", "ftp://x", "https://x\ny"] {
            assert!(ClaudeEndpoint::new(bad).is_err(), "{bad}");
        }
    }
}
