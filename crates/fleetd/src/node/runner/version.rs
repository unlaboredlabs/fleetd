//! The claude versions this fleetd was tested with. `TESTED` is the version the fixtures were recorded from,
//! `SUPPORTED` the range it was tested across. fleetd never refuses a claude for its version: the probe's
//! `initialize` and real runs decide. Outside the range the doctor and setup warn and name the fix.
pub const TESTED: &str = "2.1.302";
pub const SUPPORTED: &str = ">=2.1.300, <2.2.0";
const OLDEST: Version = (2, 1, 300);
const BELOW: Version = (2, 2, 0);

type Version = (u64, u64, u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VersionVerdict {
    /// Inside the range.
    Ok,
    /// Older than the range.
    UntestedOlder,
    /// At or past the range's end.
    UntestedNewer,
    /// `claude --version` printed something fleetd can't read.
    Unreadable,
}

/// `version` as `claude --version` prints it ("2.1.302 (Claude Code)").
pub fn check(version: &str) -> VersionVerdict {
    match parse(version) {
        None => VersionVerdict::Unreadable,
        Some(found) if found < OLDEST => VersionVerdict::UntestedOlder,
        Some(found) if found >= BELOW => VersionVerdict::UntestedNewer,
        Some(_) => VersionVerdict::Ok,
    }
}

/// The leading `major.minor.patch`; a pre-release or build suffix ("2.1.303-beta.1") counts as that release.
fn parse(version: &str) -> Option<Version> {
    let word = version.split_whitespace().next()?;
    let word = word.strip_prefix('v').unwrap_or(word);
    let core = word.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(v)
}

impl VersionVerdict {
    /// What the doctor and setup say about `found` (the `claude --version` output); `None` for Ok.
    pub fn problem(&self, found: &str) -> Option<String> {
        let found = found.trim();
        Some(match self {
            Self::Ok => return None,
            Self::UntestedOlder => format!(
                "claude {found} is older than fleetd is tested with ({SUPPORTED}); sessions run, and fleetd checks \
                 its protocol at every start."
            ),
            Self::UntestedNewer => format!(
                "claude {found} is newer than fleetd is tested with ({SUPPORTED}); sessions run, and if they \
                 misbehave, pin the tested version."
            ),
            Self::Unreadable => format!(
                "`claude --version` printed {found:?}, which fleetd can't read as a version; sessions run, and \
                 fleetd checks its protocol at every start."
            ),
        })
    }

    /// The command that fixes it, run on the machine; `None` for Ok.
    pub fn fix(&self) -> Option<String> {
        Some(match self {
            Self::Ok => return None,
            Self::UntestedOlder => "claude update".to_owned(),
            Self::UntestedNewer => format!("claude install {TESTED}"),
            Self::Unreadable => {
                format!("curl -fsSL https://claude.ai/install.sh | bash -s {TESTED}")
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdicts_across_the_range() {
        use VersionVerdict::*;
        for (printed, want) in [
            ("2.1.302 (Claude Code)", Ok),
            ("2.1.300 (Claude Code)", Ok),
            ("v2.1.302", Ok),
            ("2.1.999", Ok),
            ("2.1.303-beta.1 (Claude Code)", Ok),
            ("2.1.296 (Claude Code)", UntestedOlder),
            ("1.9.999", UntestedOlder),
            ("2.2.0 (Claude Code)", UntestedNewer),
            ("2.2.0-beta.1", UntestedNewer),
            ("3.0.0", UntestedNewer),
            ("", Unreadable),
            ("Claude Code", Unreadable),
            ("2.1", Unreadable),
            ("2.1.302.4", Unreadable),
        ] {
            assert_eq!(check(printed), want, "{printed:?}");
        }
    }

    /// Bumping `TESTED` or `SUPPORTED` must keep the three in step.
    #[test]
    fn tested_is_inside_the_supported_range() {
        assert_eq!(check(TESTED), VersionVerdict::Ok);
        let (low, high) = SUPPORTED.split_once(", ").unwrap();
        assert_eq!(parse(low.strip_prefix(">=").unwrap()), Some(OLDEST));
        assert_eq!(parse(high.strip_prefix('<').unwrap()), Some(BELOW));
    }
}
