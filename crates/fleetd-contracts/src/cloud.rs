//! Cloud machines on boat.dev (D306): what the app shows of the hub's pool (hub/pool) and what an admin sets. Each hub
//! uses its owner's own boat key, sealed in the app to the hub's own box key; no key or secret crosses back.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectRef};

/// Where a cloud machine is in its life, as the hub's ledger has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum CloudMachineState {
    /// Created, setting up; not yet heard from.
    Creating,
    /// Resumed; not yet heard from.
    Waking,
    Awake,
    /// A stop was sent; asleep once boat.dev says so.
    Stopping,
    Asleep,
    /// Two wakes in a row brought no hello: never woken again until an admin resets it.
    Broken,
    /// Its create failed, or it never joined.
    Failed,
    /// boat.dev no longer has it: it needs a new create.
    Gone,
}

/// One machine of the pool.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudMachine {
    /// Also its slot: `boat-1`.
    pub machine_id: MachineId,
    pub state: CloudMachineState,
    /// Agent runs going there now, from its node's last heartbeat.
    pub agents: u32,
    /// Screens live there now.
    pub screens: u32,
    /// Dollars of machine time today, in the hub's time zone.
    pub today: f64,
    /// Since when it is in its state (ms): awake since, asleep since.
    pub since_ms: Option<i64>,
    /// Why it is in its state, in one line: boat's setup error, the stop's reason.
    pub note: Option<String>,
}

/// A size boat.dev offers, with its list price.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudSize {
    /// boat's `type`: `small`, `default`, `large`, `xlarge`.
    pub kind: String,
    pub per_hour: f64,
}

/// What the last Test (or sweep) heard from boat.dev with the hub's key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudKeyTest {
    pub ok: bool,
    /// "Key works: $20 plan · 200 starts a day (12 a minute) · 0 of 100 machines running", or boat's refusal in plain
    /// words.
    pub said: String,
}

/// The hub's pool: its settings, its machines and what they cost.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudView {
    /// A boat.dev key is saved, sealed to the hub. It is never shown.
    pub has_key: bool,
    /// Work may go to cloud machines. The kill switch turns it off.
    pub enabled: bool,
    pub pool_size: u32,
    pub machine_type: String,
    pub day_budget: f64,
    /// The month budget in effect: the admin's, else the plan's included dollars.
    pub month_budget: f64,
    /// The month budget follows the plan's included dollars (none set).
    pub month_is_plan: bool,
    /// The boat environment machines are created in.
    pub environment: Option<String>,
    /// The environment the setup step has the admin make, `fleetd-<hub>`: what the field starts with.
    pub environment_default: String,
    /// The projects whose work may run on cloud machines.
    pub projects: Vec<ProjectRef>,
    /// Writers may run there too; reviews and readers always may.
    pub writers: bool,
    /// Dollars spent today and this month, in the hub's time zone.
    pub today: f64,
    pub month: f64,
    /// Why no machine may start now, in one line: the pool off, a budget spent, boat's backoff. Absent: it may.
    pub held: Option<String>,
    /// A billing or key pause that only boat's next "can start" or an admin's Resume lifts.
    pub paused: Option<String>,
    pub key_test: Option<CloudKeyTest>,
    pub machines: Vec<CloudMachine>,
    pub sizes: Vec<CloudSize>,
    /// What the plan includes a month, as boat.dev last said.
    pub plan_dollars: Option<f64>,
    /// The address cloud machines reach the hub at: its public HTTPS address.
    pub hub_url: Option<String>,
    /// Why cloud machines can't reach the hub, when they can't: no HTTPS address.
    pub network: Option<String>,
    /// This hub's X25519 key, standard base64: what the boat key is sealed to (`crypto_box_seal`) for cloud_key_set.
    pub box_pub_key: String,
}

/// The settings an admin changes (Settings › Hub › Machines › Cloud machines, the setup step).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettings {
    pub enabled: bool,
    /// 1 to [`POOL_MAX`].
    pub pool_size: u32,
    pub machine_type: String,
    /// Dollars a day, above 0.
    pub day_budget: f64,
    /// Dollars a month; absent: the plan's included dollars.
    pub month_budget: Option<f64>,
    #[serde(default)]
    pub projects: Vec<ProjectRef>,
    pub environment: Option<String>,
    /// Writers may run there too; absent keeps what is set.
    pub writers: Option<bool>,
}

/// The most machines a pool holds.
pub const POOL_MAX: u32 = 10;
/// The most a day or month budget may be, in dollars: a typo's guard, far above any pool's ceiling.
pub const BUDGET_MAX: f64 = 1000.0;
