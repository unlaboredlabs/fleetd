//! Bringing a machine's Claude Code to the version this fleetd was tested with ([`super::version::TESTED`]), when the
//! hub updates the machine (`node_action` `claude`), and keeping Claude Code's own background update off, so nothing
//! changes under running agents but this.
//!
//! `claude install <version>` (the native installer's) puts the version under `~/.local/share/claude/versions/` and
//! points the `~/.local/bin/claude` launcher at it. It never touches a version a session on the machine still runs: a
//! session keeps the binary it started with and finishes on it, and the next one starts on the new version. So the
//! install needs no idle machine. A claude installed another way (Homebrew, npm, a package) is left as it is.
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetd_contracts::mcp::UpdateStage;
use serde_json::Value;

use super::version;
use crate::update::{BoxFuture, Failure};

/// Claude Code's own setting that stops its background update; `claude install` still works with it.
pub const AUTOUPDATER_OFF: (&str, &str) = ("DISABLE_AUTOUPDATER", "1");

/// How the node's answer begins when Claude Code already ran the version.
pub const ALREADY: &str = "already runs Claude Code";

/// The longest `claude install` gets: it downloads about 200 MB.
const INSTALL_WAIT: Duration = Duration::from_secs(600);

/// What the install does to the machine; tests stand in a fake.
pub trait Claude: Sync {
    /// `claude --version`, None when it doesn't run.
    fn version(&self) -> BoxFuture<'_, Option<String>>;
    /// The native installer's: the launcher points into its `versions` directory.
    fn native(&self) -> bool;
    /// `claude install <version>`; the error is its own last words.
    fn install<'a>(&'a self, version: &'a str) -> BoxFuture<'a, Result<(), String>>;
}

/// How it went.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Installed {
    /// It ran `version` already.
    Current(String),
    /// It ran `from`; new sessions start on `to`.
    Done { from: String, to: String },
}

/// The leading version number of `claude --version` output ("2.1.302 (Claude Code)" is "2.1.302").
pub fn number(output: &str) -> &str {
    output.split_whitespace().next().unwrap_or("")
}

/// Brings Claude Code to `target`. A failure says why and leaves the version there was.
pub async fn bring_to(claude: &dyn Claude, target: &str) -> Result<Installed, Failure> {
    let failed = |message: String| Failure::new(UpdateStage::Install, message);
    let Some(found) = claude.version().await else {
        return Err(failed(format!(
            "Claude Code doesn't run here: install {target} with `{}`",
            install_command(target)
        )));
    };
    let from = number(&found).to_owned();
    if from == target {
        return Ok(Installed::Current(from));
    }
    if !claude.native() {
        return Err(failed(format!(
            "Claude Code {from} here isn't the native install, so fleetd leaves it as it is: install {target} the way \
             it was installed"
        )));
    }
    if let Err(e) = claude.install(target).await {
        return Err(failed(format!(
            "`claude install {target}` failed ({e}), so {from} stays"
        )));
    }
    match claude.version().await.as_deref().map(number) {
        Some(now) if now == target => Ok(Installed::Done {
            from,
            to: target.to_owned(),
        }),
        now => Err(failed(format!(
            "`claude install {target}` finished, but `claude --version` says {}, so new sessions still start on it",
            now.unwrap_or("nothing")
        ))),
    }
}

/// The command a person runs for `target` where fleetd can't.
pub fn install_command(target: &str) -> String {
    format!("curl -fsSL https://claude.ai/install.sh | bash -s {target}")
}

/// The real claude: the node's launcher, run with the node's environment.
pub struct Real {
    pub binary: PathBuf,
    pub env: Vec<(String, String)>,
}

impl Real {
    fn command(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.binary);
        cmd.env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .env(AUTOUPDATER_OFF.0, AUTOUPDATER_OFF.1)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd
    }
}

impl Claude for Real {
    fn version(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let mut cmd = self.command();
            cmd.arg("--version");
            let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
                .await
                .ok()?
                .ok()?;
            let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            (out.status.success() && !text.is_empty()).then_some(text)
        })
    }

    fn native(&self) -> bool {
        native_launcher(&self.binary)
    }

    fn install<'a>(&'a self, version: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut cmd = self.command();
            cmd.args(["install", version]);
            let out = match tokio::time::timeout(INSTALL_WAIT, cmd.output()).await {
                Err(_) => {
                    return Err(format!(
                        "no answer within {} min",
                        INSTALL_WAIT.as_secs() / 60
                    ));
                }
                Ok(Err(e)) => return Err(e.to_string()),
                Ok(Ok(out)) => out,
            };
            if out.status.success() {
                return Ok(());
            }
            let said = [&out.stderr, &out.stdout]
                .iter()
                .map(|b| String::from_utf8_lossy(b).trim().to_owned())
                .find(|s| !s.is_empty())
                .and_then(|s| s.lines().last().map(str::to_owned))
                .unwrap_or_else(|| out.status.to_string());
            Err(crate::node::util::head_utf16(&said, 200).to_owned())
        })
    }
}

/// The launcher resolves into the native installer's `…/claude/versions/<version>`.
pub fn native_launcher(launcher: &Path) -> bool {
    let Ok(target) = std::fs::canonicalize(launcher) else {
        return false;
    };
    let mut up = target.ancestors().skip(1);
    up.next().and_then(Path::file_name) == Some("versions".as_ref())
        && up.next().and_then(Path::file_name) == Some("claude".as_ref())
}

/// Claude Code's own background update is off in its user settings (`settings.json` `env`).
pub fn autoupdater_off(settings: &Path) -> bool {
    std::fs::read_to_string(settings)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("env")?.get(AUTOUPDATER_OFF.0).cloned())
        .is_some_and(|v| v.as_str().is_some_and(|s| s != "0" && !s.is_empty()) || v == 1)
}

/// Turns Claude Code's background update off in its user settings, for a person's own claude on the machine too: it
/// would otherwise move the launcher new sessions start from. Keeps every other setting; an unreadable file is left
/// alone, and the doctor says so.
pub fn turn_autoupdater_off(settings: &Path) -> Result<bool, String> {
    if autoupdater_off(settings) {
        return Ok(false);
    }
    let mut root = match std::fs::read_to_string(settings) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("{} isn't valid JSON ({e})", settings.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Object(Default::default()),
        Err(e) => return Err(format!("couldn't read {}: {e}", settings.display())),
    };
    let Some(object) = root.as_object_mut() else {
        return Err(format!("{} isn't a JSON object", settings.display()));
    };
    let env = object
        .entry("env")
        .or_insert_with(|| Value::Object(Default::default()));
    let Some(env) = env.as_object_mut() else {
        return Err(format!("{}'s `env` isn't an object", settings.display()));
    };
    env.insert(AUTOUPDATER_OFF.0.to_owned(), Value::from(AUTOUPDATER_OFF.1));
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n";
    if let Some(dir) = settings.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_keeping_mode(settings, text.as_bytes())
        .map_err(|e| format!("couldn't write {}: {e}", settings.display()))?;
    Ok(true)
}

/// Replaces `path` through a sibling and a rename, keeping its permissions (a settings file may hold a key).
fn write_keeping_mode(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path).map_or(0o600, |m| m.permissions().mode() & 0o777);
    let tmp = path.with_extension("json.fleetd-tmp");
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    };
    write().inspect_err(|_| _ = std::fs::remove_file(&tmp))
}

/// The version this fleetd brings Claude Code to.
pub fn target() -> &'static str {
    version::TESTED
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A claude that runs `versions[0]`, and after an install, what the install leaves.
    struct Fake {
        version: Mutex<Option<String>>,
        native: bool,
        install: Result<Option<&'static str>, &'static str>,
        installs: Mutex<Vec<String>>,
    }

    fn fake(
        version: &str,
        native: bool,
        install: Result<Option<&'static str>, &'static str>,
    ) -> Fake {
        Fake {
            version: Mutex::new(Some(format!("{version} (Claude Code)"))),
            native,
            install,
            installs: Mutex::default(),
        }
    }

    impl Claude for Fake {
        fn version(&self) -> BoxFuture<'_, Option<String>> {
            let v = self.version.lock().unwrap().clone();
            Box::pin(async move { v })
        }
        fn native(&self) -> bool {
            self.native
        }
        fn install<'a>(&'a self, version: &'a str) -> BoxFuture<'a, Result<(), String>> {
            self.installs.lock().unwrap().push(version.to_owned());
            let result = match self.install {
                Ok(Some(now)) => {
                    *self.version.lock().unwrap() = Some(format!("{now} (Claude Code)"));
                    Ok(())
                }
                Ok(None) => Ok(()),
                Err(e) => Err(e.to_owned()),
            };
            Box::pin(async move { result })
        }
    }

    #[tokio::test]
    async fn brings_claude_to_the_tested_version() {
        let claude = fake("2.1.310", true, Ok(Some("2.1.302")));
        assert_eq!(
            bring_to(&claude, "2.1.302").await,
            Ok(Installed::Done {
                from: "2.1.310".into(),
                to: "2.1.302".into()
            })
        );
        assert_eq!(*claude.installs.lock().unwrap(), ["2.1.302"]);

        let current = fake("2.1.302", true, Err("never asked"));
        assert_eq!(
            bring_to(&current, "2.1.302").await,
            Ok(Installed::Current("2.1.302".into()))
        );
        assert!(current.installs.lock().unwrap().is_empty());
    }

    /// A failed install keeps the version there was, and says why in a line.
    #[tokio::test]
    async fn a_failed_install_keeps_the_version_and_says_why() {
        let claude = fake("2.1.310", true, Err("Could not download 2.1.302: 404"));
        let failed = bring_to(&claude, "2.1.302").await.unwrap_err();
        assert_eq!(failed.stage, UpdateStage::Install);
        assert_eq!(
            failed.message,
            "`claude install 2.1.302` failed (Could not download 2.1.302: 404), so 2.1.310 stays"
        );

        // It said it worked, but the launcher still starts the old one.
        let stuck = fake("2.1.310", true, Ok(None));
        let failed = bring_to(&stuck, "2.1.302").await.unwrap_err();
        assert!(
            failed
                .message
                .ends_with("says 2.1.310, so new sessions still start on it"),
            "{failed}"
        );

        let brew = fake("2.1.310", false, Err("never asked"));
        let failed = bring_to(&brew, "2.1.302").await.unwrap_err();
        assert!(
            failed.message.contains("isn't the native install"),
            "{failed}"
        );
        assert!(brew.installs.lock().unwrap().is_empty());
    }

    #[test]
    fn a_native_launcher_points_into_the_versions_directory() {
        let dir = tempfile::tempdir().unwrap();
        let versions = dir.path().join(".local/share/claude/versions");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::write(versions.join("2.1.302"), b"").unwrap();
        let bin = dir.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(versions.join("2.1.302"), bin.join("claude")).unwrap();
        assert!(native_launcher(&bin.join("claude")));
        std::fs::write(dir.path().join("claude"), b"").unwrap();
        assert!(!native_launcher(&dir.path().join("claude")));
    }

    /// Turning it off keeps every other setting and the file's mode, and is done once.
    #[test]
    fn turns_claudes_own_update_off_and_keeps_the_rest() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join(".claude/settings.json");
        assert!(!autoupdater_off(&settings));
        assert_eq!(turn_autoupdater_off(&settings), Ok(true));
        assert!(autoupdater_off(&settings));

        std::fs::write(
            &settings,
            r#"{"model":"opus","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9"}}"#,
        )
        .unwrap();
        std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(turn_autoupdater_off(&settings), Ok(true));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:9");
        assert_eq!(v["env"]["DISABLE_AUTOUPDATER"], "1");
        let mode = std::fs::metadata(&settings).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(turn_autoupdater_off(&settings), Ok(false));

        std::fs::write(&settings, "{ not json").unwrap();
        assert!(turn_autoupdater_off(&settings).is_err());
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{ not json");
    }
}
