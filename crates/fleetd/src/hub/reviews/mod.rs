//! The train's review gate: one fresh review per patch.
pub mod patch_ids;
pub mod rules;
pub mod service;
pub mod verdicts;

pub use service::{REVIEWS_BY, Reviews, build};
