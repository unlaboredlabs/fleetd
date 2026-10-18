//! `POST <hub>/pair`: a device trades a one-time code from `fleetd pair` for a human key. No auth header; the code
//! is the credential.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    /// `XXXX-XXXX`, any case, hyphen optional.
    pub code: String,
    /// Names the new key; absent falls back to the `--name` given to `fleetd pair`.
    pub device_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    /// A new human key (`fld_…`), shown only this once.
    pub key: String,
    pub hub_url: String,
    pub hub_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PairErrorCode {
    /// Unknown or already used.
    PairCodeInvalid,
    PairCodeExpired,
    /// 5 failed attempts in a minute from one address.
    PairRateLimited,
    /// The body is not a `PairRequest`.
    Invalid,
}

/// The 4xx body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PairError {
    pub code: PairErrorCode,
    pub message: String,
    pub fix: String,
}
