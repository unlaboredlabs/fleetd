use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// How hard a model thinks, as a node reports a session's. Only the runner picks one, from the session's
/// [`TaskProfile`]; nothing takes an effort as input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Max,
}

/// What an agent runs on. There are exactly two: `high` is the default and what the lead, every reviewer and every
/// helper call run; `medium` is for mechanical tasks the lead picks. The node's runner picks the model and effort of
/// each.
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
