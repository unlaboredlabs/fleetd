//! The browsers sessions get: Playwright's build of Chrome's headless shell and its ffmpeg, installed by the node at a
//! pinned Playwright release under `<node home>/browser/ms-playwright` (node.json `browser.chrome` and
//! `browser.ffmpeg` name others), and a warm pool of launched processes. Each session takes a process of its own with a
//! fresh, empty profile directory, and both are thrown away when it ends: nothing of one session reaches the next.
//!
//! A Navi's sessions are the exception (D221): each Navi keeps one profile of its own ([`Kept`]), so the sites it
//! signed into stay signed in. It lives under the node's home, which the Navi's sandbox hides (runner/sandbox.rs), is
//! used by one browser at a time, and goes when the person forgets its sign-ins or deletes the Navi.
use std::collections::{HashMap, VecDeque};
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
/// How long a Chrome on a kept profile has to close by itself, writing its cookies out, before it is killed.
const CLOSE_WAIT: Duration = Duration::from_secs(5);
/// How long forgetting a Navi's sign-ins waits for the browser on its profile to go.
const WIPE_WAIT: Duration = Duration::from_secs(20);
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
    /// Chrome's own sandbox: always, never, or (None) wherever this host allows it.
    pub sandbox: Option<bool>,
}

/// One launched Chrome: its process group, its profile and the node's pipe connection to it. Killed when dropped, and
/// its profile deleted unless it is a Navi's kept one.
pub struct Browser {
    child: Child,
    pgid: Option<i32>,
    pub profile: PathBuf,
    pub cdp: Arc<Cdp>,
    /// A fresh profile, deleted with the browser.
    throwaway: bool,
    /// The Navi's profile it runs on, held until it is gone.
    kept: Option<KeptLease>,
}

impl Browser {
    /// Whether it still runs.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Whether it runs on a Navi's kept profile.
    pub fn kept(&self) -> bool {
        self.kept.is_some()
    }

    /// Ends it. A Chrome on a kept profile is asked to close first, so it writes out the cookies it holds in memory
    /// (up to 30 s of them), then killed as any other, and what of the session the profile doesn't keep goes.
    pub async fn close(mut self) {
        let Some(kept) = self.kept.as_ref().map(|k| k.dir.clone()) else {
            return;
        };
        let _ = tokio::time::timeout(
            CLOSE_WAIT,
            self.cdp.call(None, "Browser.close", serde_json::json!({})),
        )
        .await;
        let _ = tokio::time::timeout(CLOSE_WAIT, self.child.wait()).await;
        self.kill();
        let _ = tokio::time::timeout(CLOSE_WAIT, self.child.wait()).await;
        prune_kept(&kept);
    }

    fn kill(&mut self) {
        if let Some(pgid) = self.pgid {
            let _ = killpg(Pid::from_raw(pgid), Signal::SIGKILL);
        }
        let _ = self.child.start_kill();
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.kill();
        if !self.throwaway {
            return;
        }
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
pub fn args(launch: &Launch, profile: &Path, sandboxed: bool) -> Vec<String> {
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
    if !sandboxed {
        args.push("--no-sandbox".to_owned());
    }
    args.push("about:blank".to_owned());
    args
}

/// Launches Chrome with its pipe on fds 3 (commands in) and 4 (answers out), which `sh` moves there from the
/// stdin and stdout the node holds, and waits until it answers. On a fresh profile, or on `kept`, a Navi's.
pub async fn launch(
    launch: &Launch,
    sandboxed: bool,
    kept: Option<&Path>,
) -> Result<Browser, String> {
    let throwaway = kept.is_none();
    let profile = match kept {
        Some(dir) => {
            ready_kept(dir)?;
            dir.to_owned()
        }
        None => {
            std::fs::create_dir_all(&launch.profiles)
                .map_err(|e| format!("cannot make {}: {e}", launch.profiles.display()))?;
            tempfile::Builder::new()
                .prefix("profile-")
                .tempdir_in(&launch.profiles)
                .map_err(|e| format!("cannot make a profile directory: {e}"))?
                .keep()
        }
    };
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(r#"exec "$0" "$@" 3<&0 4>&1 </dev/null >/dev/null"#)
        .arg(&launch.chrome)
        .args(args(launch, &profile, sandboxed))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            if throwaway {
                let _ = std::fs::remove_dir_all(&profile);
            }
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
        throwaway,
        kept: None,
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
    /// The host refused Chrome's sandbox once: launches go without it.
    no_sandbox: std::sync::atomic::AtomicBool,
}

impl Pool {
    pub fn new(launch: Launch, size: usize) -> Arc<Self> {
        Arc::new(Self {
            launch,
            size,
            warm: Mutex::default(),
            filling: tokio::sync::Mutex::new(()),
            no_sandbox: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn launch_settings(&self) -> &Launch {
        &self.launch
    }

    /// Whether the pool's browsers run without Chrome's sandbox: configured so, or this host refused it.
    pub fn unsandboxed(&self) -> bool {
        self.launch.sandbox == Some(false)
            || self.no_sandbox.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// One browser: sandboxed unless configured otherwise. A host that refuses the sandbox (no user namespaces, as
    /// Ubuntu's AppArmor has it) gets `--no-sandbox` from then on, with a warning, unless the sandbox is required.
    async fn launch_one(&self, kept: Option<&Path>) -> Result<Browser, String> {
        if self.unsandboxed() {
            return launch(&self.launch, false, kept).await;
        }
        match launch(&self.launch, true, kept).await {
            Ok(browser) => Ok(browser),
            Err(why) if self.launch.sandbox.is_none() => {
                let browser = launch(&self.launch, false, kept).await?;
                tracing::warn!(error = %why, "Chrome's sandbox refused on this host: browsers run with --no-sandbox");
                self.no_sandbox
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                Ok(browser)
            }
            Err(why) => Err(why),
        }
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
            None => self.launch_one(None).await?,
        };
        self.refill();
        Ok(browser)
    }

    /// A browser on a Navi's kept profile, launched now: the warm ones have fresh profiles. It holds `lease` until it
    /// is gone.
    pub async fn take_kept(&self, lease: KeptLease) -> Result<Browser, String> {
        let mut browser = self.launch_one(Some(&lease.dir)).await?;
        browser.kept = Some(lease);
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
                match pool.launch_one(None).await {
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

/// Where a Navi's kept profile lives: under the node's home, outside the Navi's folder, so only this node's Chrome
/// reads its cookies. None for a name that isn't a plain path component.
pub fn kept_dir(home: &Path, navi: &str) -> Option<PathBuf> {
    let plain = !navi.is_empty()
        && navi.len() <= 128
        && !navi.starts_with('.')
        && navi
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    plain.then(|| home.join("browser").join("navis").join(navi))
}

/// What a kept profile doesn't keep, in its `Default` dir: the HTTP and code caches (a page as a site showed it, a
/// filled value it echoed too), history, the session to restore, and the stores of saved passwords and form entries.
/// Sign-ins live in its cookies and site storage, which stay.
const NOT_KEPT: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Sessions",
    "Current Session",
    "Current Tabs",
    "Last Session",
    "Last Tabs",
    "History",
    "History-journal",
    "Visited Links",
    "Top Sites",
    "Top Sites-journal",
    "Favicons",
    "Favicons-journal",
    "Shortcuts",
    "Shortcuts-journal",
    "Network Action Predictor",
    "Network Action Predictor-journal",
    "Web Data",
    "Web Data-journal",
    "Login Data",
    "Login Data-journal",
    "Login Data For Account",
    "Login Data For Account-journal",
];

/// Deletes what a kept profile doesn't keep ([`NOT_KEPT`]), with no browser on it.
fn prune_kept(dir: &Path) {
    let default = dir.join("Default");
    for name in NOT_KEPT {
        let path = default.join(name);
        let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
    }
}

/// Chrome's preferences for a kept profile: it saves no password or form entry, so a value `fill_credential` typed
/// stays only in the session that typed it, which refuses reading it back (credentials.rs).
const KEPT_PREFS: &str = r#"{
  "credentials_enable_service": false,
  "credentials_enable_autosignin": false,
  "profile": { "password_manager_enabled": false },
  "autofill": { "enabled": false, "profile_enabled": false, "credit_card_enabled": false }
}"#;

/// Readies a kept profile for its next launch: made (only the node reads it) when new, its preferences set, and the
/// lock and leftovers of the browser before it cleared (the lease says none runs on it now; one killed leaves both).
fn ready_kept(dir: &Path) -> Result<(), String> {
    let fail =
        |e: std::io::Error| format!("cannot ready the Navi's profile {}: {e}", dir.display());
    crate::node::config::mkdir_private(&dir.join("Default")).map_err(fail)?;
    for lock in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
        let _ = std::fs::remove_file(dir.join(lock));
    }
    // Left by a browser that was killed (the node stopped) rather than closed.
    prune_kept(dir);
    let prefs = dir.join("Default").join("Preferences");
    let mut merged: serde_json::Value = std::fs::read(&prefs)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    merge(
        &mut merged,
        serde_json::from_str(KEPT_PREFS).expect("the kept profile's preferences"),
    );
    std::fs::write(&prefs, merged.to_string()).map_err(fail)
}

/// `over` written into `into`, object by object.
fn merge(into: &mut serde_json::Value, over: serde_json::Value) {
    match (into, over) {
        (serde_json::Value::Object(into), serde_json::Value::Object(over)) => {
            for (k, v) in over {
                merge(into.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (into, over) => *into = over,
    }
}

/// The Navis' kept profiles (D221), one browser on each at a time: a second session of the same Navi is refused
/// rather than started on a profile Chrome holds.
pub struct Kept {
    home: PathBuf,
    held: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// A Navi's profile, held by the one browser running on it (or a wipe) until it lets go.
pub struct KeptLease {
    pub dir: PathBuf,
    _held: tokio::sync::OwnedMutexGuard<()>,
}

impl Kept {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.to_owned(),
            held: Mutex::default(),
        }
    }

    fn lock_of(&self, navi: &str) -> Result<(PathBuf, Arc<tokio::sync::Mutex<()>>), String> {
        let dir = kept_dir(&self.home, navi).ok_or_else(|| format!("{navi} is no Navi's name"))?;
        let lock = self
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(navi.to_owned())
            .or_default()
            .clone();
        Ok((dir, lock))
    }

    /// The Navi's profile, unless a browser runs on it now (Err: why not).
    pub fn take(&self, navi: &str) -> Result<KeptLease, String> {
        let (dir, lock) = self.lock_of(navi)?;
        let held = lock
            .try_lock_owned()
            .map_err(|_| "This Navi's browser is open in another of its sessions".to_owned())?;
        Ok(KeptLease { dir, _held: held })
    }

    /// Deletes the Navi's profile, once the browser on it (ending now) has let go. Nothing there is no error.
    pub async fn wipe(&self, navi: &str) -> Result<(), String> {
        let (dir, lock) = self.lock_of(navi)?;
        let _held = tokio::time::timeout(WIPE_WAIT, lock.lock_owned())
            .await
            .map_err(|_| "its browser is still closing; try again in a minute".to_owned())?;
        wipe_dir(&dir)
    }
}

/// Deletes a kept profile directory, if there is one.
pub fn wipe_dir(dir: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot delete {}: {e}", dir.display())),
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
            sandbox: None,
        };
        let args = args(&launch, Path::new("/p/profile-1"), false);
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
        assert!(args.contains(&"--no-sandbox".to_owned()));
        let sandboxed = super::args(&launch, Path::new("/p/profile-1"), true);
        assert!(
            !sandboxed.contains(&"--no-sandbox".to_owned()),
            "sandboxed unless the host refuses it"
        );
    }

    #[tokio::test]
    async fn a_navis_profile_is_its_own_one_browser_at_a_time_and_keeps_only_sign_ins() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            kept_dir(home.path(), "ada"),
            Some(home.path().join("browser/navis/ada"))
        );
        for name in ["", "..", "../ada", "a/b", ".hidden"] {
            assert_eq!(kept_dir(home.path(), name), None, "{name:?}");
        }
        let kept = Kept::new(home.path());
        let ada = kept.take("ada").unwrap();
        assert!(kept.take("ada").is_err(), "one browser at a time");
        let bee = kept.take("bee").unwrap();
        assert_ne!(ada.dir, bee.dir);

        // What a killed browser left: its lock, a cache, history, a saved password; and its cookies.
        let default = ada.dir.join("Default");
        std::fs::create_dir_all(default.join("Cache/Cache_Data")).unwrap();
        std::fs::write(default.join("Cache/Cache_Data/x"), "a page").unwrap();
        for file in ["History", "Login Data", "Cookies"] {
            std::fs::write(default.join(file), "x").unwrap();
        }
        std::fs::write(
            default.join("Preferences"),
            r#"{"intl":{"accept_languages":"de"},"profile":{"name":"x"}}"#,
        )
        .unwrap();
        std::os::unix::fs::symlink("devbox-123", ada.dir.join("SingletonLock")).unwrap();
        ready_kept(&ada.dir).unwrap();
        assert!(default.join("Cookies").is_file(), "sign-ins stay");
        for gone in ["Cache", "History", "Login Data"] {
            assert!(!default.join(gone).exists(), "{gone}");
        }
        assert!(std::fs::symlink_metadata(ada.dir.join("SingletonLock")).is_err());
        let prefs: serde_json::Value =
            serde_json::from_slice(&std::fs::read(default.join("Preferences")).unwrap()).unwrap();
        assert_eq!(prefs["credentials_enable_service"], false);
        assert_eq!(prefs["profile"]["password_manager_enabled"], false);
        assert_eq!(prefs["autofill"]["profile_enabled"], false);
        assert_eq!(prefs["profile"]["name"], "x", "its own preferences stay");
        assert_eq!(prefs["intl"]["accept_languages"], "de");

        // A wipe waits for the browser on it to let go.
        let wiping = tokio::spawn(async move {
            let kept = kept;
            kept.wipe("ada").await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!wiping.is_finished());
        let dir = ada.dir.clone();
        drop(ada);
        wiping.await.unwrap().unwrap();
        assert!(!dir.exists());
        drop(bee);
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
