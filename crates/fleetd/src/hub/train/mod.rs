//! The merge train (TS: apps/hub/src/train). Only fleetd merges: one serial train per repo rebases each ready Change
//! onto its base, waits for CI on that head, posts `fleetd/train` and squash-merges pinned to it.
pub mod calls;
pub mod contract;
pub mod digest;
pub mod git;
pub mod github;
pub mod host;
pub mod hub_host;
pub mod records;
pub mod rules;
pub mod service;
pub mod time;
pub mod tools;

#[cfg(test)]
mod tests;

pub use service::{ReviewGate, TRAIN_BY, Train, TrainError, TrainOptions, Verdict};
