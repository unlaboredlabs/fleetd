//! Holding a node's agents between steps ahead of its update's restart (`node_action` `hold`, `fleetd update`). The
//! hold is a file, `<node home>/update/hold`, naming when it ends (epoch ms). Every session's PreToolUse hook
//! ([`hook_command`]) waits while it lasts, so a tool call that hasn't started doesn't start until the restart ends
//! its session (claude resumes it afterwards); each waiting call marks itself held (`update/held/<tool_use_id>`), so the
//! node counts only the steps still running ([`crate::node::sessions::SessionService::hold`]). A hold lasts
//! [`HOLD_LEASE_SECS`] past the last ask, so one nobody renews (the hub went away, the update ended without a restart)
//! lets every call go; a node that starts clears it.
//!
//! A Navi's sandbox hides the node's home, so its hook never sees a hold: its tool calls aren't held, only counted.
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub use fleetd_contracts::node_link::HOLD_LEASE_SECS;

/// How often a held tool call looks at the hold again.
const HOOK_POLL: Duration = Duration::from_secs(1);
/// The hook's own timeout in claude's settings: past it claude runs the call anyway. Longer than any hold lasts.
pub const HOOK_TIMEOUT_SECS: u64 = 6 * 3600;

pub fn hold_path(home: &Path) -> PathBuf {
    home.join("update").join("hold")
}

fn held_dir(hold: &Path) -> PathBuf {
    hold.with_file_name("held")
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Holds the node's agents for [`HOLD_LEASE_SECS`] from now.
pub fn hold(home: &Path) -> std::io::Result<()> {
    hold_until(home).map(|_| ())
}

/// [`hold`], answering when it ends.
fn hold_until(home: &Path) -> std::io::Result<u128> {
    let path = hold_path(home);
    fs::create_dir_all(held_dir(&path))?;
    let until = now_ms() + u128::from(HOLD_LEASE_SECS) * 1000;
    crate::update::replace_file(&path, until.to_string().as_bytes())?;
    Ok(until)
}

/// Where a screen-settings restart (node/screens.rs) notes the end of the hold it last wrote.
fn screens_mark(home: &Path) -> PathBuf {
    hold_path(home).with_file_name("hold.screens")
}

/// [`hold`] for a screen-settings restart, noting the end it wrote, so [`release_screens`] can tell whether anyone else
/// renewed the hold since.
pub fn hold_for_screens(home: &Path) -> std::io::Result<()> {
    let until = hold_until(home)?;
    crate::update::replace_file(&screens_mark(home), until.to_string().as_bytes())
}

/// Ends a screen-settings restart's hold, unless someone renewed it since (an update's drain, `fleetd update`): their
/// hold then stays theirs, and lapses or clears as theirs does.
pub fn release_screens(home: &Path) {
    let mark = screens_mark(home);
    let ours = until(&mark);
    let _ = fs::remove_file(&mark);
    if ours.is_some() && until(&hold_path(home)) == ours {
        clear(home);
    }
}

/// The tool calls waiting on the hold now.
pub fn held(home: &Path) -> HashSet<String> {
    fs::read_dir(held_dir(&hold_path(home)))
        .map(|dir| {
            dir.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Ends the hold: every call waiting on it starts.
pub fn clear(home: &Path) {
    let path = hold_path(home);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(screens_mark(home));
    let _ = fs::remove_dir_all(held_dir(&path));
}

/// When the hold at `path` ends, or None when there is none.
fn until(path: &Path) -> Option<u128> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// The PreToolUse hook every session gets: a shell test that costs nothing while there is no hold, and `fleetd
/// update-hold` ([`run_hook`]) while there is one.
pub fn hook_command(exe: &str, home: &Path) -> String {
    let hold = quote(&hold_path(home).to_string_lossy());
    format!(
        "test -e {hold} || exit 0; exec {} update-hold {hold}",
        quote(exe)
    )
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `fleetd update-hold <hold>`: the hook itself. Waits while the hold lasts, its tool call marked held meanwhile, then
/// lets the call go (exit 0, nothing said). Never blocks a call for any other reason.
pub fn run_hook(hold: &Path) -> std::process::ExitCode {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    wait_out(hold, &input);
    std::process::ExitCode::SUCCESS
}

/// The hook's wait, for the tool call claude describes in `input` (the hook's stdin).
fn wait_out(hold: &Path, input: &str) {
    let id = serde_json::from_str::<serde_json::Value>(input)
        .ok()
        .and_then(|v| v["tool_use_id"].as_str().map(str::to_owned))
        .filter(|id| crate::node::sessions::path_safe(id));
    let marker = id.map(|id| held_dir(hold).join(id));
    let mut marked = false;
    while until(hold).is_some_and(|until| now_ms() < until) {
        if !marked && let Some(marker) = &marker {
            marked = fs::write(marker, b"").is_ok();
        }
        std::thread::sleep(HOOK_POLL);
    }
    if let (true, Some(marker)) = (marked, &marker) {
        let _ = fs::remove_file(marker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_screen_settings_release_leaves_an_updates_hold_alone() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        // Its own hold, renewed by nobody else: released.
        hold_for_screens(home).unwrap();
        release_screens(home);
        assert_eq!(until(&hold_path(home)), None);

        // An update renewed the hold meanwhile (a later end): the update's hold stays.
        hold_for_screens(home).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        hold(home).unwrap();
        let updates = until(&hold_path(home));
        release_screens(home);
        assert_eq!(
            until(&hold_path(home)),
            updates,
            "the update's hold isn't released"
        );
        assert_eq!(until(&screens_mark(home)), None);

        // A release with no hold of its own does nothing.
        release_screens(home);
        assert_eq!(until(&hold_path(home)), updates);
    }

    #[test]
    fn a_hold_lasts_its_lease_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(until(&hold_path(dir.path())), None);
        hold(dir.path()).unwrap();
        let ends = until(&hold_path(dir.path())).unwrap();
        let lease = u128::from(HOLD_LEASE_SECS) * 1000;
        assert!(ends > now_ms() && ends <= now_ms() + lease);
        fs::write(held_dir(&hold_path(dir.path())).join("toolu_1"), b"").unwrap();
        assert_eq!(held(dir.path()), HashSet::from(["toolu_1".to_owned()]));
        clear(dir.path());
        assert_eq!(until(&hold_path(dir.path())), None);
        assert!(held(dir.path()).is_empty());
    }

    /// A call waits while the hold lasts, marked held, and goes once it lapses; a name that isn't an id marks nothing.
    #[test]
    fn a_held_call_waits_out_the_hold_marked_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = hold_path(dir.path());
        fs::create_dir_all(held_dir(&path)).unwrap();
        fs::write(&path, (now_ms() + 1500).to_string()).unwrap();
        let waiting = {
            let path = path.clone();
            std::thread::spawn(move || {
                wait_out(&path, r#"{"tool_use_id":"toolu_9","tool_name":"Bash"}"#)
            })
        };
        let marked = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            held(dir.path()).contains("toolu_9")
        });
        assert!(marked, "held while the hold lasts");
        assert!(!waiting.is_finished());
        waiting.join().unwrap();
        assert!(held(dir.path()).is_empty(), "its mark goes with it");

        // No hold, or one that lapsed: the call goes at once.
        fs::write(&path, (now_ms() - 1).to_string()).unwrap();
        let started = std::time::Instant::now();
        wait_out(&path, r#"{"tool_use_id":"../x"}"#);
        assert!(started.elapsed() < HOOK_POLL);
        assert!(held(dir.path()).is_empty());
    }

    #[test]
    fn the_hook_is_a_cheap_test_until_there_is_a_hold() {
        let cmd = hook_command("/opt/it's/fleetd", Path::new("/n"));
        assert_eq!(
            cmd,
            r"test -e '/n/update/hold' || exit 0; exec '/opt/it'\''s/fleetd' update-hold '/n/update/hold'"
        );
        // No hold: the shell exits at once, and the call goes.
        let out = std::process::Command::new("sh")
            .args(["-c", &cmd])
            .output()
            .unwrap();
        assert!(out.status.success());
    }
}
