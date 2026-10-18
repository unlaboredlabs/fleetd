//! Liveness and motion: lanes, activity line, sparklines, machine and train strips, and the motion system.
//! Everything here renders from real hub data (`fleetd_contracts::live`); `fixture` exists for the bench and
//! screenshots only.

// The shell mounts these (spec §9); until it does, parts of the API have no caller. Drop this with that commit.
#![allow(dead_code)]

pub mod activity;
pub mod chips;
pub mod fixture;
pub mod lanes;
pub mod motion;
pub mod spark;
pub mod state;
pub mod strips;
