//! The Claude adapter: one `claude -p --input-format stream-json --output-format stream-json` process per live
//! session, spawned in its own process group with a scrubbed environment.
pub mod protocol;

use std::path::PathBuf;

use fleetd_contracts::sessions::{RunnerInfo, RunnerKind};

use super::{BoxFut, Runner, RunnerError, SessionHandle, SessionSpec};

/// Tools no fleetd session gets: subagent fan-out stays under fleetd's slots, and nobody is at a terminal to answer
/// AskUserQuestion (agents use `fleetd ask`).
pub const ALWAYS_DISALLOWED: &[&str] = &["Task", "Workflow", "AskUserQuestion"];

pub struct ClaudeRunner {
    /// The `claude` binary, resolved once at node start.
    pub binary: PathBuf,
}

impl ClaudeRunner {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    /// The full argv after the binary for `spec`.
    pub fn args(&self, _spec: &SessionSpec) -> Vec<String> {
        todo!("runner core slice")
    }
}

impl Runner for ClaudeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Claude
    }

    fn probe(&self) -> BoxFut<'_, RunnerInfo> {
        todo!("runner failure and version slice")
    }

    fn spawn(&self, _spec: SessionSpec) -> Result<SessionHandle, RunnerError> {
        todo!("runner core slice")
    }
}
