use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};

use crate::brand;

brand!(
    /// Stable machine id chosen at enrollment, e.g. "forge".
    MachineId, name = "MachineId", pattern = r"^[a-z0-9-]{1,32}$", description = "Machine slug, [a-z0-9-]{1,32}"
);
brand!(
    /// The node's project id on one machine. Only unique together with a MachineId.
    ProjectId, name = "ProjectId", check = |s| !s.is_empty(), expected = "a non-empty string"
);
brand!(
    /// The node's thread id on one machine. Only unique together with a MachineId.
    ThreadId, name = "ThreadId", check = |s| !s.is_empty(), expected = "a non-empty string"
);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub machine_id: MachineId,
    pub project_id: ProjectId,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRef {
    pub machine_id: MachineId,
    pub thread_id: ThreadId,
}

/// ISO 8601 UTC timestamp string. Not checked on decode.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Timestamp(pub String);

impl Timestamp {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Timestamp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for Timestamp {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Timestamp {
    fn from(value: &str) -> Self {
        Self(value.into())
    }
}

impl JsonSchema for Timestamp {
    fn schema_name() -> Cow<'static, str> {
        "Timestamp".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "format": "date-time" })
    }
}

/// Hub-global event sequence number; also the events cursor.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct EventSeq(pub crate::prim::Count);

impl EventSeq {
    pub fn new(value: i64) -> Result<Self, String> {
        crate::prim::Count::new(value).map(Self)
    }
    pub fn get(self) -> i64 {
        self.0.get()
    }
}

impl JsonSchema for EventSeq {
    fn schema_name() -> Cow<'static, str> {
        "EventSeq".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": 0, "maximum": crate::prim::MAX_SAFE_INT })
    }
}
