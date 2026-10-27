use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;

/// How hard a model thinks: what a profile runs at, as a setting picks it or a node reports a session's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Max => "max",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [Self::Low, Self::Medium, Self::High, Self::Max]
            .into_iter()
            .find(|e| e.as_str() == text)
    }
}

/// What an agent runs on. There are exactly two: `high` is the default and what the lead, every reviewer and every
/// helper call run; `medium` is for mechanical tasks the lead picks. Each runs on its setting's model and effort
/// ([`ProfileSettings`]), else on the runner's own for it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TaskProfile {
    #[default]
    High,
    Medium,
}

impl TaskProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
        }
    }
}

brand!(
    /// A model as the runner's `--model` takes it: a full name (`claude-sonnet-5-5`), an alias (`sonnet`) or a
    /// gateway's own name. Whether the runner accepts it shows on the first agent that runs on it.
    ModelName,
    name = "ModelName",
    pattern = r"^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,79}$"
);

/// One profile's setting at one scope, the fleet or a project. An unset field falls through: a project's to the
/// fleet's, the fleet's to the runner's own (`claude-opus-5-5`, effort high for high and medium for medium).
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSetting {
    pub model: Option<ModelName>,
    pub effort: Option<Effort>,
    /// Set by the hub: claude refused `model`, so agents run as if it were unset until a person sets the model again.
    /// What claude said, and where. As input it only keeps the hub's own flag, passed back as read with the same
    /// model; anything else clears it.
    pub refused: Option<String>,
}

impl ProfileSetting {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.effort.is_none()
    }

    /// The model new agents may run on: none when unset or refused.
    pub fn usable_model(&self) -> Option<&ModelName> {
        self.model.as_ref().filter(|_| self.refused.is_none())
    }
}

/// Both profiles' settings at one scope.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSettings {
    #[serde(default)]
    pub high: ProfileSetting,
    #[serde(default)]
    pub medium: ProfileSetting,
}

impl ProfileSettings {
    pub fn get(&self, profile: TaskProfile) -> &ProfileSetting {
        match profile {
            TaskProfile::High => &self.high,
            TaskProfile::Medium => &self.medium,
        }
    }
}

/// What a new agent of one profile runs on, every scope applied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRun {
    pub model: String,
    pub effort: Effort,
}

/// What new agents of each profile run on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRuns {
    pub high: ProfileRun,
    pub medium: ProfileRun,
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
    fn a_refused_model_is_not_usable() {
        let mut s = ProfileSetting {
            model: Some(ModelName::unchecked("claude-x")),
            ..Default::default()
        };
        assert_eq!(s.usable_model().map(ModelName::as_str), Some("claude-x"));
        s.refused = Some("claude refused it".into());
        assert_eq!(s.usable_model(), None);
    }
}
