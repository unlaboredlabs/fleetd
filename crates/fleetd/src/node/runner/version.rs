//! The claude versions this fleetd speaks stream-json with. `TESTED` is the version the fixtures were recorded from.
pub const TESTED: &str = "2.1.302";
pub const SUPPORTED: &str = ">=2.1.300, <2.2.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VersionVerdict {
    /// Inside the range.
    Ok,
    /// Inside the range but newer than `TESTED`: run, and the doctor warns once.
    Untested,
    /// Outside the range: sessions are refused with a fix.
    Unsupported,
}

/// `version` as `claude --version` prints it ("2.1.302 (Claude Code)").
pub fn check(_version: &str) -> VersionVerdict {
    todo!("runner failure and version slice")
}
