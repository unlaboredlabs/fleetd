//! The fleetd dir: where every command keeps its state. `$FLEETD_HOME`, else `~/.fleetd`; the hub's home is
//! `<fleetd dir>/hub`, the node's `<fleetd dir>/node`. A command given `--home <dir>` (a hub's or a node's own
//! directory) keeps the rest of its state beside it, in the parent of `<dir>`: `--home /tmp/f/hub` acts as
//! `FLEETD_HOME=/tmp/f`, so a second fleet never reads or writes the first one's node config or app pairing.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The parent of the `--home` this process was started with, set once before the command runs.
static BESIDE_HOME: OnceLock<PathBuf> = OnceLock::new();

fn user_home() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn fleetd_dir() -> PathBuf {
    // Unit tests never read or write the developer's own fleet, whatever their environment says.
    if cfg!(test) {
        return std::env::temp_dir().join("fleetd-unit-tests");
    }
    resolve(
        std::env::var_os("FLEETD_HOME").as_deref(),
        BESIDE_HOME.get().map(PathBuf::as_path),
        &user_home(),
    )
}

/// The fleetd dir when it isn't `~/.fleetd`: then files that otherwise live elsewhere (the app's pairing file) go
/// in it too.
pub fn relocated() -> Option<PathBuf> {
    let dir = fleetd_dir();
    (dir != user_home().join(".fleetd")).then_some(dir)
}

/// `FLEETD_HOME` wins, then the directory beside `--home`, then `~/.fleetd`.
pub fn resolve(env: Option<&OsStr>, beside_home: Option<&Path>, user_home: &Path) -> PathBuf {
    match env.and_then(OsStr::to_str).filter(|v| !v.is_empty()) {
        Some(dir) => crate::hub::store::expand_home(dir, user_home),
        None => beside_home.map_or_else(|| user_home.join(".fleetd"), Path::to_path_buf),
    }
}

/// The `--home` in a command line (`--home <dir>` or `--home=<dir>`, before any `--`).
pub fn home_flag(argv: &[String]) -> Option<&str> {
    let mut words = argv.iter().take_while(|a| *a != "--");
    while let Some(word) = words.next() {
        if word == "--home" {
            return words.next().map(String::as_str);
        }
        if let Some(value) = word.strip_prefix("--home=") {
            return Some(value);
        }
    }
    None
}

/// Called once by `main`, before the command runs.
pub fn init_from_argv(argv: &[String]) {
    if let Some(home) = home_flag(argv).filter(|h| !h.is_empty()) {
        let home = crate::hub::store::expand_home(home, &user_home());
        if let Some(parent) = home.parent() {
            let _ = BESIDE_HOME.set(parent.to_path_buf());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fleetd_home_wins_then_beside_home_then_the_default() {
        let user = Path::new("/home/ada");
        assert_eq!(resolve(None, None, user), user.join(".fleetd"));
        assert_eq!(
            resolve(None, Some(Path::new("/tmp/f")), user),
            Path::new("/tmp/f")
        );
        assert_eq!(
            resolve(
                Some(OsStr::new("/srv/fleet")),
                Some(Path::new("/tmp/f")),
                user
            ),
            Path::new("/srv/fleet")
        );
        assert_eq!(
            resolve(Some(OsStr::new("~/two")), None, user),
            Path::new("/home/ada/two")
        );
        assert_eq!(
            resolve(Some(OsStr::new("")), None, user),
            user.join(".fleetd"),
            "an empty FLEETD_HOME is unset"
        );
    }

    #[test]
    fn finds_home_in_either_spelling_and_never_after_the_separator() {
        assert_eq!(
            home_flag(&argv(&["init", "--home", "/tmp/f/hub", "--yes"])),
            Some("/tmp/f/hub")
        );
        assert_eq!(
            home_flag(&argv(&["status", "--home=/tmp/f/hub"])),
            Some("/tmp/f/hub")
        );
        assert_eq!(
            home_flag(&argv(&["steer", "W1", "--", "--home", "x"])),
            None
        );
        assert_eq!(home_flag(&argv(&["status", "W1"])), None);
    }
}
