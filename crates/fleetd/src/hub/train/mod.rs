//! The merge train. Only fleetd merges: one serial train per repo has GitHub rebase each ready Change onto its base,
//! waits for CI on that head, posts `fleetd/train` and squash-merges pinned to it. Two or more ready Changes go as one
//! batch built on GitHub (`batch`).
pub mod batch;
pub mod calls;
pub mod contract;
pub mod digest;
pub mod flaky;
pub mod github;
pub mod host;
pub mod hub_host;
pub mod main_ci;
pub mod next;
pub mod records;
pub mod regen;
pub mod repo_checks;
pub mod reverts;
pub mod rules;
pub mod scheduled;
pub mod service;
pub mod tools;
pub mod watch;

#[cfg(test)]
mod tests;

pub use service::{Train, TrainOptions};
