//! A project's own settings, as Settings › Projects in the desktop app shows them: its name, whether finished
//! worktrees are kept, its agents' environment variables, the setup commands run in each new worktree, how the merge
//! train treats its repo's checks, and the worktrees its node holds.
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
use crate::secrets::{SealedSecret, SecretFingerprint};

/// Variables one project may have.
pub const PROJECT_ENV_MAX: usize = 100;

/// Largest value of one variable, plain or secret, any number of lines: 64 KiB, room for a certificate chain or a
/// service account's JSON. A secret's sealed box must hold it.
pub const ENV_VALUE_MAX_BYTES: usize = 64 * 1024;
const _: () = assert!(crate::secrets::SECRET_MAX_BYTES >= ENV_VALUE_MAX_BYTES);

/// All of one project's values together: every one goes into every session's environment, and the kernel refuses to
/// start a process whose environment and arguments pass its limit (`ARG_MAX`, often 2 MiB).
pub const ENV_TOTAL_MAX_BYTES: usize = 512 * 1024;

/// The refusal when a change would take a project's values past [`ENV_TOTAL_MAX_BYTES`], naming the total.
pub fn env_total_over(total: usize) -> String {
    format!(
        "A project's variables take at most 512 KiB together; these would take {} KiB.",
        total.div_ceil(1024)
    )
}

brand!(
    /// An environment variable's name: a letter or `_`, then letters, digits and `_`, at most 128 characters.
    EnvVarName,
    name = "EnvVarName",
    pattern = r"^[A-Za-z_][A-Za-z0-9_]{0,127}$"
);

/// Names fleetd sets itself for every session, so a project can't: the session's home, `PATH`, user and scratch dir,
/// every `FLEETD_` variable, and claude's own (`ANTHROPIC_*` and `CLAUDE*`: its login, gateway, model and config),
/// which would change how the agent itself runs.
pub fn env_name_reserved(name: &str) -> bool {
    matches!(name, "HOME" | "PATH" | "USER" | "TMPDIR" | "TMP" | "TEMP")
        || ["FLEETD_", "ANTHROPIC_", "CLAUDE"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

brand!(
    /// A plain variable's value: up to 64 KiB, any number of lines, no NUL (a process environment can't hold one).
    EnvValue,
    name = "EnvValue",
    check = |s| s.len() <= ENV_VALUE_MAX_BYTES && !s.contains('\0'),
    expected = "a value of at most 64 KiB (65536 bytes) with no NUL"
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
    /// The value's size in bytes, a secret's too, for the project's total ([`ENV_TOTAL_MAX_BYTES`]).
    pub bytes: crate::prim::Count,
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
    /// `sealed`: `crypto_box_seal` of the value to the project machine's `boxPubKey`: up to 64 KiB, any number of
    /// lines, no NUL.
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

/// Setup commands one project may have.
pub const SETUP_COMMANDS_MAX: usize = 20;
/// Files one project's setup may name as its inputs.
pub const SETUP_INPUTS_MAX: usize = 20;
/// Each setup command's time limit when the project sets none: 10 minutes.
pub const SETUP_TIMEOUT_DEFAULT_SEC: i64 = 600;
/// The longest a project may give each setup command: an hour.
pub const SETUP_TIMEOUT_MAX_SEC: i64 = 3600;

/// One setup command: a shell line (`sh -c`), at most 2000 characters.
pub type SetupCommand = crate::prim::Line<1, 2000>;

brand!(
    /// A file setup reads, relative to the worktree (`pnpm-lock.yaml`, `crates/Cargo.lock`): no leading `/`, no
    /// empty, `.` or `..` segment, at most 500 characters.
    SetupInput,
    name = "SetupInput",
    check = |s: &str| {
        s.len() <= 500
            && !s.starts_with('/')
            && !s.contains(['\0', '\n', '\r'])
            && s.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
    },
    expected = "a path relative to the worktree, with no empty, . or .. segment"
);

/// What runs in each new worktree of a project before its agent starts: install dependencies, generate code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetup {
    /// In order, each with `sh -c` in the worktree and the project's variables (the order's too); the first that
    /// fails or passes its time limit stops the rest.
    #[serde(default)]
    pub commands: crate::prim::List<SetupCommand, 0, SETUP_COMMANDS_MAX>,
    /// Each command's time limit, in seconds.
    #[serde(default = "setup_timeout_default")]
    pub timeout_sec: crate::prim::Int<1, SETUP_TIMEOUT_MAX_SEC>,
    /// True: a failed setup still starts the agent, which is told what failed. False (the default): the start fails,
    /// naming the command and the end of its output.
    #[serde(default)]
    pub run_anyway: bool,
    /// Files whose contents decide what setup makes, such as lockfiles. A worktree an earlier agent set up with the
    /// same commands, while these held the same contents, is not set up again. None listed: setup always runs.
    #[serde(default)]
    pub inputs: crate::prim::UniqueList<SetupInput, 0, SETUP_INPUTS_MAX>,
}

fn setup_timeout_default() -> crate::prim::Int<1, SETUP_TIMEOUT_MAX_SEC> {
    crate::prim::Int::unchecked(SETUP_TIMEOUT_DEFAULT_SEC)
}

impl Default for WorktreeSetup {
    fn default() -> Self {
        Self {
            commands: Default::default(),
            timeout_sec: setup_timeout_default(),
            run_anyway: false,
            inputs: Default::default(),
        }
    }
}

impl WorktreeSetup {
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

/// Checks one train setting may name.
pub const TRAIN_CHECKS_MAX: usize = 50;

/// A check as GitHub names it on a commit: a check run's name, such as `test (ubuntu-latest)`, or a status's context.
pub type CheckName = crate::prim::Text<1, 200>;

/// How the merge train treats a repo's checks, from its base's `.fleetd/train.json`. It waits only for its fast set:
/// the checks the base branch requires, read from its ruleset or branch protection, plus `fastChecks`, each until it
/// reports, however late it starts. It never waits for any other check; one of those that has already failed when the
/// fast set is green still stops the merge, unless it is in `afterMerge`. A check the base requires is always in the
/// fast set: GitHub won't merge without it. With no required check and none added, it waits for every check. After a
/// merge it watches every check outside the fast set on the merged commit; one that fails there opens a fix order for
/// the project, once per failure.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrainSettings {
    /// Checks the train waits for besides the required ones.
    #[serde(default)]
    pub fast_checks: crate::prim::UniqueList<CheckName, 0, TRAIN_CHECKS_MAX>,
    /// Checks that never stop a merge, even once failed: they only run after it.
    #[serde(default)]
    pub after_merge: crate::prim::UniqueList<CheckName, 0, TRAIN_CHECKS_MAX>,
}

impl TrainSettings {
    /// The checks the train waits for on a head into a base that requires `required`.
    pub fn fast_set(&self, required: &[String]) -> Vec<String> {
        let mut out: Vec<String> = required.to_vec();
        for c in self.fast_checks.iter() {
            let name = c.as_str();
            if !out.iter().any(|n| n == name)
                && !self.after_merge.iter().any(|a| a.as_str() == name)
            {
                out.push(name.to_string());
            }
        }
        out
    }

    /// Whether a failure of `name`, a check outside the fast set, is left for after the merge.
    pub fn after_merge_only(&self, name: &str) -> bool {
        self.after_merge.iter().any(|a| a.as_str() == name)
    }
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
        assert!(env_name_reserved("ANTHROPIC_BASE_URL"));
        assert!(env_name_reserved("CLAUDE_CODE_USE_BEDROCK"));
        assert!(env_name_reserved("CLAUDECODE"));
        assert!(!env_name_reserved("FLEETDX"));
        assert!(!env_name_reserved("DATABASE_URL"));
        assert!(EnvValue::new("a\0b").is_err());
        assert!(EnvValue::new("x".repeat(ENV_VALUE_MAX_BYTES + 1)).is_err());
        assert!(
            EnvValue::new("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n").is_ok()
        );
        assert_eq!(
            env_total_over(600 * 1024),
            "A project's variables take at most 512 KiB together; these would take 600 KiB."
        );
        assert!(EnvValue::new("").is_ok());
    }

    #[test]
    fn setup_takes_relative_inputs_and_defaults_its_limit() {
        let setup: WorktreeSetup =
            serde_json::from_str(r#"{"commands":["pnpm install"]}"#).unwrap();
        assert_eq!(setup.timeout_sec.get(), SETUP_TIMEOUT_DEFAULT_SEC);
        assert!(!setup.run_anyway);
        assert!(!setup.is_empty());
        assert!(WorktreeSetup::default().is_empty());
        for good in ["pnpm-lock.yaml", "app/desktop/pnpm-lock.yaml", ".nvmrc"] {
            assert!(SetupInput::new(good).is_ok(), "{good}");
        }
        for bad in ["", "/etc/passwd", "../x", "a//b", "a/./b", "a/"] {
            assert!(SetupInput::new(bad).is_err(), "{bad}");
        }
        assert!(serde_json::from_str::<WorktreeSetup>(r#"{"commands":["a\nb"]}"#).is_err());
        assert!(serde_json::from_str::<WorktreeSetup>(r#"{"timeoutSec":0}"#).is_err());
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
