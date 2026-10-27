//! The OS sandbox a Navi's session runs in (D196): claude and every process it starts (a command, an MCP server,
//! agent-browser's daemon) write only inside the Navi's folder, its scratch dir and claude's own state for the session,
//! and read nothing of fleetd's, other projects', or the logins people keep in their home. The per-tool checks
//! (`claude::role_answer`, the hub's site gate) stay as a second layer; the sandbox holds whatever gap a tool or a
//! trick finds in them. Network stays as it is: the site gate decides.
//!
//! - Linux: bubblewrap, and only bubblewrap (D: navi.sandbox-linux-requires-bwrap). The whole machine is mounted
//!   read-only, hidden paths get an empty read-only tmpfs (or `/dev/null` for a file), and the paths the Navi needs are
//!   bound back on top. It gets its own `/tmp`, `/proc` and pid namespace, so no other process (and no
//!   `/proc/<pid>/root` into the real disk) is in reach, and none of the runtime dir's sockets (the user's D-Bus and
//!   systemd, which would start a command outside).
//! - macOS: `sandbox-exec` with a profile made here: writes only to the same paths, and no reading the hidden ones.
//!
//! A sandbox that can't start never falls back to none: the session is refused with how to fix it ([`Refusal`]).
//! Only Navis are fenced; every other session runs as before.
use std::path::{Path, PathBuf};

use fleetd_contracts::sessions::{NaviSandbox, SandboxStatus};

/// What a fenced session may touch. Everything else on the machine reads as it is and takes no writes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fence {
    /// Read and written.
    pub write: Vec<PathBuf>,
    /// Neither read nor written.
    pub hide: Vec<PathBuf>,
    /// Read again inside a hidden path, never written.
    pub show: Vec<PathBuf>,
    /// Read but never written inside a written path.
    pub keep: Vec<PathBuf>,
    /// `(private, shared)`: the session's own `private` dir, read and written where `shared` is, so what it writes
    /// there reaches no other session. Linux only: on macOS `shared` is read-only.
    pub private: Vec<(PathBuf, PathBuf)>,
    /// `(real, copy)`: claude's global config (`~/.claude.json`) and the session's sanitized copy of it
    /// ([`sanitized_config`]), read and written in its place on Linux. On macOS, where nothing can stand in for a
    /// path, the real one is hidden.
    pub config_copy: Option<(PathBuf, PathBuf)>,
}

/// Why a fenced session can't start, and what a person does about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub fix: String,
}

/// In the user's home: where people keep their logins, keys and history. Hidden, with fleetd's own dir.
const HIDDEN_IN_HOME: &[&str] = &[
    ".config",
    ".ssh",
    ".gnupg",
    ".aws",
    ".netrc",
    ".git-credentials",
    ".docker",
    ".kube",
    ".password-store",
    ".local/share/keyrings",
    ".npmrc",
    ".pypirc",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".android/adbkey",
    ".mozilla",
    ".bash_history",
    ".zsh_history",
    ".python_history",
    ".node_repl_history",
    // The cookie for the person's X server; its socket is hidden below, and DISPLAY unset.
    ".Xauthority",
    // Other sessions' agent-browser daemons listen here; a Navi's own listens in its scratch dir.
    ".agent-browser",
    "snap",
    ".pgpass",
    ".vault-token",
    ".azure",
    ".terraform.d",
    ".local/share/fish/fish_history",
];

/// In the user's home on macOS: `~/Library` whole, where browsers keep cookies, apps their tokens, and the keychains
/// are. claude reads its login through the keychain's daemon, never the files.
const HIDDEN_IN_HOME_MACOS: &[&str] = &["Library"];

/// The X server's sockets: a command that reached the person's screen could type into a terminal outside.
const HIDDEN_X: &str = "/tmp/.X11-unix";

/// Sockets outside the home that run commands as someone else.
const HIDDEN_SOCKETS: &[&str] = &["/run/docker.sock", "/var/run/docker.sock"];

/// The node's tools a Navi runs (agent-browser, agent-device), shown again inside the hidden node home: programs, no
/// state. Chrome's profiles, beside them, stay hidden.
const NODE_TOOLS: &[&str] = &["browser/agent-browser", "device"];

/// claude's state that every session in its config dir shares, and reads back: a shell snapshot every command sources,
/// todos and plans it shows the model. A Navi writes its own copy of each, never the one other sessions read.
const CLAUDE_SHARED: &[&str] = &[
    "shell-snapshots",
    "todos",
    "tasks",
    "plans",
    "paste-cache",
    "statsig",
    "debug",
    "telemetry",
];

/// claude's state of one session, in a dir named by its id.
const CLAUDE_OWN: &[&str] = &["session-env", "file-history"];

/// claude's record of every other session in its config dir, hidden: each project's and task's conversations (file
/// contents, tool output), the prompt history, and their file backups and environments. The Navi's own are bound back.
const CLAUDE_HIDDEN: &[&str] = &[
    "projects",
    "history.jsonl",
    "file-history",
    "session-env",
    "sessions",
    // IDE connections (their lock files hold an auth token), and backups of `~/.claude.json` with its MCP servers.
    "ide",
    "backups",
];

/// Where a Navi's session runs, and what it needs.
pub struct NaviPaths<'a> {
    pub user_home: &'a Path,
    /// `~/.fleetd`, or `$FLEETD_HOME`.
    pub fleetd_dir: &'a Path,
    /// The node's home, where the folder, scratch and session dirs are.
    pub node_home: &'a Path,
    /// The Navi's folder, its cwd.
    pub folder: &'a Path,
    pub scratch: &'a Path,
    /// fleetd's files for the session: its MCP config, settings overlay, skills, browser config.
    pub session_dir: &'a Path,
    pub session_id: &'a str,
    /// claude's config dir: `~/.claude`, or `$CLAUDE_CONFIG_DIR`.
    pub claude_dir: &'a Path,
    /// claude's global config: `~/.claude.json`, or `.claude.json` in `$CLAUDE_CONFIG_DIR`.
    pub claude_json: &'a Path,
    /// The `fleetd` binary claude starts as fleetd's MCP server.
    pub exe: &'a Path,
    /// The node's socket that server speaks to.
    pub socket: &'a Path,
    /// `$XDG_RUNTIME_DIR`: the user's D-Bus, systemd and agent sockets.
    pub runtime_dir: Option<&'a Path>,
    /// Every other project's root on this node.
    pub other_roots: Vec<PathBuf>,
    /// The `claude` binary the node runs.
    pub claude_bin: &'a Path,
    /// The session's PATH: its programs in the home are read again (Linux).
    pub path: Vec<PathBuf>,
}

/// In the user's home on Linux, read again inside its empty tmpfs: git's own settings. Nothing else of the home is
/// there but the programs a Navi runs ([`home_programs`]) and the paths its fence names.
const HOME_READ: &[&str] = &[".gitconfig", ".config/git"];

/// The programs a Navi runs from the user's home, read-only: claude's binary; every PATH dir in the home, as its
/// install when it is a `bin` (`~/.nvm/versions/node/v22` for its `bin`, so npm finds its modules), but `~/.local/bin`
/// alone; and the dir each program there links to elsewhere in the home (`~/.local/bin/claude` →
/// `~/.local/share/claude/versions/…`).
fn home_programs(home: &Path, claude: &Path, path: &[PathBuf]) -> Vec<PathBuf> {
    let inside = |p: &Path| p.starts_with(home) && p != home;
    let mut dirs = Vec::new();
    let mut programs = vec![claude.to_owned()];
    if inside(claude) {
        dirs.push(claude.to_owned());
    }
    for dir in path.iter().map(|d| real(d)).filter(|d| inside(d)) {
        let install = match (dir.file_name(), dir.parent()) {
            (Some(name), Some(parent))
                if name == "bin" && inside(parent) && parent != home.join(".local") =>
            {
                parent.to_owned()
            }
            _ => dir.clone(),
        };
        dirs.push(install);
        programs.extend(
            std::fs::read_dir(&dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path()),
        );
    }
    for program in programs {
        let target = real(&program);
        if target != program
            && inside(&target)
            && let Some(dir) = target.parent().filter(|d| inside(d))
        {
            dirs.push(dir.to_owned());
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

/// `path` with symlinks resolved, through its nearest part that exists: the sandbox sees real paths, and a symlink
/// must not name a way around it.
pub fn real(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut base = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(base) {
            return rest
                .iter()
                .rev()
                .fold(real, |p: PathBuf, part| p.join(part));
        }
        match (base.file_name(), base.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_owned());
                base = parent;
            }
            _ => return path.to_owned(),
        }
    }
}

/// The fence of a Navi's session.
pub fn navi_fence(p: &NaviPaths) -> Fence {
    let folder = real(p.folder);
    let claude = real(p.claude_dir);
    let mut write = vec![folder.clone(), real(p.scratch)];
    // Its conversation, which a resume reads back.
    if let Some(dir) = super::claude::session_file(&claude, &folder, p.session_id)
        .and_then(|f| f.parent().map(Path::to_owned))
    {
        write.push(dir);
    }
    write.extend(CLAUDE_OWN.iter().map(|d| claude.join(d).join(p.session_id)));
    // claude's login file, where it has one: a refresh rotates the token, and one it couldn't save would log out every
    // session on the machine. It reads the file anyway.
    let credentials = claude.join(".credentials.json");
    if credentials.is_file() {
        write.push(credentials);
    }
    // Its agent-device's daemon and logs.
    write.push(real(&p.session_dir.join("agent-device")));
    let mut private: Vec<(PathBuf, PathBuf)> = CLAUDE_SHARED
        .iter()
        .map(|d| (real(&p.session_dir.join("claude").join(d)), claude.join(d)))
        .collect();
    let keep = super::claude::ASSISTANT_KEPT
        .iter()
        .map(|k| folder.join(k))
        .collect();

    let user_home = real(p.user_home);
    let mut hide = vec![real(p.fleetd_dir), real(p.node_home)];
    hide.extend(HIDDEN_IN_HOME.iter().map(|h| user_home.join(h)));
    hide.extend(HIDDEN_SOCKETS.iter().map(|s| real(Path::new(s))));
    hide.extend(p.runtime_dir.map(real));
    hide.extend(CLAUDE_HIDDEN.iter().map(|h| claude.join(h)));
    hide.push(real(Path::new(HIDDEN_X)));
    if cfg!(target_os = "macos") {
        hide.extend(HIDDEN_IN_HOME_MACOS.iter().map(|h| user_home.join(h)));
    }
    // Another project's root, unless the Navi's own folder or the whole home is in it.
    hide.extend(
        p.other_roots
            .iter()
            .map(|r| real(r))
            .filter(|r| !folder.starts_with(r) && !user_home.starts_with(r)),
    );
    hide.sort();
    hide.dedup();

    // claude's config dir is read again where it is hidden (under `~/.config`), but for [`CLAUDE_HIDDEN`].
    let mut show = vec![real(p.session_dir), real(p.exe), real(p.socket), claude];
    show.extend(NODE_TOOLS.iter().map(|t| real(&p.node_home.join(t))));
    // Its own copy of claude's global config, without other tools' secrets, where there is one to stand in for.
    // Linux: the home is an allow-list. It gets an empty tmpfs, and only what the fence names comes back, so nothing
    // else there, made before the session or during it (another session's `.claude.json.tmp…`), is ever in sight.
    let home_listed = cfg!(target_os = "linux");
    if home_listed {
        hide.push(user_home.clone());
        show.extend(home_programs(&user_home, &real(p.claude_bin), &p.path));
        show.extend(HOME_READ.iter().map(|f| user_home.join(f)));
        // Caches (claude's logs, a tool's downloads) written where every program looks, but its own.
        private.push((
            real(&p.session_dir.join("home-cache")),
            user_home.join(".cache"),
        ));
    }
    let claude_json = real(p.claude_json);
    // In the listed home there need be nothing under it: its copy stands where the real one would.
    let in_listed_home = home_listed && claude_json.parent() == Some(user_home.as_path());
    let config_copy = (claude_json.is_file() || in_listed_home).then(|| {
        (
            claude_json.clone(),
            real(&p.session_dir.join("claude").join(".claude.json")),
        )
    });
    if cfg!(target_os = "macos")
        && let Some((config, _)) = &config_copy
    {
        hide.push(config.clone());
    }
    // claude's backups and other copies of it beside it (`.claude.json.backup.<time>`), with the same MCP servers,
    // where the home isn't listed already.
    if let (false, Some(dir), Some(name)) = (
        in_listed_home,
        claude_json.parent(),
        claude_json.file_name(),
    ) {
        let prefix = format!("{}.", name.to_string_lossy());
        hide.extend(
            std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
                .map(|e| e.path()),
        );
    }
    // In the listed home, a hidden path matters only inside what comes back (`~/.claude/projects` in `~/.claude`,
    // cargo's credentials in its install): the rest is out of sight already, and isn't mounted over.
    if home_listed {
        let back: Vec<&PathBuf> = show
            .iter()
            .chain(&write)
            .chain(private.iter().map(|(_, to)| to))
            .collect();
        hide.retain(|h| {
            !h.starts_with(&user_home)
                || *h == user_home
                || back.iter().any(|b| h.starts_with(b) && h != *b)
        });
    }
    Fence {
        write,
        hide,
        show,
        keep,
        private,
        config_copy,
    }
}

impl Fence {
    /// Makes what the sandbox mounts and the session writes: its written dirs, its private dirs and where they go,
    /// and the folder's kept dirs, so nothing can make them later. A kept file is kept only once it exists.
    pub fn prepare(&self) -> std::io::Result<()> {
        for dir in self
            .write
            .iter()
            .chain(self.private.iter().flat_map(|(a, b)| [a, b]))
        {
            // A written file (claude's login) is there already.
            if !dir.is_file() {
                std::fs::create_dir_all(dir)?;
            }
        }
        for kept in &self.keep {
            if kept.extension().is_none() && !kept.exists() {
                std::fs::create_dir_all(kept)?;
            }
        }
        // Copied fresh at each start, so nothing the Navi left in its copy outlives the session it wrote it in.
        if let Some((config, copy)) = &self.config_copy {
            let text = std::fs::read_to_string(config).unwrap_or_default();
            if let Some(dir) = copy.parent() {
                std::fs::create_dir_all(dir)?;
            }
            crate::node::secrets::write_atomic(copy, sanitized_config(&text).as_bytes())?;
        }
        Ok(())
    }
}

/// Top-level keys of claude's global config a Navi's copy leaves out: MCP servers (theirs carry tokens in their
/// environment and headers) and every project's entry (each with its own servers and history).
const CONFIG_DROPPED: &[&str] = &["mcpServers", "projects"];

/// Words in a key's name that say it holds a secret: such a key is left out too, but for claude's own login
/// (`primaryApiKey`), which the Navi's claude needs and can read in its login file anyway.
const SECRET_WORDS: &[&str] = &[
    "token",
    "secret",
    "password",
    "credential",
    "apikey",
    "api_key",
];

/// claude's global config (`~/.claude.json`) as a Navi gets it: without [`CONFIG_DROPPED`] or any key named like a
/// secret. Text that isn't a JSON object becomes `{}`.
pub fn sanitized_config(text: &str) -> String {
    let Ok(serde_json::Value::Object(mut config)) = serde_json::from_str(text) else {
        return "{}\n".into();
    };
    config.retain(|key, _| {
        let lower = key.to_lowercase();
        key == "primaryApiKey"
            || !(CONFIG_DROPPED.contains(&key.as_str())
                || SECRET_WORDS.iter().any(|w| lower.contains(w)))
    });
    format!("{}\n", serde_json::Value::Object(config))
}

/// `program args` as it runs inside `fence`, in `cwd`: the sandbox's own program and arguments first. A sandbox that
/// can't start here is refused, never skipped.
pub fn wrap(
    fence: &Fence,
    cwd: &Path,
    program: &Path,
    args: Vec<String>,
) -> Result<(PathBuf, Vec<String>), Refusal> {
    let tool = tool().ok_or_else(missing)?;
    Ok(command(tool, fence, cwd, program, args))
}

/// Makes the fence's paths ready and starts the sandbox once with nothing to run, so one that can't start says why
/// before a session, not as a session that ends at once. It waits on a process: run it off the async runtime.
pub fn check(fence: &Fence, cwd: &Path) -> Result<(), Refusal> {
    check_with(tool(), fence, cwd).map(drop)
}

/// The sandbox's program on this machine: bubblewrap on Linux, `sandbox-exec` on macOS.
pub fn tool() -> Option<PathBuf> {
    let name = if cfg!(target_os = "macos") {
        "sandbox-exec"
    } else {
        "bwrap"
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain([PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// [`check`], then [`wrap`], with `tool` as the sandbox's program, or none.
pub fn wrap_with(
    tool: Option<PathBuf>,
    fence: &Fence,
    cwd: &Path,
    program: &Path,
    args: Vec<String>,
) -> Result<(PathBuf, Vec<String>), Refusal> {
    let tool = check_with(tool, fence, cwd)?;
    Ok(command(tool, fence, cwd, program, args))
}

/// [`check`] with `tool` as the sandbox's program, or none: the program, once it started.
fn check_with(tool: Option<PathBuf>, fence: &Fence, cwd: &Path) -> Result<PathBuf, Refusal> {
    let Some(tool) = tool else {
        return Err(missing());
    };
    if let Err(e) = fence.prepare() {
        return Err(Refusal {
            message: format!("This Navi's sandbox could not be made ready: {e}"),
            fix: "Check that the node's home and the Navi's folder are writable, then send again."
                .into(),
        });
    }
    let start = |own: &[String]| {
        let mut probe = std::process::Command::new(&tool);
        probe
            .args(own)
            .arg(if cfg!(target_os = "macos") {
                "/usr/bin/true"
            } else {
                "true"
            })
            .env_clear()
            .stdin(std::process::Stdio::null());
        with_scope(&mut probe);
        match probe.output() {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => Err(failed(&tool, &String::from_utf8_lossy(&out.stderr))),
            Err(e) => Err(failed(&tool, &e.to_string())),
        }
    };
    let own = own_args(fence, cwd);
    match start(&own) {
        Ok(()) => Ok(tool),
        // A hidden file that went away meanwhile (a short-lived copy of claude's config) leaves nothing to mount over:
        // once more without it.
        Err(refused) => {
            let again = own_args(fence, cwd);
            if again == own {
                return Err(refused);
            }
            start(&again).map(|()| tool)
        }
    }
}

/// `program args` inside the sandbox `tool`.
fn command(
    tool: PathBuf,
    fence: &Fence,
    cwd: &Path,
    program: &Path,
    args: Vec<String>,
) -> (PathBuf, Vec<String>) {
    let mut all = own_args(fence, cwd);
    all.push(program.to_string_lossy().into_owned());
    all.extend(args);
    (tool, all)
}

/// Landlock's ABI that scopes abstract Unix sockets (Linux 6.12).
const SCOPE_ABI: i64 = 6;

/// The Landlock ABI this kernel speaks; 0 without Landlock, or off Linux.
pub fn landlock_abi() -> i64 {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: LANDLOCK_CREATE_RULESET_VERSION with no attributes only asks for the version.
        let abi = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<u8>(),
                0usize,
                1u32,
            )
        };
        #[allow(clippy::needless_return)]
        return abi.max(0);
    }
    #[cfg(not(target_os = "linux"))]
    0
}

/// What runs in the sandbox's own process before it execs bubblewrap, where the kernel has it: a Landlock domain that
/// handles no file access (so bubblewrap still mounts) and scopes abstract Unix sockets. Nothing inside can then
/// connect to one made outside, such as an X server's `@/tmp/.X11-unix/X0` or a D-Bus bus, though the network is
/// shared. Its own processes still reach each other's. None off Linux or below [`SCOPE_ABI`].
pub fn scope_hook() -> Option<fn() -> std::io::Result<()>> {
    #[cfg(target_os = "linux")]
    if landlock_abi() >= SCOPE_ABI {
        return Some(scope_sockets);
    }
    None
}

/// Runs between fork and exec, so only system calls: no allocation, no lock.
#[cfg(target_os = "linux")]
fn scope_sockets() -> std::io::Result<()> {
    #[repr(C)]
    struct Attr {
        handled_access_fs: u64,
        handled_access_net: u64,
        scoped: u64,
    }
    const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1;
    let attr = Attr {
        handled_access_fs: 0,
        handled_access_net: 0,
        scoped: SCOPE_ABSTRACT_UNIX_SOCKET,
    };
    // SAFETY: plain system calls on a ruleset this function owns and closes.
    unsafe {
        let fd = libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr as *const Attr,
            std::mem::size_of::<Attr>(),
            0u32,
        );
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let fd = fd as libc::c_int;
        let restricted = if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 {
            libc::syscall(libc::SYS_landlock_restrict_self, fd, 0u32)
        } else {
            -1
        };
        let error = std::io::Error::last_os_error();
        libc::close(fd);
        if restricted != 0 {
            return Err(error);
        }
    }
    Ok(())
}

/// What a person reads about a Navi's sandbox on this machine (`RunnerInfo.sandbox`): which one, any gap, and the fix.
/// None on a system fleetd has no sandbox for.
pub fn describe() -> Option<NaviSandbox> {
    if !cfg!(any(target_os = "linux", target_os = "macos")) {
        return None;
    }
    let Some(tool) = tool() else {
        let refused = missing();
        return Some(NaviSandbox {
            status: SandboxStatus::Missing,
            line: refused.message,
            fix: Some(refused.fix),
        });
    };
    if cfg!(target_os = "macos") {
        return Some(NaviSandbox {
            status: SandboxStatus::Ready,
            line: "Navis run in sandbox-exec.".into(),
            fix: None,
        });
    }
    let mut probe = std::process::Command::new(&tool);
    probe
        .args(["--ro-bind", "/", "/", "--unshare-all", "true"])
        .env_clear()
        .stdin(std::process::Stdio::null());
    with_scope(&mut probe);
    let why = match probe.output() {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(String::from_utf8_lossy(&out.stderr).into_owned()),
        Err(e) => Some(e.to_string()),
    };
    Some(match why {
        Some(why) => {
            let refused = failed(&tool, &why);
            NaviSandbox {
                status: SandboxStatus::Missing,
                line: refused.message,
                fix: Some(refused.fix),
            }
        }
        None if scope_hook().is_some() => NaviSandbox {
            status: SandboxStatus::Ready,
            line: "Navis run in bubblewrap, with abstract sockets scoped (Landlock).".into(),
            fix: None,
        },
        None => NaviSandbox {
            status: SandboxStatus::Gap,
            line: "Navis run in bubblewrap, but this kernel can't scope abstract sockets (Landlock 6, Linux 6.12): a \
                   Navi can reach an X server that takes local connections without a cookie."
                .into(),
            fix: Some("Update the kernel to Linux 6.12 or later.".into()),
        },
    })
}

/// `command` with [`scope_hook`] run before it execs, where the kernel has it.
pub fn with_scope(command: &mut std::process::Command) {
    if let Some(hook) = scope_hook() {
        // SAFETY: the hook makes system calls only.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(command, hook);
        }
    }
}

/// The sandbox's own arguments, up to the command.
fn own_args(fence: &Fence, cwd: &Path) -> Vec<String> {
    if cfg!(target_os = "macos") {
        vec!["-p".into(), seatbelt(fence)]
    } else {
        bwrap_args(fence, cwd)
    }
}

fn missing() -> Refusal {
    if cfg!(target_os = "macos") {
        Refusal {
            message: "A Navi runs only inside a sandbox, and this Mac has no /usr/bin/sandbox-exec.".into(),
            fix: "sandbox-exec ships with macOS: check that /usr/bin/sandbox-exec is there, then send again.".into(),
        }
    } else if cfg!(target_os = "linux") {
        Refusal {
            message: "A Navi runs only inside a sandbox, and this machine has no bubblewrap (bwrap).".into(),
            fix: "Install bubblewrap on this machine (Debian and Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf \
                  install bubblewrap; Arch: sudo pacman -S bubblewrap), then send again."
                .into(),
        }
    } else {
        Refusal {
            message: "A Navi runs only inside a sandbox, and fleetd has none for this system."
                .into(),
            fix: "Run Navis on a Linux machine with bubblewrap, or on a Mac.".into(),
        }
    }
}

fn failed(tool: &Path, stderr: &str) -> Refusal {
    let why = stderr.trim();
    let why = why.lines().next().unwrap_or("it exited with no message");
    let message = format!(
        "A Navi runs only inside a sandbox, and {} could not start one: {why}",
        tool.display()
    );
    // Ubuntu (23.10 on) lets a program make user namespaces only with an AppArmor profile that allows it.
    let userns = ["uid map", "new namespace", "user namespace"]
        .iter()
        .any(|w| why.contains(w));
    let setuid = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(tool).is_ok_and(|m| m.permissions().mode() & 0o4000 != 0)
    };
    let fix = if cfg!(target_os = "linux") && setuid {
        format!(
            "Enable unprivileged user namespaces, which bubblewrap needs here: {} is setuid root, and fleetd starts \
             it with no_new_privs (to scope abstract sockets), so it runs unprivileged and makes its sandbox in a user \
             namespace. On Debian before 11: sudo sysctl kernel.unprivileged_userns_clone=1; elsewhere check that \
             user.max_user_namespaces is above 0 and, on Ubuntu, that AppArmor allows bwrap \
             (/etc/apparmor.d/bwrap-userns-restrict). Check with: bwrap --ro-bind / / --unshare-all true",
            tool.display()
        )
    } else if cfg!(target_os = "linux") && userns {
        "bubblewrap needs unprivileged user namespaces, which AppArmor blocks here (Ubuntu 23.10 and later do by \
         default). Allow them for bwrap: Ubuntu's apparmor package ships /etc/apparmor.d/bwrap-userns-restrict (sudo \
         apt install apparmor, then sudo systemctl reload apparmor), or turn the restriction off with sudo sysctl \
         kernel.apparmor_restrict_unprivileged_userns=0. Check with: bwrap --ro-bind / / --unshare-all true"
            .into()
    } else {
        format!(
            "Run {} by hand to see why (bwrap --ro-bind / / --unshare-all true on Linux), fix it, then send again.",
            tool.display()
        )
    };
    Refusal { message, fix }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Variables a fenced session never gets: they name sockets that reach outside it (D-Bus and systemd, which start
/// commands; an SSH agent; the person's X server).
pub const NO_ENV: &[&str] = &[
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "XAUTHORITY",
];

/// bubblewrap's arguments: the machine read-only, its own `/dev`, `/proc`, `/tmp` and pid namespace, then each of the
/// fence's paths, shallowest first so a deeper one lands on top (the folder inside the hidden node home).
fn bwrap_args(fence: &Fence, cwd: &Path) -> Vec<String> {
    enum Op<'a> {
        Hide,
        Show,
        Write,
        Private(&'a Path),
    }
    let mut ops: Vec<(&Path, Op)> = Vec::new();
    ops.extend(fence.hide.iter().map(|p| (p.as_path(), Op::Hide)));
    ops.extend(fence.show.iter().map(|p| (p.as_path(), Op::Show)));
    ops.extend(fence.write.iter().map(|p| (p.as_path(), Op::Write)));
    ops.extend(
        fence
            .private
            .iter()
            .map(|(from, to)| (to.as_path(), Op::Private(from))),
    );
    ops.extend(
        fence
            .config_copy
            .iter()
            .map(|(config, copy)| (config.as_path(), Op::Private(copy))),
    );
    ops.extend(fence.keep.iter().map(|p| (p.as_path(), Op::Show)));
    // Stable: at one depth, a hidden path goes first and the folder's kept paths last.
    ops.sort_by_key(|(p, _)| p.components().count());

    let mut args: Vec<String> = [
        "--die-with-parent",
        // Its own session: no controlling terminal of the node's to push keystrokes into (TIOCSTI).
        "--new-session",
        "--unshare-pid",
        "--unshare-ipc",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
    ]
    .map(str::to_owned)
    .into();
    let mut tmpfs = Vec::new();
    for (path, op) in ops {
        let p = s(path);
        match op {
            Op::Hide if path.is_dir() => {
                args.extend(["--tmpfs".into(), p.clone()]);
                tmpfs.push(p);
            }
            // Only one that's still there: a file gone since the fence was made has nothing to hide.
            Op::Hide if path.exists() => args.extend(["--ro-bind".into(), "/dev/null".into(), p]),
            Op::Hide => {}
            Op::Show => args.extend(["--ro-bind-try".into(), p.clone(), p]),
            Op::Write => args.extend(["--bind".into(), p.clone(), p]),
            Op::Private(from) => args.extend(["--bind".into(), s(from), p]),
        }
    }
    // Each hidden dir's tmpfs, once what goes inside it is mounted, takes no writes either.
    for p in tmpfs {
        args.extend(["--remount-ro".into(), p]);
    }
    // The node leaves them out of a Navi's environment; systemd-run's scope, outside, adds the bus's back.
    for var in NO_ENV {
        args.extend(["--unsetenv".into(), (*var).into()]);
    }
    args.extend(["--chdir".into(), s(cwd), "--".into()]);
    args
}

/// A string in a sandbox profile.
fn quoted(p: &Path) -> String {
    let text = s(p).replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{text}\"")
}

/// macOS's profile: everything as usual, but writes only to the fence's written paths (and the devices every program
/// writes), and no reading the hidden ones' contents. Later rules win, so the kept paths come after the written ones,
/// and each read rule comes after those of the paths around it (shallowest first, as bubblewrap mounts them): the
/// folder is read inside the hidden fleetd dir, and claude's other sessions aren't inside its shown config dir. A
/// path's metadata stays readable, so resolving a path through a hidden dir still works.
fn seatbelt(fence: &Fence) -> String {
    let subpaths = |paths: &mut dyn Iterator<Item = &PathBuf>| {
        paths
            .map(|p| format!(" (subpath {})", quoted(p)))
            .collect::<String>()
    };
    let write = subpaths(&mut fence.write.iter());
    let keep = subpaths(&mut fence.keep.iter());
    let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
    profile.push_str(&format!(
        "(allow file-write*{write} (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/dtracehelper\") \
         (regex #\"^/dev/tty\") (regex #\"^/dev/fd/\") (literal \"/dev/ptmx\"))\n"
    ));
    if !keep.is_empty() {
        profile.push_str(&format!("(deny file-write*{keep})\n"));
    }
    let mut reads: Vec<(&PathBuf, &str)> = fence.hide.iter().map(|p| (p, "deny")).collect();
    reads.extend(fence.show.iter().chain(&fence.write).map(|p| (p, "allow")));
    reads.sort_by_key(|(p, _)| p.components().count());
    for (path, rule) in reads {
        profile.push_str(&format!(
            "({rule} file-read-data file-read-xattr (subpath {}))\n",
            quoted(path)
        ));
    }
    profile
}

#[cfg(test)]
#[path = "sandbox_tests.rs"]
mod tests;
