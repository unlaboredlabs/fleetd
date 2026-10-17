//! The fleetd binary's library: the hub, the per-machine node and the CLI. One owner per module; see
//! `hub/mod.rs` for the hub's areas.
pub mod cli;
pub mod clock;
pub mod hub;
pub mod node;
