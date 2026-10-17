//! The retro (M12): self-improving playbooks, advise-only until `policy.retro.apply`. TS spec: apps/hub/src/retro.
pub mod diff;
pub mod digest;
pub mod metrics;
pub mod records;
pub mod service;
pub mod tools;
pub mod types;
pub mod validate;

pub use service::{APPLY_KEY, Retro, RetroDeps, RetroRefused, RunInput};
