//! The doctor (M11): live setup checks, each failing one with the command that fixes it.
pub mod checks;
pub mod config;
pub mod service;
pub mod tools;

pub use service::{Doctor, DoctorDeps, DoctorFleet, DoctorRefused, DoctorResults, T3Settings};
