//! `POST <hub>/pair`: a device trades a one-time code from `fleetd pair` for a human key. No auth header; the code
//! is the credential. `POST <hub>/pair/mac` trades the agents' Mac's 6-digit setup code the same way.

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
    /// A Mac setup code for an agents' Mac that is another computer: that one is removed first.
    MacOtherComputer,
}

/// The 4xx body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PairError {
    pub code: PairErrorCode,
    pub message: String,
    pub fix: String,
}

/// `POST <hub>/pair/mac`: the fleetd app on the agents' Mac trades the 6-digit code Add machine › A Mac for agents
/// shows for a one-time enroll token of the hub's agents' Mac. No auth header; the code is the credential.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacCodeRequest {
    /// Six digits; spaces and a hyphen are ignored.
    pub code: String,
    /// The Mac's computer fingerprint, as its node will send it: a code for an agents' Mac that is another computer
    /// is refused before it is used.
    pub fingerprint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacCodeResponse {
    /// Where the Mac reaches the hub from now on.
    pub hub_url: String,
    pub hub_name: String,
    /// The machine id the Mac joins as: the hub's agents' Mac, or `mac` for the first one.
    pub machine_id: String,
    /// One-time enroll token for `machine_id` (`fleetd init --join … --code`), valid for 15 minutes.
    pub token: String,
    pub expires_at: String,
    /// The fleetd version the hub runs: the Mac installs the same build.
    pub version: String,
    /// The hub has a machine of that id already: the Mac enrolls it again (`--rejoin`), replacing it in place.
    pub existing: bool,
}
