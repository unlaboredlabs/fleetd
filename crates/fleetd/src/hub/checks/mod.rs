//! Checks runner and claims: `fleetd claim done` runs a workstream's frozen done-when checks, and only all of them
//! passing makes it done. TS spec: apps/hub/src/checks/**.
//!
//! The hub holds `NodeCommands` (shared with the node link, the train, approvals and the doctor), `GitHub` (shared
//! with the train, reviews, finish-all and the doctor), `JudgeVerdicts` (completed by the value bar), `CheckRunner`
//! (also approvals' `verify`) and `Claims`.
pub mod claims;
pub mod github;
pub mod judges;
pub mod node_commands;
pub mod ports;
pub mod records;
pub mod render;
pub mod runner;
pub mod tools;

pub use claims::{ClaimDoneOutcome, Claims, FALSE_CLAIM_AT, INLINE_WAIT};
pub use github::{GH_AUTH_FIX, GhCli, GhError, GhErrorKind, GhRunner, GitHub};
pub use judges::{JUDGE_BY, JudgeVerdicts, Judges};
pub use node_commands::{CommandInput, CommandOutcome, LinkGuard, NodeAction, NodeCommandError, NodeCommands, NodeSend};
pub use records::{ClaimFilter, ClaimRecords};
pub use runner::{CLAIMS_BY, CheckRunner, CheckScope};

/// Length in UTF-16 code units, as JS counts `length`.
pub(crate) fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The longest prefix of at most `max` UTF-16 units that ends on a char boundary (JS `slice(0, max)`, minus a split
/// surrogate pair).
pub(crate) fn utf16_prefix(s: &str, max: usize) -> &str {
    let mut count = 0;
    for (i, c) in s.char_indices() {
        count += c.len_utf16();
        if count > max {
            return &s[..i];
        }
    }
    s
}

/// The longest suffix of at most `max` UTF-16 units (JS `slice(length - max)`).
pub(crate) fn utf16_suffix(s: &str, max: usize) -> &str {
    let mut count = 0;
    for (i, c) in s.char_indices().rev() {
        count += c.len_utf16();
        if count > max {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}
