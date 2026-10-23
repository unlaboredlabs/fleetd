use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The `--effort` claude runs at. Only [`TaskProfile`] picks one; nothing takes an effort as input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Max,
}

/// The one model every claude fleetd starts runs on, helper calls included.
pub const MODEL: &str = "claude-opus-5-5";

/// What an agent runs on. There are exactly two, both claude-opus-5-5: `high` (effort high) is the default and what
/// the lead, every reviewer and every helper call run; `medium` (effort medium) is for mechanical tasks the lead picks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TaskProfile {
    #[default]
    High,
    Medium,
}

impl TaskProfile {
    pub fn model(self) -> &'static str {
        MODEL
    }

    pub fn effort(self) -> Effort {
        match self {
            Self::High => Effort::High,
            Self::Medium => Effort::Medium,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
        }
    }

    /// The profile of a model and effort stored before profiles: claude-opus-5-5 at medium is medium, anything else
    /// is high.
    pub fn of(model: &str, effort: Effort) -> Self {
        if model == MODEL && effort == Effort::Medium {
            Self::Medium
        } else {
            Self::High
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_opus_at_medium_stays_medium() {
        assert_eq!(TaskProfile::of(MODEL, Effort::Medium), TaskProfile::Medium);
        assert_eq!(TaskProfile::of(MODEL, Effort::High), TaskProfile::High);
        for effort in [Effort::Low, Effort::Max] {
            assert_eq!(TaskProfile::of(MODEL, effort), TaskProfile::High);
        }
        assert_eq!(
            TaskProfile::of("claude-haiku-5-5", Effort::Medium),
            TaskProfile::High
        );
        assert_eq!(TaskProfile::default().effort(), Effort::High);
        assert_eq!(TaskProfile::Medium.model(), "claude-opus-5-5");
    }
}
