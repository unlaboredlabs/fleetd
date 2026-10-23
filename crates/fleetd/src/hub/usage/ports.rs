//! What the ops areas (usage, doctor, approvals) take from other hub areas, as narrow traits. The wiring in
//! `hub/serve` implements them over the real services; tests implement them with fakes.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

use fleetd_contracts::events::HubEvent;

/// An event to append: everything but `seq`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewEvent {
    pub at: String,
    pub kind: String,
    pub machine_id: Option<String>,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub summary: String,
    pub data: Option<Value>,
    pub attention: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct WaitInput {
    pub cursor: u64,
    pub types: Vec<&'static str>,
    pub machine_id: Option<String>,
    pub timeout_sec: u64,
}

#[derive(Clone, Debug, Default)]
pub struct WaitPage {
    pub events: Vec<HubEvent>,
    pub cursor: u64,
    pub more: bool,
}

/// The hub-global, append-only event log.
pub trait EventLog: Send + Sync {
    /// Trims `summary` to 200 characters and drops a `data` over 2 KB of JSON.
    fn append(&self, event: NewEvent) -> BoxFut<'_, HubEvent>;
    fn head(&self) -> BoxFut<'_, u64>;
    /// Returns at once if matching events exist after `cursor`, otherwise waits up to `timeout_sec` for one.
    fn wait(&self, input: WaitInput) -> BoxFut<'_, WaitPage>;
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRef {
    pub machine_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub machine_id: String,
    pub project_id: String,
}
