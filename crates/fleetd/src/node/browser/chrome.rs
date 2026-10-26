//! The browsers sessions get: Playwright's build of Chrome's headless shell and its ffmpeg, installed by the node at a
//! pinned Playwright release under `<node home>/browser/ms-playwright` (node.json `browser.chrome` and
//! `browser.ffmpeg` name others), and a warm pool of launched processes. Each session takes a process of its own with a
//! fresh, empty profile directory, and both are thrown away when it ends: nothing of one session reaches the next.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::cdp::Cdp;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The Playwright release whose browser and ffmpeg builds the node installs.
pub const PLAYWRIGHT_VERSION: &str = "1.64.1";
/// How long a launched Chrome has to answer on its pipe.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
/// The page size sessions get, and the video's.
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 800;

/// Where the node keeps its pinned browser builds.
pub fn install_dir(home: &Path) -> PathBuf {
    home.join("browser").join("ms-playwright")
}

/// The newest `<prefix>-<revision>` directory under `root` that finished installing.
fn newest(root: &Path, prefix: &str) -> Option<PathBuf> {
    let mut found: Vec<(u64, PathBuf)> = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let revision = name.strip_prefix(prefix)?.strip_prefix('-')?.parse().ok()?;
            e.path()
                .join("INSTALLATION_COMPLETE")
                .exists()
                .then(|| (revision, e.path()))
        })
        .collect();
    found.sort();
    found.pop().map(|(_, path)| path)
}

/// The headless shell in an install directory.
pub fn find_chrome(root: &Path) -> Option<PathBuf> {
    let dir = newest(root, "chromium_headless_shell")?;
    [
        "chrome-headless-shell-linux64",
        "chrome-headless-shell-mac-arm64",
        "chrome-headless-shell-mac-x64",
    ]
    .iter()
    .map(|platform| dir.join(platform).join("chrome-headless-shell"))
    .find(|bin| bin.is_file())
}

/// Playwright's ffmpeg in an install directory.
pub fn find_ffmpeg(root: &Path) -> Option<PathBuf> {
    let dir = newest(root, "ffmpeg")?;
    ["ffmpeg-linux", "ffmpeg-mac"]
        .iter()
        .map(|name| dir.join(name))
        .find(|bin| bin.is_file())
}

/// Installs the pinned builds with Playwright's own installer (`npx playwright@<pinned> install`), which checks their
/// downloads. Needs Node.js; blocking, minutes on a slow link.
pub fn install(home: &Path) -> Result<(), String> {
    let root = install_dir(home);
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot make {}: {e}", root.display()))?;
    let out = std::process::Command::new("npx")
        .args([
            "--yes",
            &format!("playwright@{PLAYWRIGHT_VERSION}"),
            "install",
            "chromium-headless-shell",
            "ffmpeg",
        ])
        .env("PLAYWRIGHT_BROWSERS_PATH", &root)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run npx (Node.js) to install the browser: {e}"))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let tail: String = tail
            .chars()
            .rev()
            .take(500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!("installing the browser failed: {tail}"));
    }
    Ok(())
}

/// How the node launches Chrome.
#[derive(Clone, Debug)]
pub struct Launch {
    pub chrome: PathBuf,
    /// Where each process's fresh profile goes, one directory per process.
    pub profiles: PathBuf,
    /// Chrome's own sandbox. Off by default as Playwright has it: it needs user namespaces many Linux hosts refuse.
    pub sandbox: bool,
}

/// One launched Chrome: its process group, its profile and the node's pipe connection to it. Killed and its profile
/// deleted when dropped.
pub struct Browser {
    child: Child,
    pgid: Option<i32>,
    pub profile: PathBuf,
    pub cdp: Arc<Cdp>,
}

impl Browser {
    /// Whether it still runs.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid {
            let _ = killpg(Pid::from_raw(pgid), Signal::SIGKILL);
        }
        let _ = self.child.start_kill();
        let profile = self.profile.clone();
        // Chrome's helpers may still write for a moment after the kill; try once more after it.
        if std::fs::remove_dir_all(&profile).is_err() {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                let _ = std::fs::remove_dir_all(&profile);
            });
        }
    }
}

/// Chrome's flags: no debugging port, only its pipe; a fresh profile; nothing that phones home or waits on a keyring
/// (without `--password-store=basic` the first load of a fresh profile waits 12-24 s on the desktop keyring).
pub fn args(launch: &Launch, profile: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-features=Translate,AutofillServerCommunication,PasswordManagerOnboarding",
        "--password-store=basic",
        "--use-mock-keychain",
        "--metrics-recording-only",
        "--mute-audio",
        "--hide-scrollbars",
    ]
    .iter()
    .map(|a| (*a).to_owned())
    .collect();
    args.push(format!("--window-size={WIDTH},{HEIGHT}"));
    args.push(format!("--user-data-dir={}", profile.display()));
    let headless_shell = launch
        .chrome
        .file_name()
        .is_some_and(|n| n.to_string_lossy().contains("headless-shell"));
    if !headless_shell {
        args.push("--headless=new".to_owned());
    }
    if !launch.sandbox {
        args.push("--no-sandbox".to_owned());
    }
    args.push("about:blank".to_owned());
    args
}

/// Launches Chrome with its pipe on fds 3 (commands in) and 4 (answers out), which `sh` moves there from the
/// stdin and stdout the node holds, and waits until it answers.
pub async fn launch(launch: &Launch) -> Result<Browser, String> {
    std::fs::create_dir_all(&launch.profiles)
        .map_err(|e| format!("cannot make {}: {e}", launch.profiles.display()))?;
    let profile = tempfile::Builder::new()
        .prefix("profile-")
        .tempdir_in(&launch.profiles)
        .map_err(|e| format!("cannot make a profile directory: {e}"))?
        .keep();
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(r#"exec "$0" "$@" 3<&0 4>&1 </dev/null >/dev/null"#)
        .arg(&launch.chrome)
        .args(args(launch, &profile))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&profile);
            return Err(format!("cannot start {}: {e}", launch.chrome.display()));
        }
    };
    let pgid = child.id().map(|id| id as i32);
    let (stdin, stdout) = (
        child.stdin.take().expect("piped stdin"),
        child.stdout.take().expect("piped stdout"),
    );
    let stderr = child.stderr.take().expect("piped stderr");
    let said = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        // Keep draining stderr, or Chrome blocks once the pipe fills; its first lines say why a launch failed.
        let said = said.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut said = said
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if said.len() < 5 {
                    said.push(line);
                }
            }
        });
    }
    let browser = Browser {
        child,
        pgid,
        profile,
        cdp: Cdp::over_pipe(stdin, stdout),
    };
    let ready = tokio::time::timeout(
        LAUNCH_TIMEOUT,
        browser
            .cdp
            .call(None, "Browser.getVersion", serde_json::json!({})),
    )
    .await;
    match ready {
        Ok(Ok(_)) => Ok(browser),
        _ => {
            let said = said
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .join(" / ");
            Err(format!(
                "Chrome did not answer on its pipe{}",
                if said.is_empty() {
                    String::new()
                } else {
                    format!(": {said}")
                }
            ))
        }
    }
}

/// Launched browsers waiting for a session: taking one costs no launch, and the pool starts a new one behind it.
pub struct Pool {
    launch: Launch,
    size: usize,
    warm: Mutex<VecDeque<Browser>>,
    filling: tokio::sync::Mutex<()>,
}

impl Pool {
    pub fn new(launch: Launch, size: usize) -> Arc<Self> {
        Arc::new(Self {
            launch,
            size,
            warm: Mutex::default(),
            filling: tokio::sync::Mutex::new(()),
        })
    }

    pub fn launch_settings(&self) -> &Launch {
        &self.launch
    }

    /// A warm browser, or one launched now when none is; the pool refills behind it.
    pub async fn take(self: &Arc<Self>) -> Result<Browser, String> {
        let warm = loop {
            let next = self.lock().pop_front();
            match next {
                Some(mut browser) => {
                    if browser.alive() {
                        break Some(browser);
                    }
                    // One that died while it waited goes; try the next.
                }
                None => break None,
            }
        };
        let browser = match warm {
            Some(browser) => browser,
            None => launch(&self.launch).await?,
        };
        self.refill();
        Ok(browser)
    }

    /// Launches browsers in the background until the pool holds its size.
    pub fn refill(self: &Arc<Self>) {
        let pool = self.clone();
        tokio::spawn(async move {
            let Ok(_filling) = pool.filling.try_lock() else {
                return;
            };
            while pool.lock().len() < pool.size {
                match launch(&pool.launch).await {
                    Ok(browser) => pool.lock().push_back(browser),
                    Err(e) => {
                        tracing::warn!(error = %e, "browser pool not refilled");
                        return;
                    }
                }
            }
        });
    }

    pub fn warm(&self) -> usize {
        self.lock().len()
    }

    /// Kills every waiting browser.
    pub fn drain(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<Browser>> {
        self.warm
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_opens_no_port_and_skips_the_keyring() {
        let launch = Launch {
            chrome: PathBuf::from("/x/chrome-headless-shell"),
            profiles: PathBuf::from("/p"),
            sandbox: false,
        };
        let args = args(&launch, Path::new("/p/profile-1"));
        assert!(args.contains(&"--remote-debugging-pipe".to_owned()));
        assert!(
            !args
                .iter()
                .any(|a| a.starts_with("--remote-debugging-port"))
        );
        assert!(args.contains(&"--password-store=basic".to_owned()));
        assert!(args.contains(&"--user-data-dir=/p/profile-1".to_owned()));
        assert!(
            !args.contains(&"--headless=new".to_owned()),
            "the headless shell is headless already"
        );
    }

    #[test]
    fn finds_the_newest_finished_install() {
        let root = tempfile::tempdir().unwrap();
        for (dir, complete) in [
            ("chromium_headless_shell-1200", true),
            ("chromium_headless_shell-1248", true),
            ("chromium_headless_shell-1300", false),
            ("ffmpeg-1013", true),
        ] {
            let d = root.path().join(dir);
            std::fs::create_dir_all(d.join("chrome-headless-shell-linux64")).unwrap();
            std::fs::write(
                d.join("chrome-headless-shell-linux64/chrome-headless-shell"),
                "",
            )
            .unwrap();
            std::fs::write(d.join("ffmpeg-linux"), "").unwrap();
            if complete {
                std::fs::write(d.join("INSTALLATION_COMPLETE"), "").unwrap();
            }
        }
        let chrome = find_chrome(root.path()).unwrap();
        assert!(
            chrome.starts_with(root.path().join("chromium_headless_shell-1248")),
            "{chrome:?}"
        );
        assert!(
            find_ffmpeg(root.path())
                .unwrap()
                .ends_with("ffmpeg-1013/ffmpeg-linux")
        );
    }
}
