//! The doctor (M11): every setup check, live, each with a plain message and at most one fix.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::MachineId;
use crate::prim::Text;

brand!(
    /// Stable per check: `hub/<name>` or `<machineId>/<name>`, e.g. `hub/gh_auth`, `lab-a/disk`.
    DoctorCheckId,
    name = "DoctorCheckId",
    pattern = r"^[a-z0-9-]{1,32}/[a-z0-9_]{1,40}$"
);

/// `unknown`: the hub could not look (machine offline, nothing to read).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    Ok,
    Warn,
    Fail,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DoctorFixKind {
    Auto,
    Manual,
}

/// `auto`: doctor_fix runs it. `manual`: a person runs `command` (where the label says).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DoctorFix {
    pub kind: DoctorFixKind,
    pub label: Text<0, 200>,
    pub command: Option<Text<0, 500>>,
    /// Where `command` runs: `hub` on the hub's machine, `machine` on the check's machine. Absent from a hub before
    /// it: where the label says.
    pub on: Option<DoctorScope>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DoctorScope {
    Hub,
    Machine,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: DoctorCheckId,
    pub scope: DoctorScope,
    /// Set when scope is machine.
    pub machine_id: Option<MachineId>,
    pub status: DoctorStatus,
    /// Plain language.
    pub message: Text<0, 500>,
    /// Absent when there is nothing to do.
    pub fix: Option<DoctorFix>,
}
