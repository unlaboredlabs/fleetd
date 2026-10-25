//! A project's own settings, as Settings › Projects in the desktop app shows them: its name, whether finished
//! worktrees are kept, its agents' environment variables, and the worktrees its node holds.
//!
//! A project's variables live on its machine's node, which adds them to every claude it starts for the project. The
//! hub keeps each variable's name and kind, a plain variable's value, and a secret's fingerprint: a secret's value is
//! sealed in the desktop app to the node's box key (as secret asks are), the hub only relays the ciphertext, and
//! nothing ever sends the value back.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ThreadId, Timestamp};
use crate::secrets::{SECRET_MAX_BYTES, SealedSecret, SecretFingerprint};

/// Variables one project may have.
pub const PROJECT_ENV_MAX: usize = 100;

brand!(
    /// An environment variable's name: a letter or `_`, then letters, digits and `_`, at most 128 characters.
    EnvVarName,
    name = "EnvVarName",
    pattern = r"^[A-Za-z_][A-Za-z0-9_]{0,127}$"
);

/// Names fleetd sets itself for every session, so a project can't: the session's home, `PATH` and user, the claude
/// config dir it was given, and every `FLEETD_` variable.
pub fn env_name_reserved(name: &str) -> bool {
    matches!(name, "HOME" | "PATH" | "USER" | "CLAUDE_CONFIG_DIR") || name.starts_with("FLEETD_")
}

brand!(
    /// A plain variable's value: up to 8192 bytes, no NUL (a process environment can't hold one).
    EnvValue,
    name = "EnvValue",
    check = |s| s.len() <= SECRET_MAX_BYTES && !s.contains('\0'),
    expected = "a value of at most 8192 bytes with no NUL"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EnvVarKind {
    /// Shown in the app and kept by the hub.
    Plain,
    /// Write-only: only the node holds the value; the hub and the app see its fingerprint.
    Secret,
}

/// One of a project's variables as the hub keeps it. A secret has no value here, only its fingerprint.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEnvVar {
    pub name: EnvVarName,
    pub kind: EnvVarKind,
    /// A plain variable's value.
    pub value: Option<EnvValue>,
    /// A secret's: the first 8 hex characters of sha256 over its value, as the node computed it.
    pub fingerprint: Option<SecretFingerprint>,
    pub updated_at: Timestamp,
}

/// One variable to add or replace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnvVarSet {
    Plain {
        name: EnvVarName,
        value: EnvValue,
    },
    /// `sealed`: `crypto_box_seal` of the value to the project machine's `boxPubKey`, one line (no CR, LF or NUL).
    Secret {
        name: EnvVarName,
        sealed: SealedSecret,
    },
}

impl EnvVarSet {
    pub fn name(&self) -> &EnvVarName {
        match self {
            EnvVarSet::Plain { name, .. } | EnvVarSet::Secret { name, .. } => name,
        }
    }
}

/// A secret the node saved, with the fingerprint of its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EnvSecretSaved {
    pub name: EnvVarName,
    pub fingerprint: SecretFingerprint,
}

/// One fleetd worktree of the project on its node, under `<node home>/worktrees/<project>/`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorktree {
    /// The session that works in it.
    pub session_id: ThreadId,
    pub path: String,
    /// A writer's branch; absent for a read or review task's detached worktree.
    pub branch: Option<String>,
    /// It has changes git hasn't committed (gitignored files don't count): deleting the project loses them.
    pub uncommitted: bool,
}

/// Where the project's worktrees live on its node and what is there now.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorktrees {
    /// `<node home>/worktrees/<project>`: every new worktree of the project goes here, one per session.
    pub dir: String,
    /// The branch new worktrees start from, freshly fetched from the remote: the repo's default branch. Absent for a
    /// repo with no commit yet.
    pub base_branch: Option<String>,
    pub worktrees: Vec<ProjectWorktree>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_names_are_shell_names_and_fleetd_keeps_its_own() {
        for good in ["A", "_x", "STRIPE_KEY", "a1_B2"] {
            assert!(EnvVarName::new(good).is_ok(), "{good}");
        }
        for bad in ["", "1A", "A-B", "A B", "A=B", "É"] {
            assert!(EnvVarName::new(bad).is_err(), "{bad}");
        }
        assert!(env_name_reserved("FLEETD_THREAD_ID"));
        assert!(env_name_reserved("PATH"));
        assert!(!env_name_reserved("FLEETDX"));
        assert!(!env_name_reserved("DATABASE_URL"));
        assert!(EnvValue::new("a\0b").is_err());
        assert!(EnvValue::new("x".repeat(SECRET_MAX_BYTES + 1)).is_err());
        assert!(EnvValue::new("").is_ok());
    }

    #[test]
    fn a_set_names_its_kind() {
        let set: EnvVarSet =
            serde_json::from_str(r#"{"kind":"plain","name":"A","value":"1"}"#).unwrap();
        assert_eq!(set.name().as_str(), "A");
        assert!(
            serde_json::from_str::<EnvVarSet>(r#"{"kind":"secret","name":"A","value":"1"}"#)
                .is_err()
        );
    }
}
