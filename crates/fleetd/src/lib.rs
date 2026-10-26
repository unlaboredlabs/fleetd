//! The fleetd binary's library: the hub, the per-machine node and the CLI. One owner per module; see
//! `hub/mod.rs` for the hub's areas.
pub mod cli;
pub mod clock;
pub mod home;
pub mod hub;
pub mod node;
pub mod tiles;

/// The version the release build baked in (`FLEETD_VERSION`, e.g. `0.4.0` or `0.4.0-nightly.202610221107+333368c`),
/// or the crate version (`0.0.0`) for a local build. The CLI, the hub and the node all report this one.
pub fn version() -> &'static str {
    option_env!("FLEETD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// A version as people read it. A nightly by when it was built and from which commit, since its minute stamp is what
/// tells two nightlies apart: `0.0.0-nightly.202610261056+1b563d7` reads "Nightly · Oct 26, 10:56 UTC · 1b563d7".
/// Any other version is itself, without a build part. Only for showing: updates compare the raw version, and output
/// that names a version prints the raw one too, to copy. The app's twin is `versionLabel` (app/desktop/src/shared/updates.ts).
pub fn version_label(version: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let version = version.trim();
    let version = version.strip_prefix('v').unwrap_or(version);
    let (bare, build) = version.split_once('+').unwrap_or((version, ""));
    let stamp = bare.split_once("-nightly.").and_then(|(base, stamp)| {
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
        "Nightly · {month} {day}, {}:{} UTC",
        &stamp[8..10],
        &stamp[10..12]
    );
    if build.len() >= 7 && build.bytes().all(|b| b.is_ascii_hexdigit()) {
        label.push_str(" · ");
        label.push_str(&build[..7].to_ascii_lowercase());
    }
    label
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nightly_reads_by_when_and_from_which_commit_it_was_built() {
        assert_eq!(
            version_label("0.0.0-nightly.202610261056+1b563d7"),
            "Nightly · Oct 26, 10:56 UTC · 1b563d7"
        );
        assert_eq!(
            version_label("0.6.0-nightly.202601020304+ABCDEF0123"),
            "Nightly · Jan 2, 03:04 UTC · abcdef0"
        );
        assert_eq!(
            version_label("0.6.0-nightly.202610221030"),
            "Nightly · Oct 22, 10:30 UTC"
        );
        assert_eq!(
            version_shown("0.0.0-nightly.202610261056+1b563d7"),
            "Nightly · Oct 26, 10:56 UTC · 1b563d7 (0.0.0-nightly.202610261056+1b563d7)"
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
