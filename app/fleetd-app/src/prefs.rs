//! The app's own preferences (not the hub connection, which lives in the keychain): one small JSON file next
//! to fleetd's other per-user config, `$XDG_CONFIG_HOME/fleetd/app.json` (macOS: `~/Library/Application
//! Support/fleetd/app.json`). A missing or unreadable file means the defaults.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::theme::Mode;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub theme: Mode,
}

pub fn load() -> Prefs {
    path().and_then(|p| std::fs::read(p).ok()).map(|bytes| parse(&bytes)).unwrap_or_default()
}

/// Writes atomically, so a crash mid-write never leaves a half file.
pub fn save(prefs: &Prefs) -> Result<(), String> {
    let path = path().ok_or("No home directory to save preferences in.")?;
    let dir = path.parent().ok_or("Bad preferences path.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}.", dir.display()))?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("Couldn't save {}: {e}.", path.display()))
}

/// Unknown fields and unknown values fall back to the defaults instead of failing, so an older app reads a
/// newer app's file.
fn parse(bytes: &[u8]) -> Prefs {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(bytes) else { return Prefs::default() };
    let mut prefs = Prefs::default();
    if let Some(mode) = map.get("theme").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        prefs.theme = mode;
    }
    prefs
}

fn path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)?;
    let xdg = std::env::var_os("XDG_CONFIG_HOME").filter(|h| !h.is_empty()).map(PathBuf::from);
    Some(config_dir(&home, xdg.as_deref(), cfg!(target_os = "macos")).join("fleetd").join("app.json"))
}

fn config_dir(home: &Path, xdg: Option<&Path>, macos: bool) -> PathBuf {
    match (macos, xdg) {
        (true, _) => home.join("Library/Application Support"),
        // XDG says a relative value is invalid and must be ignored.
        (false, Some(x)) if x.is_absolute() => x.to_path_buf(),
        (false, _) => home.join(".config"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_theme_and_tolerates_anything_else() {
        assert_eq!(parse(br#"{"theme":"dark"}"#).theme, Mode::Dark);
        assert_eq!(parse(br#"{"theme":"sepia","later":1}"#), Prefs::default());
        assert_eq!(parse(b"not json"), Prefs::default());
        assert_eq!(parse(b"[]"), Prefs::default());
    }

    #[test]
    fn round_trips() {
        let prefs = Prefs { theme: Mode::Light };
        assert_eq!(parse(&serde_json::to_vec(&prefs).unwrap()), prefs);
    }

    #[test]
    fn config_dir_follows_the_platform_and_xdg() {
        let home = Path::new("/home/u");
        assert_eq!(config_dir(home, None, false), Path::new("/home/u/.config"));
        assert_eq!(config_dir(home, Some(Path::new("/cfg")), false), Path::new("/cfg"));
        assert_eq!(config_dir(home, Some(Path::new("rel")), false), Path::new("/home/u/.config"));
        assert_eq!(config_dir(home, Some(Path::new("/cfg")), true), Path::new("/home/u/Library/Application Support"));
    }
}
