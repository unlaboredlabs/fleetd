//! The claude versions this fleetd speaks stream-json with. `TESTED` is the version the fixtures were recorded from,
//! `SUPPORTED` the range it was tested across. The floor is not a feature boundary: what fleetd needs from claude is
//! the stream-json `initialize` control request with `capabilities` and `account` (checked by the conformance probe
//! at every start, which refuses a claude without it and names what is missing) and the interrupt and lifecycle
//! capabilities a turn's `system/init` lists. So an older claude runs with a warning and the probe decides; a claude
//! past the range's end is refused, since its stream-json may have changed in ways the probe can't see.
pub const TESTED: &str = "2.1.302";
pub const SUPPORTED: &str = ">=2.1.300, <2.2.0";
const OLDEST: Version = (2, 1, 300);
const BELOW: Version = (2, 2, 0);

type Version = (u64, u64, u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VersionVerdict {
    /// Inside the range, at or below `TESTED`.
    Ok,
    /// Inside the range but newer than `TESTED`: sessions run, and the doctor warns once.
    UntestedNewer,
    /// Below the range: older than fleetd was tested with. Sessions run (the conformance probe still has the last
    /// word), and the doctor and setup warn and offer `claude update`.
    UntestedOlder,
    /// At or past the range's end: its stream-json may have changed, so sessions are refused.
    TooNew,
    /// `claude --version` printed something fleetd can't read.
    Unreadable,
}

/// `version` as `claude --version` prints it ("2.1.302 (Claude Code)").
pub fn check(version: &str) -> VersionVerdict {
    let Some(found) = parse(version) else {
        return VersionVerdict::Unreadable;
    };
    if found < OLDEST {
        VersionVerdict::UntestedOlder
    } else if found >= BELOW {
        VersionVerdict::TooNew
    } else if parse(TESTED).is_some_and(|tested| found > tested) {
        VersionVerdict::UntestedNewer
    } else {
        VersionVerdict::Ok
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
    /// Sessions may start with this claude.
    pub fn runs(&self) -> bool {
        matches!(self, Self::Ok | Self::UntestedNewer | Self::UntestedOlder)
    }

    /// What the doctor and `runner_info.problem` say about `found` (the `claude --version` output); `None` for Ok.
    pub fn problem(&self, found: &str) -> Option<String> {
        let found = found.trim();
        Some(match self {
            Self::Ok => return None,
            Self::UntestedNewer => format!(
                "claude {found} is newer than {TESTED}, the version this fleetd was tested with. It is inside the \
                 supported range ({SUPPORTED}), so sessions run; if they misbehave, pin the tested version."
            ),
            Self::UntestedOlder => format!(
                "claude {found} is older than fleetd is tested with (from {}); it may work, and fleetd checks its \
                 protocol at every start.",
                SUPPORTED
                    .trim_start_matches(">=")
                    .split(',')
                    .next()
                    .unwrap_or(SUPPORTED)
            ),
            Self::TooNew => format!(
                "claude {found} is newer than this fleetd supports ({SUPPORTED}); its stream-json protocol may have \
                 changed. Sessions on this machine are refused until claude is pinned back or fleetd is updated."
            ),
            Self::Unreadable => format!(
                "`claude --version` printed {found:?}, which fleetd can't read as a version. Sessions on this machine \
                 are refused until claude is reinstalled."
            ),
        })
    }

    /// The command that fixes it, run on the machine; `None` for Ok.
    pub fn fix(&self) -> Option<String> {
        Some(match self {
            Self::Ok => return None,
            Self::UntestedOlder => "claude update".to_owned(),
            Self::UntestedNewer => format!("claude install {TESTED}"),
            Self::TooNew => format!("claude install {TESTED}, or fleetd update"),
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
            ("2.1.301", Ok),
            ("v2.1.302", Ok),
            ("2.1.303 (Claude Code)", UntestedNewer),
            ("2.1.999", UntestedNewer),
            ("2.1.303-beta.1 (Claude Code)", UntestedNewer),
            // Older than tested: runs with a warning; the conformance probe refuses it if it lacks what fleetd uses.
            ("2.1.296 (Claude Code)", UntestedOlder),
            ("2.0.500", UntestedOlder),
            ("1.9.999", UntestedOlder),
            ("2.2.0 (Claude Code)", TooNew),
            ("2.2.0-beta.1", TooNew),
            ("3.0.0", TooNew),
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

    #[test]
    fn only_ok_has_no_problem_and_the_messages_name_the_version_and_fix() {
        assert_eq!(VersionVerdict::Ok.problem("2.1.302"), None);
        assert_eq!(VersionVerdict::Ok.fix(), None);
        assert_eq!(
            VersionVerdict::UntestedOlder
                .problem("2.1.296 (Claude Code)")
                .unwrap(),
            "claude 2.1.296 (Claude Code) is older than fleetd is tested with (from 2.1.300); it may work, and \
             fleetd checks its protocol at every start."
        );
        assert_eq!(
            VersionVerdict::UntestedOlder.fix().unwrap(),
            "claude update"
        );
        assert!(VersionVerdict::UntestedOlder.runs());
        assert_eq!(
            VersionVerdict::TooNew.fix().unwrap(),
            "claude install 2.1.302, or fleetd update"
        );
        assert!(VersionVerdict::UntestedNewer.runs() && !VersionVerdict::TooNew.runs());
    }
}
