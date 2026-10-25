//! M4 usage clarity: limit classes, parked work, the per-login breaker and the usage_status view. fleetd never calls
//! a model or usage API; everything here is read off the runner's failures and the login kind it reports.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::events::HubEvent;
use crate::ids::{MachineId, Timestamp};
use crate::prim::{Count, List};

/// What stopped a turn. `usage_limit`: the plan's usage limit or a proxy's quota cooldown. `rate_limit`: a 429, or a
/// proxy resting its credentials after one.
/// `pool_exhausted`: the user's proxy has no account for the model; it waits for usage_resume.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UsageClass {
    UsageLimit,
    RateLimit,
    PoolExhausted,
}

/// Read from the runner's login kind, never from credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LoginKind {
    Subscription,
    ApiKey,
    CustomBaseUrl,
    Unknown,
}

/// A task or lead whose thread hit a limit; fleetd sends it one "continue" at `resume_at`, or at `check_at` to see
/// whether the login has capacity again, or as soon as another turn on the login succeeds.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageParked {
    pub class: UsageClass,
    pub since: Timestamp,
    /// The reset the limit's message named. Absent when it named none (see `check_at`), and for pool_exhausted,
    /// which resumes on usage_resume.
    pub resume_at: Option<Timestamp>,
    /// A limit that named no reset: when fleetd next tries the thread, 1, 2, 5, 10 and then every 15 minutes.
    pub check_at: Option<Timestamp>,
    /// A proxy in front of the login decided the limit (its credentials for the model are cooling down).
    pub proxy: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BreakerState {
    Closed,
    Open,
}

/// Open: no new turns start on the machine's login until `until`, a check or another turn on the login succeeds,
/// or usage_resume.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreaker {
    pub state: BreakerState,
    pub class: Option<UsageClass>,
    pub since: Option<Timestamp>,
    /// The reset the limits named. Absent while open: `check_at`, else until usage_resume (pool_exhausted).
    pub until: Option<Timestamp>,
    /// No reset named: when fleetd next sends one parked thread "continue" to see whether the login has capacity.
    pub check_at: Option<Timestamp>,
    /// A proxy in front of the login decided the limit.
    pub proxy: Option<bool>,
    /// The plain notice, as the usage.breaker event said it.
    pub message: Option<String>,
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
    /// usage.breaker: no reset named, so fleetd checks the login at this time.
    pub check_at: Option<Timestamp>,
    pub model: Option<String>,
    /// usage.breaker: a proxy in front of the login decided the limit.
    pub proxy: Option<bool>,
    pub parked: Option<ParkedCounts>,
    /// usage.resumed: the breaker was open and is now closed.
    pub breaker_cleared: Option<bool>,
    /// usage.resumed: "reset", "check" (fleetd tried one parked thread), "turn" (a turn on the login succeeded), or
    /// who ran usage_resume.
    pub by: Option<String>,
    /// usage.resumed: a check of an open breaker; the one thread listed is the one tried, and the breaker stays open
    /// until it gets through.
    pub check: Option<bool>,
    /// usage.resumed: the threads sent "continue", in the order they were sent.
    pub threads: Option<Vec<UsageEventThread>>,
}
