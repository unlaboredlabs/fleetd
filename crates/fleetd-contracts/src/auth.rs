use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, Timestamp};
use crate::prim::NonEmpty;
use crate::{brand, literal};

literal!(
    /// `"*"`: every machine.
    Star = "*"
);

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Read,
    Operate,
    Admin,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum GrantMachines {
    All(Star),
    Only(Vec<MachineId>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Grant {
    pub role: Role,
    pub machines: GrantMachines,
}

brand!(
    /// "fld_" plus the first 6 characters of the key's lowercase base32 body.
    AgentKeyPrefix,
    pattern = r"^fld_[a-z2-7]{6}$"
);

/// "human": a person's device, such as the desktop app. What it answers is recorded as the human's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum KeyKind {
    #[default]
    Agent,
    Human,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentKeyInfo {
    pub key_id: NonEmpty,
    pub name: String,
    /// Absent means "agent".
    pub kind: Option<KeyKind>,
    pub prefix: AgentKeyPrefix,
    pub grants: Vec<Grant>,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
}
