//! A session's display, and the warm pool of them. Each is an X server of its own with a random MIT cookie, so only
//! the node and the session's apps can reach it:
//!
//! - **container**: a fresh container of the pinned image (container.rs) runs Xvfb and a window manager; its X
//!   socket comes out through a bind-mounted directory, and apps launched in it see nothing of the host but the node's
//!   worktrees, read-only. `docker rm -f` throws it away.
//! - **xvfb**: an Xvfb on the host on a free display number (`-nolisten tcp -nolisten local`, so only its socket
//!   file), and apps launched as the node's user with a fresh home directory in the display's own folder, which goes
//!   with them.
use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::browser::DesktopBackend;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use rand::RngCore;

use super::container::Runtime;
use super::x11::{self, X};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The screen every session gets, in pixels.
pub const SIZE: (u16, u16) = (1280, 800);

/// Window managers the xvfb backend starts when the host has one, first found first.
const WINDOW_MANAGERS: [&str; 4] = ["openbox", "xfwm4", "fluxbox", "twm"];

/// Where X servers on the host put their sockets.
const X11_UNIX: &str = "/tmp/.X11-unix";

/// A program on the PATH.
pub fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// How the pool makes displays.
#[derive(Clone, Debug)]
pub struct Settings {
    pub backend: DesktopBackend,
    /// The container runtime, for `container`.
    pub runtime: Option<Runtime>,
    pub image: String,
    /// The Xvfb, for `xvfb`.
    pub xvfb: Option<PathBuf>,
    /// Where each display keeps its folder: cookie, sockets, home, logs.
    pub root: PathBuf,
    /// Folders of the host apps in a container see, read-only, at the same path: the node's worktrees.
    pub mounts: Vec<PathBuf>,
}

pub struct Display {
    pub backend: DesktopBackend,
    pub dir: PathBuf,
    /// The X socket the node connects to.
    pub socket: PathBuf,
    pub cookie: [u8; 16],
    /// The display's name as its apps see it (`:0` in a container, `:<n>` on the host).
    pub name: String,
    xvfb: Mutex<Option<Child>>,
    container: Option<(Runtime, String)>,
    /// Apps launched on the host: each in a process group of its own, killed with the display.
    apps: Mutex<Vec<Child>>,
    launched: AtomicU32,
}

/// What `launch` saw of an app in its first moments.
pub struct Launched {
    pub pid: u32,
    /// Exited already: its code, and the end of what it printed.
    pub exited: Option<(Option<i32>, String)>,
}

/// An X authority file naming `cookie` for any display on any host (FamilyWild).
pub(super) fn xauth(cookie: &[u8; 16]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0xffffu16.to_be_bytes());
    for field in [&b""[..], &b""[..], &b"MIT-MAGIC-COOKIE-1"[..], &cookie[..]] {
        out.extend_from_slice(&(field.len() as u16).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The end of a log, for a refusal.
fn tail(path: &Path, max: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let start = text.len().saturating_sub(max);
    let start = (start..text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    text[start..].trim().to_owned()
}

/// Waits for the X server behind `socket` to answer, while `alive` says it still runs.
fn wait_x(
    socket: &Path,
    cookie: &[u8; 16],
    mut alive: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let deadline = Instant::now() + x11::CONNECT_TIMEOUT;
    loop {
        alive()?;
        if socket.exists() && X::connect(socket, cookie).is_ok() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!(
                "its X server did not answer within {} s",
                x11::CONNECT_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// A display number free on the host: no lock file and no socket.
fn free_number() -> Option<u32> {
    (100..600).find(|n| {
        !Path::new(&format!("/tmp/.X{n}-lock")).exists()
            && !Path::new(X11_UNIX).join(format!("X{n}")).exists()
    })
}

impl Display {
    /// Starts a display now (blocking: a second or so for a container, less for Xvfb).
    pub fn start(settings: &Settings) -> Result<Self, String> {
        let mut cookie = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut cookie);
        let mut tag = [0u8; 6];
        rand::thread_rng().fill_bytes(&mut tag);
        let dir = settings.root.join(hex(&tag));
        crate::node::config::mkdir_private(&dir)
            .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        let made = match settings.backend {
            DesktopBackend::Xvfb => Self::start_xvfb(settings, &dir, cookie),
            DesktopBackend::Container => Self::start_container(settings, &dir, cookie, &hex(&tag)),
        };
        if made.is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        made
    }

    fn start_xvfb(settings: &Settings, dir: &Path, cookie: [u8; 16]) -> Result<Self, String> {
        let xvfb = settings.xvfb.as_ref().ok_or("this machine has no Xvfb")?;
        let auth = dir.join("xauth");
        write_private(&auth, &xauth(&cookie))
            .map_err(|e| format!("cannot write the X cookie: {e}"))?;
        for home in ["home", "run"] {
            crate::node::config::mkdir_private(&dir.join(home))
                .map_err(|e| format!("cannot make the display's {home}: {e}"))?;
        }
        let mut last = String::new();
        // A number another X server takes meanwhile is tried again with the next.
        for _ in 0..3 {
            let number = free_number().ok_or("every X display number from 100 to 599 is taken")?;
            let log = dir.join("xvfb.log");
            let out = File::create(&log).map_err(|e| e.to_string())?;
            let (w, h) = SIZE;
            let mut child = Command::new(xvfb)
                .arg(format!(":{number}"))
                .args(["-screen", "0", &format!("{w}x{h}x24")])
                .args(["-nolisten", "tcp", "-nolisten", "local", "-noreset"])
                .arg("-auth")
                .arg(&auth)
                .stdin(Stdio::null())
                .stdout(out.try_clone().map_err(|e| e.to_string())?)
                .stderr(out)
                .process_group(0)
                .spawn()
                .map_err(|e| format!("cannot run {}: {e}", xvfb.display()))?;
            let _ = std::fs::write(dir.join("xvfb.pid"), child.id().to_string());
            let socket = Path::new(X11_UNIX).join(format!("X{number}"));
            let ready = wait_x(&socket, &cookie, || match child.try_wait() {
                Ok(Some(status)) => Err(format!("Xvfb exited ({status}): {}", tail(&log, 600))),
                _ => Ok(()),
            });
            match ready {
                Ok(()) => {
                    let display = Self {
                        backend: DesktopBackend::Xvfb,
                        dir: dir.to_owned(),
                        socket,
                        cookie,
                        name: format!(":{number}"),
                        xvfb: Mutex::new(Some(child)),
                        container: None,
                        apps: Mutex::default(),
                        launched: AtomicU32::new(0),
                    };
                    if let Some(wm) = WINDOW_MANAGERS.iter().find_map(|wm| on_path(wm)) {
                        let _ = display.spawn_host(&wm.to_string_lossy(), None, "wm.log");
                    }
                    return Ok(display);
                }
                Err(why) => {
                    let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
                    let _ = child.wait();
                    last = why;
                }
            }
        }
        Err(last)
    }

    fn start_container(
        settings: &Settings,
        dir: &Path,
        cookie: [u8; 16],
        tag: &str,
    ) -> Result<Self, String> {
        let runtime = settings
            .runtime
            .as_ref()
            .ok_or("this machine has no container runtime")?;
        let sockets = dir.join("x11");
        std::fs::create_dir_all(&sockets).map_err(|e| e.to_string())?;
        // Xvfb in the container makes its socket here, as whichever user the runtime maps it to.
        std::fs::set_permissions(&sockets, std::fs::Permissions::from_mode(0o1777))
            .map_err(|e| e.to_string())?;
        let auth = dir.join("xauth");
        std::fs::write(&auth, xauth(&cookie))
            .map_err(|e| format!("cannot write the X cookie: {e}"))?;
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o644))
            .map_err(|e| e.to_string())?;
        // The display's folder is the node's own; the container's user must reach the two above through it.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o711))
            .map_err(|e| e.to_string())?;
        let name = format!("{}{tag}", super::container::NAME_PREFIX);
        runtime.run(&name, &settings.image, &sockets, &auth, &settings.mounts)?;
        let socket = sockets.join("X0");
        let ready = wait_x(&socket, &cookie, || runtime.running(&name));
        if let Err(why) = ready {
            let logs = runtime.logs(&name);
            runtime.remove(&name);
            return Err(match logs.is_empty() {
                true => why,
                false => format!("{why}: {logs}"),
            });
        }
        Ok(Self {
            backend: DesktopBackend::Container,
            dir: dir.to_owned(),
            socket,
            cookie,
            name: ":0".into(),
            xvfb: Mutex::default(),
            container: Some((runtime.clone(), name)),
            apps: Mutex::default(),
            launched: AtomicU32::new(0),
        })
    }

    /// Whether its X server still runs (a container checked with its runtime).
    pub fn alive(&self) -> bool {
        if let Some((runtime, name)) = &self.container {
            return runtime.running(name).is_ok();
        }
        lock(&self.xvfb)
            .as_mut()
            .is_some_and(|c| matches!(c.try_wait(), Ok(None)))
    }

    pub fn connect(&self) -> Result<X, String> {
        X::connect(&self.socket, &self.cookie)
    }

    /// The environment of an app on the host: its display, its fresh home, and nothing of the node's but PATH.
    fn host_env(&self) -> Vec<(String, String)> {
        let home = self.dir.join("home");
        let at = |p: &str| home.join(p).to_string_lossy().into_owned();
        let mut env = vec![
            ("DISPLAY".to_owned(), self.name.clone()),
            (
                "XAUTHORITY".to_owned(),
                self.dir.join("xauth").to_string_lossy().into_owned(),
            ),
            ("HOME".to_owned(), home.to_string_lossy().into_owned()),
            ("XDG_CONFIG_HOME".to_owned(), at(".config")),
            ("XDG_CACHE_HOME".to_owned(), at(".cache")),
            ("XDG_DATA_HOME".to_owned(), at(".local/share")),
            ("XDG_STATE_HOME".to_owned(), at(".local/state")),
            (
                "XDG_RUNTIME_DIR".to_owned(),
                self.dir.join("run").to_string_lossy().into_owned(),
            ),
            ("LANG".to_owned(), "C.UTF-8".to_owned()),
            // A terminal opens a plain shell, not the node user's own with its first-run wizard in a fresh home.
            (
                "SHELL".to_owned(),
                ["/bin/bash", "/bin/sh"]
                    .into_iter()
                    .find(|s| Path::new(s).is_file())
                    .unwrap_or("/bin/sh")
                    .to_owned(),
            ),
        ];
        if let Some(path) = std::env::var_os("PATH") {
            env.push(("PATH".to_owned(), path.to_string_lossy().into_owned()));
        }
        env
    }

    fn spawn_host(&self, command: &str, cwd: Option<&Path>, log: &str) -> Result<u32, String> {
        let out = File::create(self.dir.join(log)).map_err(|e| e.to_string())?;
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(command)
            .env_clear()
            .envs(self.host_env())
            .current_dir(cwd.filter(|c| c.is_dir()).unwrap_or(&self.dir.join("home")))
            .stdin(Stdio::null())
            .stdout(out.try_clone().map_err(|e| e.to_string())?)
            .stderr(out)
            .process_group(0);
        let child = cmd.spawn().map_err(|e| format!("cannot start it: {e}"))?;
        let pid = child.id();
        lock(&self.apps).push(child);
        Ok(pid)
    }

    /// Starts `command` with `sh -c` on the display, in `cwd` where the app can see it, and looks at it a moment
    /// later (blocking).
    pub fn launch(&self, command: &str, cwd: &Path) -> Result<Launched, String> {
        let n = self.launched.fetch_add(1, Ordering::Relaxed) + 1;
        let settle = Duration::from_millis(500);
        match &self.container {
            Some((runtime, name)) => runtime.launch(name, command, cwd, n, settle),
            None => {
                let log = format!("launch-{n}.log");
                let pid = self.spawn_host(command, Some(cwd), &log)?;
                std::thread::sleep(settle);
                let mut apps = lock(&self.apps);
                let exited = apps
                    .iter_mut()
                    .find(|c| c.id() == pid)
                    .and_then(|c| c.try_wait().ok().flatten())
                    .map(|status| (status.code(), tail(&self.dir.join(&log), 1500)));
                Ok(Launched { pid, exited })
            }
        }
    }
}

impl Drop for Display {
    /// Everything on the display goes: its apps, its X server or container, and its folder.
    fn drop(&mut self) {
        for mut app in lock(&self.apps).drain(..) {
            let _ = killpg(Pid::from_raw(app.id() as i32), Signal::SIGKILL);
            let _ = app.wait();
        }
        if let Some(mut xvfb) = lock(&self.xvfb).take() {
            let _ = killpg(Pid::from_raw(xvfb.id() as i32), Signal::SIGKILL);
            let _ = xvfb.wait();
        }
        if let Some((runtime, name)) = &self.container {
            runtime.remove(name);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Kills what a node that died left behind: Xvfbs by the pid files in their folders, the folders, and containers by
/// their label.
pub fn clear_leftovers(root: &Path, runtime: Option<&Runtime>) -> usize {
    let mut cleared = 0;
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let pid = std::fs::read_to_string(entry.path().join("xvfb.pid"))
            .ok()
            .and_then(|p| p.trim().parse::<i32>().ok());
        if let Some(pid) = pid
            && killpg(Pid::from_raw(pid), Signal::SIGKILL).is_ok()
        {
            cleared += 1;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
    if let Some(runtime) = runtime {
        cleared += runtime.remove_leftovers();
    }
    cleared
}

/// Displays started ahead for the next sessions.
pub struct Pool {
    settings: Settings,
    size: usize,
    warm: Mutex<VecDeque<Display>>,
    filling: tokio::sync::Mutex<()>,
    /// Drained (the node stops): a start under way throws its display away instead of keeping it.
    closed: AtomicBool,
}

impl Pool {
    pub fn new(settings: Settings, size: usize) -> Arc<Self> {
        Arc::new(Self {
            settings,
            size,
            warm: Mutex::default(),
            filling: tokio::sync::Mutex::new(()),
            closed: AtomicBool::new(false),
        })
    }

    pub fn backend(&self) -> DesktopBackend {
        self.settings.backend
    }

    async fn make(&self) -> Result<Display, String> {
        let settings = self.settings.clone();
        tokio::task::spawn_blocking(move || Display::start(&settings))
            .await
            .map_err(|e| e.to_string())?
    }

    /// A started display, or one started now when none waits; the pool refills behind it.
    pub async fn take(self: &Arc<Self>) -> Result<Display, String> {
        let warm = loop {
            let next = lock(&self.warm).pop_front();
            match next {
                Some(display) if display.alive() => break Some(display),
                // One that died while it waited goes (dropped); try the next.
                Some(_) => continue,
                None => break None,
            }
        };
        let display = match warm {
            Some(display) => display,
            None => self.make().await?,
        };
        self.refill();
        Ok(display)
    }

    /// Starts displays in the background until the pool holds its size.
    pub fn refill(self: &Arc<Self>) {
        let pool = self.clone();
        tokio::spawn(async move {
            let Ok(_filling) = pool.filling.try_lock() else {
                return;
            };
            while lock(&pool.warm).len() < pool.size {
                if pool.closed.load(Ordering::Relaxed) {
                    return;
                }
                match pool.make().await {
                    Ok(display) if pool.closed.load(Ordering::Relaxed) => drop(display),
                    Ok(display) => lock(&pool.warm).push_back(display),
                    Err(e) => {
                        tracing::warn!(error = %e, "desktop pool not refilled");
                        return;
                    }
                }
            }
        });
    }

    pub fn warm(&self) -> usize {
        lock(&self.warm).len()
    }

    /// Throws every waiting display away.
    pub fn drain(&self) {
        self.closed.store(true, Ordering::Relaxed);
        let drained: Vec<Display> = lock(&self.warm).drain(..).collect();
        drop(drained);
    }
}

/// Writes `bytes` to a new file only the node reads.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = File::create(path)?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)
}
