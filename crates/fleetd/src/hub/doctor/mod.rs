//! The doctor (M11): live setup checks with safe automatic fixes.
pub mod checks;
pub mod config;
pub mod service;
pub mod tools;

pub use service::{Doctor, DoctorDeps, DoctorFleet, DoctorRefused, DoctorResults, T3Settings};
