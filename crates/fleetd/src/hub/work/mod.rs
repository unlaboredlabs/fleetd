//! The work ledger: what is in flight across leads, agents and people's own sessions, checked before work starts
//! (W9). The name `ledger` is taken by the decision log.
pub mod matcher;

#[cfg(test)]
mod matcher_tests;
