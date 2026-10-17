//! M4 usage clarity: limit classes, parked work, the per-login breaker and the usage_status view. fleetd never calls
//! a model or usage API; everything here is read off T3's thread errors, its provider status and its trace file.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::events::HubEvent;
use crate::ids::{MachineId, Timestamp};
use crate::prim::{Count, List};

/// What stopped a turn. `usage_limit`: the plan's usage limit or a proxy cooldown, with a reset. `rate_limit`: a 429.
/// `pool_exhausted`: the user's proxy has no account for the model; it waits for usage_resume.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UsageClass {
    UsageLimit,
    RateLimit,
    PoolExhausted,
}

/// Read from the T3 provider instance status and its env var names, never from credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LoginKind {
    Subscription,
    ApiKey,
    CustomBaseUrl,
    Unknown,
}

/// A task or lead whose thread hit a limit; fleetd sends it one "continue" at `resume_at`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageParked {
    pub class: UsageClass,
    pub since: Timestamp,
    /// Absent for pool_exhausted: it resumes on usage_resume.
    pub resume_at: Option<Timestamp>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BreakerState {
    Closed,
    Open,
}

/// Open: no new turns start on the machine's login until `until` or usage_resume.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreaker {
    pub state: BreakerState,
    pub class: Option<UsageClass>,
    pub since: Option<Timestamp>,
    /// Absent while open means until usage_resume.
    pub until: Option<Timestamp>,
    /// The plain notice, as the usage.breaker event said it.
    pub message: Option<String>,
}

/// Direct usage or reset-credit calls seen in the machine's T3 trace file. Must be 0.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCounter {
    pub observable: bool,
    pub count: Option<Count>,
    /// The trace directory read, when observable.
    pub source: Option<String>,
    /// Why it is not observable.
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ParkedCounts {
    pub leads: Count,
    pub tasks: Count,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    pub machine_id: MachineId,
    pub login: LoginKind,
    pub breaker: UsageBreaker,
    pub parked: ParkedCounts,
    /// The latest thread.usage_limited, usage.breaker and usage.resumed events for the machine, oldest first.
    pub last_events: List<HubEvent, 0, 10>,
    pub probes: ProbeCounter,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageEventThread {
    pub thread_id: String,
    pub kind: String,
    pub task_id: Option<String>,
}

/// Fields `HubEvent.data` carries on usage.breaker and usage.resumed.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageEventData {
    pub class: Option<UsageClass>,
    pub until: Option<Timestamp>,
    pub model: Option<String>,
    pub parked: Option<ParkedCounts>,
    /// usage.resumed: the breaker was open and is now closed.
    pub breaker_cleared: Option<bool>,
    /// usage.resumed: "reset", or who ran usage_resume.
    pub by: Option<String>,
    /// usage.resumed: the threads sent "continue", in the order they were sent.
    pub threads: Option<Vec<UsageEventThread>>,
}
