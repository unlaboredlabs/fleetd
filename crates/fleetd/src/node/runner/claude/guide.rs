//! What fleetd says about claude outside the adapter: the model each profile runs on when no setting chose one, and the
//! words and commands a person reads ([`Guide`]).
use fleetd_contracts::effort::{Effort, ProfileName};
use fleetd_contracts::sessions::RunnerInfo;

use super::setup::ClaudeSetup;
use super::{ALWAYS_DISALLOWED, failure, version};
use crate::node::runner::ProfileModel;

/// The model every claude fleetd starts runs on, helper calls included, unless a profile's setting chose another.
pub const MODEL: &str = "claude-opus-5-5";

/// A profile's own, where the hub sent no model or claude refused it: every one on [`MODEL`], `medium` at effort
/// medium and any other at high, as the first two profiles ran.
pub fn profile(profile: &ProfileName) -> ProfileModel {
    ProfileModel {
        model: MODEL,
        effort: if profile == "medium" {
            Effort::Medium
        } else {
            Effort::High
        },
    }
}

/// The profile of a model and effort stored before profiles: [`MODEL`] at medium is medium, anything else is high.
pub fn profile_of(model: &str, effort: Effort) -> ProfileName {
    ProfileName::unchecked(if model == MODEL && effort == Effort::Medium {
        "medium"
    } else {
        "high"
    })
}

pub struct Guide;

pub static GUIDE: Guide = Guide;

/// What a person reads and runs about claude, from what its probe reported ([`RunnerInfo`]).
impl Guide {
    /// The runner's command as messages name it, e.g. "claude"; also the prefix of its doctor checks.
    pub fn name(&self) -> &'static str {
        "claude"
    }

    /// What a person installs, e.g. "Claude Code".
    pub fn product(&self) -> &'static str {
        "Claude Code"
    }

    /// The command that installs it on a machine without it.
    pub fn install(&self) -> String {
        version::INSTALL.to_owned()
    }

    /// The command that installs exactly the tested version, from nothing.
    pub fn install_tested(&self) -> String {
        format!("{} -s {}", version::INSTALL, version::TESTED)
    }

    /// The command that puts the tested version over an installed one.
    pub fn pin_tested(&self) -> String {
        format!("claude install {}", version::TESTED)
    }

    /// How to log it in; behind a proxy, the proxy holds the login.
    pub fn login_fix(&self, proxy: bool) -> &'static str {
        failure::login_fix(proxy)
    }

    /// A version fleetd wasn't tested with: what to say about `found` and the command that fixes it. None when
    /// tested.
    pub fn version_problem(&self, found: &str) -> Option<(String, Option<String>)> {
        let verdict = version::check(found);
        Some((verdict.problem(found)?, verdict.fix()))
    }

    /// The setup sessions use, in a person's words: version, login, proxy, config dir.
    pub fn setup(&self, info: &RunnerInfo) -> String {
        ClaudeSetup::from_info(info).to_string()
    }

    /// The protocol the probe checks it speaks, e.g. "the stream-json protocol".
    pub fn protocol(&self) -> &'static str {
        "the stream-json protocol"
    }

    /// The tools no session of this runner ever gets.
    pub fn denied_tools(&self) -> &'static [&'static str] {
        ALWAYS_DISALLOWED
    }

    /// The model and effort a profile runs on when no setting chose them ([`Runner::profile`]).
    pub fn profile(&self, p: &ProfileName) -> ProfileModel {
        profile(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_opus_at_medium_stays_medium() {
        assert_eq!(profile_of(MODEL, Effort::Medium), "medium");
        assert_eq!(profile_of(MODEL, Effort::High), "high");
        for effort in [Effort::Low, Effort::Xhigh, Effort::Max] {
            assert_eq!(profile_of(MODEL, effort), "high");
        }
        assert_eq!(profile_of("claude-haiku-5-5", Effort::Medium), "high");
        assert_eq!(
            profile(&ProfileName::unchecked("high")).effort,
            Effort::High
        );
        assert_eq!(
            profile(&ProfileName::unchecked("medium")).model,
            "claude-opus-5-5"
        );
        assert_eq!(
            profile(&ProfileName::unchecked("sonnet")).effort,
            Effort::High
        );
    }

    #[test]
    fn the_tested_install_is_the_installer_pinned() {
        assert_eq!(
            GUIDE.install_tested(),
            "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.314"
        );
    }
}
