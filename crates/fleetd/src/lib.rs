//! The fleetd binary's library: the hub, the per-machine node and the CLI. One owner per module; see
//! `hub/mod.rs` for the hub's areas.
pub mod cli;
pub mod clock;
pub mod fingerprint;
pub mod home;
pub mod hub;
pub mod node;
pub mod push_relay;
pub mod tiles;
pub mod update;

/// The version the release build baked in (`FLEETD_VERSION`, e.g. `0.4.0` or `0.4.0-edge.202610221107+333368c`),
/// or the crate version (`0.0.0`) for a local build. The CLI, the hub and the node all report this one.
pub fn version() -> &'static str {
    option_env!("FLEETD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// A version as people read it. An Edge build by when it was built and from which commit, since its minute stamp is
/// what tells two apart: `0.0.0-edge.202610261056+1b563d7` reads "Edge · Oct 26, 10:56 UTC · 1b563d7", and so does a
/// build from before the rename, `0.0.0-nightly.202610261056+1b563d7` (the same series). Any other version is itself,
/// without a build part. Only for showing: updates compare the raw version, and output that names a version prints the
/// raw one too, to copy. The app's twin is `versionLabel` (app/desktop/src/shared/updates.ts).
pub fn version_label(version: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let version = version.trim();
    let version = version.strip_prefix('v').unwrap_or(version);
    let (bare, build) = version.split_once('+').unwrap_or((version, ""));
    let stamp = edge_stamp(bare).and_then(|(base, stamp)| {
        let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        let parts: Vec<&str> = base.split('.').collect();
        (parts.len() == 3
            && parts.iter().all(|p| numeric(p))
            && stamp.len() == 12
            && numeric(stamp))
        .then_some(stamp)
    });
    let Some(stamp) = stamp else {
        return bare.to_owned();
    };
    let Some(month) = stamp[4..6]
        .parse::<usize>()
        .ok()
        .and_then(|m| MONTHS.get(m.wrapping_sub(1)))
    else {
        return bare.to_owned();
    };
    let day = stamp[6..8].trim_start_matches('0');
    let mut label = format!(
        "Edge · {month} {day}, {}:{} UTC",
        &stamp[8..10],
        &stamp[10..12]
    );
    if build.len() >= 7 && build.bytes().all(|b| b.is_ascii_hexdigit()) {
        label.push_str(" · ");
        label.push_str(&build[..7].to_ascii_lowercase());
    }
    label
}

/// An Edge build's version split around its channel: `(base, rest)` of `<base>-edge.<rest>`, or of
/// `<base>-nightly.<rest>`, the name Edge had until D203. None for any other version.
pub fn edge_stamp(version: &str) -> Option<(&str, &str)> {
    version
        .split_once("-edge.")
        .or_else(|| version.split_once("-nightly."))
}

/// How output names a version: its label, and the raw version after it when they differ, to copy.
pub fn version_shown(version: &str) -> String {
    let label = version_label(version);
    if label == version.trim() {
        label
    } else {
        format!("{label} ({})", version.trim())
    }
}

/// Orders two versions as semver does: dotted numbers (`0.10.0` after `0.9.3`), a pre-release before its release, and
/// pre-releases by their dot-separated parts, numbers numerically, so a later nightly is newer. `nightly.<stamp>` and
/// `edge.<stamp>` are one series, the channel's old name and its new (D203), ordered by stamp. Build metadata
/// (`+abc1234`) doesn't count. None when either isn't a version, is a local build's `0.0.0`, or they're on different
/// channels (an edge build and a tagged one): a move between channels is chosen, never "newer" or "older". The app's
/// twin is `compareVersions` (app/desktop/src/shared/pairing.ts).
pub fn version_cmp(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    fn parse(v: &str) -> Option<([u64; 3], Option<String>)> {
        let v = v.trim();
        let v = v.strip_prefix('v').unwrap_or(v);
        let bare = v.split_once('+').map_or(v, |(bare, _)| bare);
        let (core, pre) = match bare.split_once('-') {
            // Renamed, the same series: an edge build orders as the nightly of its stamp.
            Some((core, pre)) if !pre.is_empty() => {
                let pre = pre
                    .strip_prefix("edge")
                    .map_or(pre.to_owned(), |rest| format!("nightly{rest}"));
                (core, Some(pre))
            }
            Some(_) => return None,
            None => (bare, None),
        };
        let mut nums = core.split('.').map(|n| {
            (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                .then(|| n.parse().ok())
                .flatten()
        });
        let parsed = [nums.next()??, nums.next()??, nums.next()??];
        nums.next().is_none().then_some((parsed, pre))
    }
    let ((x, px), (y, py)) = (parse(a)?, parse(b)?);
    let nightly = |pre: &Option<String>| pre.as_ref().is_some_and(|p| p.starts_with("nightly"));
    if (x == [0; 3] && px.is_none())
        || (y == [0; 3] && py.is_none())
        || nightly(&px) != nightly(&py)
    {
        return None;
    }
    Some(
        x.cmp(&y)
            .then_with(|| match (px.as_deref(), py.as_deref()) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(p), Some(q)) => {
                    let (mut ps, mut qs) = (p.split('.'), q.split('.'));
                    loop {
                        let d = match (ps.next(), qs.next()) {
                            (None, None) => return Ordering::Equal,
                            (None, Some(_)) => Ordering::Less,
                            (Some(_), None) => Ordering::Greater,
                            (Some(p), Some(q)) => match (p.parse::<u64>(), q.parse::<u64>()) {
                                (Ok(p), Ok(q)) => p.cmp(&q),
                                (Ok(_), Err(_)) => Ordering::Less,
                                (Err(_), Ok(_)) => Ordering::Greater,
                                (Err(_), Err(_)) => p.cmp(q),
                            },
                        };
                        if d != Ordering::Equal {
                            return d;
                        }
                    }
                }
            }),
    )
}

/// `have` is `want`, or as new or newer on the same channel: a machine there is never moved to `want`, which would be
/// backwards.
pub fn at_least(have: &str, want: &str) -> bool {
    have == want || version_cmp(have, want).is_some_and(std::cmp::Ordering::is_ge)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_order_as_semver_does_within_a_channel() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        assert_eq!(version_cmp("0.10.0", "0.9.3"), Some(Greater));
        assert_eq!(version_cmp("v0.4.2", "0.4.2+abc1234"), Some(Equal));
        assert_eq!(
            version_cmp(
                "0.0.0-nightly.202610271703+bd87c55",
                "0.0.0-nightly.202610271537+fdc6cc1"
            ),
            Some(Greater)
        );
        assert_eq!(
            version_cmp(
                "0.0.0-nightly.202610271537+0abc123",
                "0.0.0-nightly.202610271537+fff0000"
            ),
            Some(Equal)
        );
        assert_eq!(
            version_cmp("0.5.0-nightly.9", "0.5.0-nightly.10"),
            Some(Less)
        );
        assert_eq!(version_cmp("0.5.0-rc.1", "0.5.0"), Some(Less));
        assert_eq!(version_cmp("2.1.302", "2.1.40"), Some(Greater));
        // Across channels, from a local build, or not a version: no order.
        assert_eq!(
            version_cmp("0.5.0", "0.0.0-nightly.202610271537+fdc6cc1"),
            None
        );
        assert_eq!(
            version_cmp("0.0.0", "0.0.0-nightly.202610271537+fdc6cc1"),
            None
        );
        assert_eq!(version_cmp("dev", "0.5.0"), None);
        assert_eq!(version_cmp("0.5", "0.5.0"), None);
        assert!(at_least("0.0.0", "0.0.0"));
        assert!(at_least("0.4.2+abc1234", "0.4.2"));
        assert!(!at_least("0.0.0", "0.0.0-nightly.202610271537+fdc6cc1"));
        assert!(at_least("0.4.3", "0.4.2"));
        assert!(!at_least("0.4.1", "0.4.2"));
    }

    /// The nightly channel renamed Edge (D203): one series, ordered by stamp whichever name a build carries.
    #[test]
    fn nightly_and_edge_builds_are_one_series_ordered_by_stamp() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        let (nightly, edge) = (
            "0.0.0-nightly.202610271537+fdc6cc1",
            "0.0.0-edge.202610281200+0abc123",
        );
        assert_eq!(version_cmp(edge, nightly), Some(Greater));
        assert_eq!(version_cmp(nightly, edge), Some(Less));
        assert_eq!(
            version_cmp("0.0.0-edge.202610271537+fdc6cc1", nightly),
            Some(Equal)
        );
        assert_eq!(
            version_cmp("0.0.0-edge.202610271000", "0.0.0-edge.202610271537"),
            Some(Less)
        );
        assert!(at_least(edge, nightly));
        assert!(!at_least(nightly, edge));
        assert!(at_least("0.0.0-edge.202610271537+fdc6cc1", nightly));
        // Still another channel than a tagged build's.
        assert_eq!(version_cmp(edge, "0.5.0"), None);
    }

    #[test]
    fn an_edge_build_reads_by_when_and_from_which_commit_it_was_built() {
        assert_eq!(
            version_label("0.0.0-edge.202610261056+1b563d7"),
            "Edge · Oct 26, 10:56 UTC · 1b563d7"
        );
        assert_eq!(
            version_label("0.6.0-edge.202601020304+ABCDEF0123"),
            "Edge · Jan 2, 03:04 UTC · abcdef0"
        );
        assert_eq!(
            version_label("0.6.0-edge.202610221030"),
            "Edge · Oct 22, 10:30 UTC"
        );
        assert_eq!(
            version_shown("0.0.0-edge.202610261056+1b563d7"),
            "Edge · Oct 26, 10:56 UTC · 1b563d7 (0.0.0-edge.202610261056+1b563d7)"
        );
    }

    /// Builds from before the rename are the same series, and read as Edge too.
    #[test]
    fn a_nightly_build_reads_as_edge() {
        assert_eq!(
            version_label("0.0.0-nightly.202610261056+1b563d7"),
            "Edge · Oct 26, 10:56 UTC · 1b563d7"
        );
        assert_eq!(
            version_shown("0.0.0-nightly.202610261056+1b563d7"),
            "Edge · Oct 26, 10:56 UTC · 1b563d7 (0.0.0-nightly.202610261056+1b563d7)"
        );
    }

    #[test]
    fn any_other_version_reads_as_itself() {
        assert_eq!(version_label("v0.6.0"), "0.6.0");
        assert_eq!(version_label("0.6.0+abc1234"), "0.6.0");
        assert_eq!(version_label("0.6.0-rc.1+abc1234"), "0.6.0-rc.1");
        assert_eq!(version_shown("0.4.0"), "0.4.0");
        // Not a real month: shown as it is, never as a made-up date.
        assert_eq!(
            version_label("0.6.0-nightly.202613221030+abc1234"),
            "0.6.0-nightly.202613221030"
        );
    }
}
