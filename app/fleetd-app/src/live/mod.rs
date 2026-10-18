//! Liveness and motion: lanes, activity line, sparklines, machine and train strips, and the motion system.
//! Everything here renders from real hub data (`fleetd_contracts::live`); `fixture` exists for the bench and
//! screenshots only.

pub mod activity;
pub mod chips;
pub mod fixture;
pub mod fleet;
pub mod lanes;
pub mod motion;
pub mod spark;
pub mod stage;
pub mod state;
pub mod strips;
