//! What fleetd says about claude outside the adapter: the model each profile runs on when no setting chose one, and the
//! words and commands a person reads ([`RunnerGuide`]).
use fleetd_contracts::effort::{Effort, ProfileName};
use fleetd_contracts::sessions::RunnerInfo;

use super::setup::ClaudeSetup;
use super::{ALWAYS_DISALLOWED, failure, version};
use crate::node::runner::{ProfileModel, RunnerGuide};

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

impl RunnerGuide for Guide {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn product(&self) -> &'static str {
        "Claude Code"
    }

    fn install(&self) -> String {
        version::INSTALL.to_owned()
    }

    fn install_tested(&self) -> String {
        format!("{} -s {}", version::INSTALL, version::TESTED)
    }

    fn pin_tested(&self) -> String {
        format!("claude install {}", version::TESTED)
    }

    fn login_fix(&self, proxy: bool) -> &'static str {
        failure::login_fix(proxy)
    }

    fn version_problem(&self, found: &str) -> Option<(String, Option<String>)> {
        let verdict = version::check(found);
        Some((verdict.problem(found)?, verdict.fix()))
    }

    fn setup(&self, info: &RunnerInfo) -> String {
        ClaudeSetup::from_info(info).to_string()
    }

    fn protocol(&self) -> &'static str {
        "the stream-json protocol"
    }

    fn denied_tools(&self) -> &'static [&'static str] {
        ALWAYS_DISALLOWED
    }

    fn profile(&self, p: &ProfileName) -> ProfileModel {
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
