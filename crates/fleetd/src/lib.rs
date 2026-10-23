//! The fleetd binary's library: the hub, the per-machine node and the CLI. One owner per module; see
//! `hub/mod.rs` for the hub's areas.
pub mod cli;
pub mod clock;
pub mod home;
pub mod hub;
pub mod node;
pub mod tiles;

/// The version the release build baked in (`FLEETD_VERSION`, e.g. `0.4.0` or `0.4.0-nightly.202610221107+333368c`),
/// or the crate version (`0.0.0`) for a local build. The CLI, the hub and the node all report this one.
pub fn version() -> &'static str {
    option_env!("FLEETD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}
