//! Where Xcode is on the Mac (docs: agents-mac.md#xcode), from what `xcode-select -p` says and the Xcodes in
//! /Applications: setup's Xcode check (checks.rs) and the doctor's iOS one (device/ios) both say it plainly, with the
//! one command that fixes it, never xcode-select's own error ("invalid developer directory").
use std::path::Path;

/// Xcode's page in the App Store app.
pub const APP_STORE: &str = "macappstore://apps.apple.com/app/id497799835";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Located {
    /// A full Xcode is selected: its developer directory.
    Selected(String),
    /// An Xcode is in /Applications (its bundle, `/Applications/Xcode-beta.app`), but `why` it isn't the one selected.
    Unselected { found: String, why: String },
    /// No Xcode is selected, and none is in /Applications.
    Missing,
}

/// From `xcode-select -p` (None when it failed), the Xcodes in /Applications ([`in_applications`]) and whether a path
/// is a directory: a path selected but since removed is no Xcode.
pub fn locate(selected: Option<&str>, found: &[String], is_dir: impl Fn(&str) -> bool) -> Located {
    let selected = selected.map(str::trim).filter(|p| !p.is_empty());
    let why = match selected {
        Some(path) if path.contains("CommandLineTools") => {
            "only the Command Line Tools are selected".to_owned()
        }
        Some(path) if !is_dir(path) => format!("xcode-select points at {path}, which isn't there"),
        Some(path) if path.contains(".app/Contents/Developer") => {
            return Located::Selected(path.to_owned());
        }
        Some(path) => format!("xcode-select points at {path}, which isn't an Xcode"),
        None => "no Xcode is selected".to_owned(),
    };
    match found.first() {
        Some(found) => Located::Unselected {
            found: found.clone(),
            why,
        },
        None => Located::Missing,
    }
}

/// The Xcode bundles in `dir` (`Xcode.app`, `Xcode-beta.app`, `Xcode 26.app`) with a developer directory in them,
/// `Xcode.app` first, then by name.
pub fn in_applications(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (name.starts_with("Xcode")
                && name.ends_with(".app")
                && e.path().join("Contents/Developer").is_dir())
            .then(|| e.path().to_string_lossy().into_owned())
        })
        .collect();
    found.sort_by_key(|p| (!p.ends_with("/Xcode.app"), p.clone()));
    found
}

/// The bundle's name: `Xcode-beta.app`.
pub fn name(bundle: &str) -> &str {
    bundle.rsplit('/').next().unwrap_or(bundle)
}

/// The one command that selects `bundle`, quoted for a name with a space in it.
pub fn switch(bundle: &str) -> String {
    format!(
        "sudo xcode-select -s {}",
        crate::cli::mac_tool::sh_quote(&format!("{bundle}/Contents/Developer"))
    )
}

/// Xcode's licence, then its system components: after a licence, xcodebuild can't say whether the first launch ran.
pub const ACCEPT: &str = "sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch";
pub const FIRST_LAUNCH: &str = "sudo xcodebuild -runFirstLaunch";
