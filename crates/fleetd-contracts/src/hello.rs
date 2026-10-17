use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize};

/// Version of the hub <-> node/app/cli wire protocol. Bump on any breaking change to a schema in this crate; peers
/// refuse a hello whose version they do not speak.
pub const PROTOCOL_VERSION: i64 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct ProtocolVersion(i64);

impl ProtocolVersion {
    pub const CURRENT: Self = Self(PROTOCOL_VERSION);

    pub fn new(value: i64) -> Result<Self, String> {
        if value >= 1 {
            Ok(Self(value))
        } else {
            Err("expected an integer of at least 1".into())
        }
    }
    pub fn get(self) -> i64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = crate::prim::AnyInt::deserialize(d)?;
        Self::new(value.get()).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for ProtocolVersion {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "ProtocolVersion".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": 1, "maximum": crate::prim::MAX_SAFE_INT })
    }
}
