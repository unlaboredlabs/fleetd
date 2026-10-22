//! The merge train. Only fleetd merges: one serial train per repo rebases each ready Change
//! onto its base, waits for CI on that head, posts `fleetd/train` and squash-merges pinned to it. Disjoint ready
//! Changes go as one batch (`batch`), and a PR stacked on a queued one is tested ahead on its parent (`stack`).
pub mod batch;
pub mod calls;
pub mod contract;
pub mod digest;
pub mod git;
pub mod github;
pub mod hooks;
pub mod host;
pub mod hub_host;
pub mod main_ci;
pub mod records;
pub mod rules;
pub mod service;
pub mod stack;
pub mod time;
pub mod tools;
pub mod triggers;

#[cfg(test)]
mod tests;

pub use service::{Train, TrainOptions};
