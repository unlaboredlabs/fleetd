//! A Rust client for stock T3 Code's WebSocket RPC at the pinned commit (`vendor/t3/pin.json`), covering exactly
//! the methods fleetd uses (`methods::USED`).
pub mod client;
pub mod frame;
pub mod methods;
pub mod types;

pub use client::{Error, Subscription, T3Client};
