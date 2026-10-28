use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::Timestamp;
use crate::prim::{Line, Positive};

/// How hard a model thinks: what a profile runs at, as Claude Code's `--effort` takes it, or a node reports a
/// session's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub const ALL: [Self; 5] = [Self::Low, Self::Medium, Self::High, Self::Xhigh, Self::Max];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|e| e.as_str() == text)
    }
}

brand!(
    /// A task profile's name, as `spawn_agent`'s `profile` takes it: lowercase letters, digits, `-`, `_` and `.`.
    /// Tasks and time spans keep the name they ran on.
    ProfileName,
    name = "ProfileName",
    pattern = r"^[a-z0-9][a-z0-9._-]{0,31}$"
);

impl ProfileName {
    /// What a task stored before profiles reads as: the hub migrated every one to `high` or `medium`.
    pub fn legacy() -> Self {
        Self::unchecked("high")
    }
}

brand!(
    /// A model as the runner's `--model` takes it: a full name (`claude-sonnet-5-5`), an alias (`sonnet`) or a
    /// gateway's own name. Whether the runner accepts it shows on the first agent that runs on it.
    ModelName,
    name = "ModelName",
    pattern = r"^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,79}$"
);

/// The most profiles a hub keeps.
pub const PROFILES_MAX: usize = 50;

/// A profile's row id: stays the same through a rename.
pub type ProfileId = Positive;

/// One task profile (Settings › Hub › Every project › Profiles): what an agent on it runs on. Exactly one is the hub's default, which
/// every project allows and the lead, every review and claude's helper calls run on.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: ProfileId,
    pub name: ProfileName,
    /// What it is for, in one line; the lead reads it to pick one.
    pub note: Line<0, 300>,
    pub model: ModelName,
    pub effort: Effort,
    /// Claude Code's fast mode (`fastMode`), only on a model that has it.
    pub fast: bool,
    pub default: bool,
    /// Set by the hub: claude refused `model`, so its agents run on the runner's own model until a person sets the
    /// model again. What claude said, and where.
    pub refused: Option<String>,
    pub updated_at: Timestamp,
}

impl Profile {
    /// The model new agents may run on: none when refused, and the runner's own runs.
    pub fn usable_model(&self) -> Option<&ModelName> {
        self.refused.is_none().then_some(&self.model)
    }
}

/// A model a profile may pick (`profiles_list`).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileModel {
    pub id: ModelName,
    pub display_name: Option<String>,
    /// Claude Code offers fast mode on it.
    pub fast: bool,
}

/// Where the model list came from: the Models API on the hub's API key, or fleetd's own list of current Claude
/// models.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
    Api,
    Builtin,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_model_name_is_one_word_of_a_model_s_characters() {
        for ok in [
            "claude-sonnet-5-5",
            "sonnet",
            "claude-opus-5-5[1m]",
            "us.anthropic.claude-opus-5-5-v1:0",
        ] {
            assert!(ModelName::new(ok).is_ok(), "{ok}");
        }
        for bad in ["", " sonnet", "claude opus", "-x", &"m".repeat(81)] {
            assert!(ModelName::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_profile_name_is_a_short_lowercase_word() {
        for ok in ["high", "medium", "fast-opus", "sonnet_4.6", "x1"] {
            assert!(ProfileName::new(ok).is_ok(), "{ok}");
        }
        for bad in ["", "High", "two words", "-x", &"p".repeat(33)] {
            assert!(ProfileName::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn effort_reads_back_every_level_claude_code_takes() {
        for e in Effort::ALL {
            assert_eq!(Effort::parse(e.as_str()), Some(e));
        }
        assert_eq!(Effort::parse("ultra"), None);
    }
}
