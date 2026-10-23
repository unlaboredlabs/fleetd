//! The contract types this area uses, from `fleetd-contracts`, plus the string forms the hub prints them in.
pub use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
pub use fleetd_contracts::lead_calls::ChangeEnqueueCall;
pub use fleetd_contracts::ledger::{Tier, WorkstreamId};
pub use fleetd_contracts::prim::{Count, NonEmpty, Positive, Text};
pub use fleetd_contracts::tasks::TaskId;
pub use fleetd_contracts::train::{
    Change, ChangeId, ChangeReview, ChangeState, GitHubPrUrl, GitHubRepo, PatchId, TrainState,
    parse_pr_url,
};
pub use fleetd_contracts::verification::CommitSha;

pub fn tier_str(tier: Tier) -> &'static str {
    match tier {
        Tier::S => "S",
        Tier::M => "M",
        Tier::L => "L",
    }
}

pub fn state_str(state: ChangeState) -> &'static str {
    match state {
        ChangeState::Queued => "queued",
        ChangeState::Reviewing => "reviewing",
        ChangeState::Ready => "ready",
        ChangeState::Rebasing => "rebasing",
        ChangeState::Ci => "ci",
        ChangeState::Merging => "merging",
        ChangeState::Merged => "merged",
        ChangeState::NeedsRebase => "needs_rebase",
        ChangeState::CiFailed => "ci_failed",
        ChangeState::Refused => "refused",
        ChangeState::Abandoned => "abandoned",
    }
}

pub fn parse_state(s: &str) -> Option<ChangeState> {
    serde_json::from_value(serde_json::Value::String(s.into())).ok()
}

pub use fleetd_contracts::playbooks::ReviewRule;

/// `lastError` as stored: at most 2000 characters, as error_text and note cut it.
pub fn last_error(text: impl Into<String>) -> Text<0, 2000> {
    Text::unchecked(text)
}
