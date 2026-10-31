//! The OS sandbox a Navi's session runs in (D196, opened up by D234 navi.sandbox-open-home): claude and every process
//! it starts (a command, an MCP server, agent-browser's daemon) write anywhere the person can, except what stays
//! hidden: the logins and keys people keep in their home ([`HIDDEN_IN_HOME`]), fleetd's own dir apart from the Navi's
//! folder and its own home, claude's record of every other session, and the sockets that would run a command outside
//! (the user's D-Bus and systemd in the runtime dir, docker's, the X server's). Startup files the person's shell runs
//! on its own ([`RUN_ON_THEIR_OWN`]), the person's programs, and what fleetd's own agents load in each project's
//! checkout (git's config and hooks, Claude Code's settings) stay read-only: they run outside the sandbox ([`guard`]). The per-tool checks
//! (`claude::role_answer`, the hub's site gate) stay as a second layer. Network stays as it is: the site gate decides.
//!
//! Each Navi has a home of its own under the node's home ([`navi_dir`]), its commands' HOME ([`navi_env`]), where
//! `npm i -g`, `pip install --user`, `cargo install` and curl-pipe installers put what they install.
//!
//! - Linux: bubblewrap, and only bubblewrap (D: navi.sandbox-linux-requires-bwrap). The machine is mounted as it is,
//!   writable where the person can write, hidden paths get an empty read-only tmpfs (or `/dev/null` for a file), and
//!   the paths the Navi needs are bound back on top. The person's home is listed: an empty read-only tmpfs with each of
//!   its entries bound back but the hidden ones, so nothing made there later (another session's temporary copy of
//!   claude's config) is in sight. Every session of a Navi joins the user and pid namespaces of its box
//!   (`navi_box`), so what it leaves running in the background outlives the turn, until the node stops, and no
//!   process outside the box (and no `/proc/<pid>/root` into the real disk) is in reach. Its sessions share one
//!   `/tmp`, kept until the box ends.
//! - macOS: `sandbox-exec` with a profile made here: writes everywhere but the hidden and read-only paths, and no
//!   reading the hidden ones. A detached process outlives the session there already.
//!
//! A sandbox that can't start never falls back to none: the session is refused with how to fix it ([`Refusal`]).
//! Only Navis are fenced; every other session runs as before.
use std::fs::File;
use std::os::fd::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fleetd_contracts::sessions::{NaviSandbox, SandboxStatus};

/// What a fenced session may touch. Everything else on the machine reads and writes as it does for the person
/// ([`Fence::access`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fence {
    /// Read and written, inside a hidden path too.
    pub write: Vec<PathBuf>,
    /// Neither read nor written.
    pub hide: Vec<PathBuf>,
    /// Read, inside a hidden path too, never written.
    pub show: Vec<PathBuf>,
    /// Read but never written inside a written path. One without an extension that isn't there is made, empty, as a
    /// dir ([`Fence::prepare`]), so it is never made by the session instead.
    pub keep: Vec<PathBuf>,
    /// The listed home's own entries, read and written as they are, and never made (Linux).
    pub listed: Vec<PathBuf>,
    /// `(link, target)`: a symlink in the listed home, made again as it is, so it leads where it always did and a
    /// hidden target stays hidden (Linux).
    pub links: Vec<(PathBuf, PathBuf)>,
    /// The Navi's own `/tmp`, which its sessions share and its box is known by (Linux, `navi_box`): what it leaves
    /// running in the background lives on there after the turn. None for a fence of no Navi's.
    pub tmp: Option<PathBuf>,
    /// The session whose mark ([`super::process::SESSION_MARKER`]) what runs inside carries, in place of the node's
    /// mark of the spawn (Linux): the sweep at the session's end leaves what it started in the background running, and
    /// the node still tells such a process from the person's own shell (`process::peer_session`).
    pub session: Option<String>,
    /// `(private, shared)`: the session's own `private` dir, read and written where `shared` is, so what it writes
    /// there reaches no other session. Linux only: on macOS `shared` is read-only.
    pub private: Vec<(PathBuf, PathBuf)>,
    /// `(real, copy)`: claude's global config (`~/.claude.json`) and the session's sanitized copy of it
    /// ([`sanitized_config`]), read and written in its place on Linux. On macOS, where nothing can stand in for a
    /// path, the real one is hidden.
    pub config_copy: Option<(PathBuf, PathBuf)>,
    /// Folders on the way to a read-only or hidden path that the Navi could otherwise rename ([`hold_folders`]):
    /// read and written as they are, but never moved. Linux binds each onto itself; macOS denies writing the folder
    /// itself, not what is in it.
    pub held: Vec<PathBuf>,
}

/// A command inside a sandbox: its program and arguments, and the files it inherits under the numbers they have here
/// (the namespaces of a Navi's box, which its sandbox joins), held open until it has started.
#[derive(Debug)]
pub struct Sandboxed {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub inherit: Vec<Arc<File>>,
}

impl Sandboxed {
    /// What the new process runs before it execs, so the files it inherits stay open across the exec. It makes system
    /// calls only.
    pub fn hook(&self) -> impl FnMut() -> std::io::Result<()> + Send + Sync + 'static {
        let fds: Vec<RawFd> = self.inherit.iter().map(|f| f.as_raw_fd()).collect();
        move || {
            for fd in &fds {
                // SAFETY: clears close-on-exec on an fd this process holds open.
                if unsafe { libc::fcntl(*fd, libc::F_SETFD, 0) } < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        }
    }

    /// A command that runs it, with [`Sandboxed::hook`] and [`scope_hook`].
    pub fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        command.args(&self.args);
        // SAFETY: the hook makes system calls only.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(&mut command, self.hook());
        }
        with_scope(&mut command);
        command
    }
}

/// What a fenced session may do with a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Hidden,
    Read,
    Write,
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
    // git's credential store under XDG: tokens in plain text.
    ".config/git/credentials",
];

/// In the user's home on macOS: `~/Library` whole, where browsers keep cookies, apps their tokens, and the keychains
/// are. claude reads its login through the keychain's daemon, never the files.
const HIDDEN_IN_HOME_MACOS: &[&str] = &["Library"];

/// The X server's sockets: a command that reached the person's screen could type into a terminal outside. On Linux
/// the Navi's `/tmp` is its own, without them.
const HIDDEN_X: &str = "/tmp/.X11-unix";

/// In the user's home: files their shell or session manager runs on its own, read-only to a Navi, which may write the
/// rest of the home: a line it added there would run outside its sandbox. On Linux one that isn't there can't be made
/// either: the home's own entries are read-only.
const RUN_ON_THEIR_OWN: &[&str] = &[
    ".profile",
    ".bash_profile",
    ".bash_login",
    ".bashrc",
    ".bash_logout",
    ".zshenv",
    ".zprofile",
    ".zshrc",
    ".zlogin",
    ".zlogout",
    ".pam_environment",
    ".xprofile",
    ".xsessionrc",
    ".xinitrc",
    // Ubuntu's `.bashrc` sources it.
    ".bash_aliases",
    // cargo's own settings, which can name a program every build runs (`build.rustc-wrapper`).
    ".cargo/config.toml",
    ".cargo/config",
];

/// In each project's checkout on the machine, where fleetd's own agents run outside any sandbox: what they load as
/// their settings, MCP servers, policy and instructions. Read-only to a Navi, which writes the rest of a checkout. A dir
/// that isn't there is made empty first ([`Fence::prepare`]); a file that isn't there can still be made, and a new
/// `.mcp.json` runs nothing until settings the Navi can't write approve it.
pub const PROJECT_KEPT: &[&str] = &[
    ".claude",
    ".fleetd",
    ".mcp.json",
    "CLAUDE.md",
    "CLAUDE.local.md",
];

/// In a checkout's git dir, and its common dir: what makes git run a program (`core.fsmonitor`, `core.hooksPath`, an
/// alias, a hook) for every worktree of it. `hooks` and `worktrees` are made empty first when they aren't there.
const GIT_KEPT: &[&str] = &["config", "config.worktree", "hooks", "worktrees"];

/// Outside the home, where people keep programs they run without a sandbox (Homebrew's): read-only to a Navi where the
/// person can write them, as is every such dir on the node's PATH.
const SYSTEM_BINS: &[&str] = &[
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];

/// In the person's home, beside [`HOME_BINS`]: more dirs installers put programs in.
const MORE_HOME_BINS: &[&str] = &[".npm-global/bin", ".volta/bin", ".pyenv/shims"];

/// In the user's home: dirs whose units and services the user's systemd and D-Bus start outside the sandbox, read-only
/// to a Navi. They sit inside `~/.local`, which it writes, so one that isn't there is made, empty, before it starts
/// ([`Fence::prepare`]): a read-only mount needs something to mount, and a Navi must not make it first.
const RUN_ON_THEIR_OWN_DIRS: &[&str] = &[".local/share/systemd", ".local/share/dbus-1/services"];

/// A Navi's own dir under the node's home: its home ([`HOME_DIR`]) and the `/tmp` its sessions share ([`TMP_DIR`]).
/// Hidden from every other Navi with the rest of the node's home.
pub fn navi_dir(node_home: &Path, project_id: &str) -> PathBuf {
    node_home.join("navis").join(project_id)
}

/// Ends a Navi's box, with what it left running, and deletes its own dir ([`navi_dir`]), home and all: the Navi is
/// going. Nothing there is no error.
pub fn forget_navi(own: &Path) {
    let own = real(own);
    super::navi_box::end(&own.join(TMP_DIR));
    if let Err(e) = std::fs::remove_dir_all(&own)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(dir = %own.display(), "a Navi's home was not removed: {e}");
    }
}

/// In [`navi_dir`]: the Navi's home, HOME for its commands.
pub const HOME_DIR: &str = "home";
/// In [`navi_dir`]: the Navi's `/tmp`, emptied when its box starts.
pub const TMP_DIR: &str = "tmp";

/// The user-level bin dirs installers put programs in, in a Navi's home, first on its commands' PATH.
const HOME_BINS: &[&str] = &[
    ".local/bin",
    "bin",
    ".cargo/bin",
    "go/bin",
    ".bun/bin",
    ".deno/bin",
];

/// What claude runs ahead of each command of a Navi's (`CLAUDE_ENV_FILE`), where `own` is its [`navi_dir`]: its own
/// home as HOME, with [`HOME_BINS`] on its PATH and npm installing globally there too (`~/.local`); its `/tmp`, which
/// outlives the turn, as TMPDIR, so a program it leaves running keeps its temp files; pip allowed to install for the
/// user on a system that marks its Python as managed. claude itself keeps the person's HOME, where its login and
/// settings are. The person's rustup toolchains, when they have them, still run cargo and rustc.
pub fn navi_env(own: &Path, user_home: &Path) -> String {
    let own = real(own);
    let quoted = |p: &Path| format!("'{}'", s(p).replace('\'', "'\\''"));
    let tmp = if cfg!(target_os = "linux") {
        PathBuf::from("/tmp")
    } else {
        own.join(TMP_DIR)
    };
    let bins: Vec<String> = HOME_BINS.iter().map(|b| format!("$HOME/{b}")).collect();
    let mut env = format!(
        "export HOME={home}\n\
         export PATH=\"{bins}:$PATH\"\n\
         export NPM_CONFIG_PREFIX=\"$HOME/.local\"\n\
         export CARGO_HOME=\"$HOME/.cargo\"\n\
         export PIP_BREAK_SYSTEM_PACKAGES=1\n\
         export TMPDIR={tmp} TMP={tmp} TEMP={tmp}\n",
        home = quoted(&own.join(HOME_DIR)),
        bins = bins.join(":"),
        tmp = quoted(&tmp),
    );
    let rustup = real(user_home).join(".rustup");
    if rustup.is_dir() {
        env.push_str(&format!("export RUSTUP_HOME={}\n", quoted(&rustup)));
    }
    env
}

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
    /// The Navi's own dir ([`navi_dir`]): its home and its `/tmp`.
    pub own: &'a Path,
    /// Every project's root on this node: checkouts where fleetd's agents run outside any sandbox.
    pub projects: Vec<PathBuf>,
    /// The `claude` binary the node runs.
    pub claude_bin: &'a Path,
    /// The session's PATH: its programs in the home are read again (Linux).
    pub path: Vec<PathBuf>,
}

/// In the user's home, read-only: git's own settings, which run commands of the person's (an alias, a hook path), and
/// rustup's toolchains. On macOS, inside the hidden `~/.config`: git can't run when a config file it finds is
/// unreadable, though one that isn't there is fine.
const HOME_READ: &[&str] = &[
    ".gitconfig",
    ".config/git/config",
    ".config/git/ignore",
    ".config/git/attributes",
    // rustup's toolchains, which the proxies in `~/.cargo/bin` run.
    ".rustup",
];

/// The programs the node runs from the user's home, read-only, so a Navi can't change one the person runs: claude's
/// binary; every PATH dir in the home, as its install when it is a `bin` (`~/.nvm/versions/node/v22` for its `bin`, so
/// npm finds its modules), but `~/.local/bin` alone; and, for each program there that links elsewhere in the home, the
/// install it lands in by the same rule (`~/.local/bin/claude` → `~/.local/share/claude/versions`). `fenced`
/// (fleetd's dir and the node's home) never comes back through it: no install that is, holds or sits in one, and no
/// link into one. A PATH dir inside fleetd's dir (`~/.fleetd/bin`) comes back alone.
fn home_programs(home: &Path, claude: &Path, path: &[PathBuf], fenced: &[PathBuf]) -> Vec<PathBuf> {
    let inside = |p: &Path| p.starts_with(home) && p != home;
    let holds_or_is = |d: &Path| fenced.iter().any(|f| f.starts_with(d));
    let in_fenced = |d: &Path| fenced.iter().any(|f| d.starts_with(f));
    // A dir that may come back on its own: in the home, and neither holding nor in anything fenced.
    let may = |d: &Path| inside(d) && !holds_or_is(d) && !in_fenced(d);
    // A dir of programs as it comes back: its install when it's a `bin` whose parent may (not `~/.local`), else itself.
    let install = |dir: &Path| match (dir.file_name(), dir.parent()) {
        (Some(name), Some(parent))
            if name == "bin" && parent != home.join(".local") && may(parent) =>
        {
            Some(parent.to_owned())
        }
        _ => may(dir).then(|| dir.to_owned()),
    };
    let mut dirs = Vec::new();
    let mut programs = vec![claude.to_owned()];
    if may(claude) {
        dirs.push(claude.to_owned());
    }
    for dir in path.iter().map(|d| real(d)).filter(|d| inside(d)) {
        let back = match install(&dir) {
            Some(back) => back,
            // fleetd's own `bin` on the PATH: its programs, alone.
            None if in_fenced(&dir) && !holds_or_is(&dir) => dir.clone(),
            None => continue,
        };
        dirs.push(back);
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
            && let Some(back) = target.parent().and_then(install)
        {
            dirs.push(back);
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
    let own = real(p.own);
    let mut write = vec![folder.clone(), real(p.scratch), own.join(HOME_DIR)];
    // Its `/tmp`: on Linux mounted there ([`Fence::tmp`]), elsewhere its commands' TMPDIR ([`navi_env`]).
    if !cfg!(target_os = "linux") {
        write.push(own.join(TMP_DIR));
    }
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
    let mut keep: Vec<PathBuf> = super::claude::ASSISTANT_KEPT
        .iter()
        .map(|k| folder.join(k))
        .collect();
    keep.extend(
        RUN_ON_THEIR_OWN_DIRS
            .iter()
            .map(|d| real(p.user_home).join(d)),
    );

    let user_home = real(p.user_home);
    let fenced = [real(p.fleetd_dir), real(p.node_home)];
    let mut hide = fenced.to_vec();
    hide.extend(HIDDEN_IN_HOME.iter().map(|h| user_home.join(h)));
    hide.extend(HIDDEN_SOCKETS.iter().map(|s| real(Path::new(s))));
    hide.extend(p.runtime_dir.map(real));
    hide.extend(CLAUDE_HIDDEN.iter().map(|h| claude.join(h)));
    if cfg!(target_os = "macos") {
        hide.push(real(Path::new(HIDDEN_X)));
        hide.extend(HIDDEN_IN_HOME_MACOS.iter().map(|h| user_home.join(h)));
    }
    // A hidden path that is a link (`~/.ssh` into a dotfiles repo) hides what it leads to as well.
    let targets: Vec<PathBuf> = hide
        .iter()
        .map(|h| real(h))
        .filter(|r| !hide.contains(r))
        .collect();
    hide.extend(targets);
    hide.sort();
    hide.dedup();

    // Read-only: fleetd's files for the session and the programs it runs, claude's config dir but for
    // [`CLAUDE_HIDDEN`], the person's programs, and what runs on its own.
    let mut show = vec![real(p.session_dir), real(p.exe), real(p.socket), claude];
    show.extend(NODE_TOOLS.iter().map(|t| real(&p.node_home.join(t))));
    show.extend(home_programs(
        &user_home,
        &real(p.claude_bin),
        &p.path,
        &fenced,
    ));
    show.extend(HOME_READ.iter().map(|f| user_home.join(f)));
    show.extend(RUN_ON_THEIR_OWN.iter().map(|f| user_home.join(f)));
    // Its own copy of claude's global config, without other tools' secrets, where there is one to stand in for.
    // Linux: the home is listed. It gets an empty tmpfs, and each of its entries comes back but the hidden ones, so
    // nothing made there later, before the session or during it (another session's `.claude.json.tmp…`), is ever in
    // sight.
    let home_listed = cfg!(target_os = "linux");
    let claude_json = real(p.claude_json);
    // In the listed home there need be nothing under it: its copy stands where the real one would.
    let in_listed_home = home_listed && claude_json.parent() == Some(user_home.as_path());
    let (mut listed, mut links) = (Vec::new(), Vec::new());
    if home_listed {
        // Caches (claude's logs, a tool's downloads) written where every program looks, but its own.
        private.push((
            real(&p.session_dir.join("home-cache")),
            user_home.join(".cache"),
        ));
        let config_name = claude_json
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let entries = std::fs::read_dir(&user_home)
            .into_iter()
            .flatten()
            .flatten();
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            // claude's config, its backups and another session's copy of it in the making.
            let config = in_listed_home
                && (name == config_name || name.starts_with(&format!("{config_name}.")));
            let set = |p: &PathBuf| *p == path;
            let link = entry.file_type().is_ok_and(|t| t.is_symlink());
            // A shown link comes back as a link, and what it leads to read-only ([`resolve_links`]).
            if config || hide.iter().any(set) || (!link && show.iter().any(set)) {
                continue;
            }
            if link {
                links.extend(std::fs::read_link(&path).map(|to| (path, to)));
            } else {
                listed.push(path);
            }
        }
        hide.push(user_home.clone());
    }
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
    // cargo's credentials in `~/.cargo`): the rest is out of sight already, and isn't mounted over.
    if home_listed {
        let back: Vec<&PathBuf> = show
            .iter()
            .chain(&write)
            .chain(&listed)
            .chain(private.iter().map(|(_, to)| to))
            .collect();
        hide.retain(|h| {
            !h.starts_with(&user_home) || *h == user_home || back.iter().any(|b| h.starts_with(b))
        });
    }
    // A hidden path stays hidden: one shown as well isn't shown.
    show.retain(|s| !hide.contains(s));
    let mut fence = Fence {
        write,
        hide,
        show,
        keep,
        private,
        config_copy,
        listed,
        links,
        tmp: cfg!(target_os = "linux").then(|| own.join(TMP_DIR)),
        session: Some(p.session_id.to_owned()),
        held: Vec::new(),
    };
    guard(&mut fence, p, &user_home, &folder);
    let links = pin_links(&mut fence, &user_home);
    resolve_links(&mut fence);
    fence.keep.extend(links);
    fence.keep.sort();
    fence.keep.dedup();
    hold_folders(&mut fence);
    fence
}

/// Holds each folder on the way to a read-only or hidden path, in a folder the Navi writes ([`Fence::held`]). A mount
/// point can't be renamed, though a folder above one can: otherwise the Navi could move `~/dotfiles/pkg` aside and
/// leave its own `pkg/.local/bin` (or its own checkout, or `/opt/brew`) in its place, or move `~/.local/share` aside so
/// that its next session finds the keyrings at a path no longer hidden.
fn hold_folders(fence: &mut Fence) {
    let writable = |d: &Path| nix::unistd::access(d, nix::unistd::AccessFlags::W_OK).is_ok();
    let ops = fence.ops();
    let mut seen = std::collections::HashSet::new();
    let mut held = Vec::new();
    for path in fence.show.iter().chain(&fence.keep).chain(&fence.hide) {
        for folder in path.ancestors().skip(1) {
            let Some(parent) = folder.parent() else {
                break;
            };
            if !seen.insert(folder) {
                break;
            }
            let mounted = ops.iter().any(|(at, _)| *at == folder);
            if !mounted
                && access_in(&ops, folder) == Access::Write
                && access_in(&ops, parent) == Access::Write
                && writable(parent)
            {
                held.push(folder.to_owned());
            }
        }
    }
    drop(ops);
    held.sort();
    fence.held = held;
}

/// Keeps where they are the links on the way to a read-only path, from a folder the Navi writes: once removed, its own
/// file or dir could stand in their place (a `~/.local/bin` linked into a dotfiles repo, a checkout's `CLAUDE.md`).
/// On macOS the link itself isn't written: returned, to keep once the rest is resolved. On Linux, where no mount lands on a link, the person's home bin dir
/// ([`HOME_BINS`], [`MORE_HOME_BINS`]), and a hidden path that is a link, has its parent listed as the home is: the link comes back as a link in a
/// read-only tmpfs, and the parent's other entries as they are, though nothing new is made at its top. That costs the
/// Navi nothing: it installs into its own home. A checkout isn't listed (`git clone` into `~/src` still works); the node
/// checks its links before an agent runs there instead (`node::checkouts`).
fn pin_links(fence: &mut Fence, user_home: &Path) -> Vec<PathBuf> {
    let writable = |d: &Path| nix::unistd::access(d, nix::unistd::AccessFlags::W_OK).is_ok();
    // `(link, folder)` for each link on the way to `path` in a folder the person and the Navi write.
    let swappable = |fence: &Fence, path: &Path| {
        let mut found = Vec::new();
        let mut at = PathBuf::new();
        for part in path.components() {
            let next = at.join(part);
            if !next.is_symlink() {
                at = next;
                continue;
            }
            if writable(&at) && fence.access(&at) == Access::Write {
                found.push((next.clone(), at.clone()));
            }
            at = real(&next);
        }
        found
    };
    if cfg!(target_os = "macos") {
        return fence
            .show
            .iter()
            .chain(&fence.keep)
            .flat_map(|p| swappable(fence, p))
            .map(|(link, _)| link)
            .collect();
    }
    // A hidden link too (`~/.local/share/keyrings` into a dotfiles repo): swapped for a dir of its own, the next
    // session would hide that one, and not where the link led.
    let folders: Vec<PathBuf> = HOME_BINS
        .iter()
        .chain(MORE_HOME_BINS)
        .map(|b| user_home.join(b))
        .chain(fence.hide.clone())
        .flat_map(|p| swappable(fence, &p))
        .map(|(_, folder)| folder)
        .collect();
    for folder in folders {
        if fence.hide.contains(&folder) {
            continue;
        }
        fence.listed.retain(|l| *l != folder);
        let entries = std::fs::read_dir(&folder).into_iter().flatten().flatten();
        for entry in entries {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                // A hidden link comes back as a link: where it leads is hidden on its own.
                fence.hide.retain(|h| *h != path);
                fence
                    .links
                    .extend(std::fs::read_link(&path).map(|to| (path, to)));
            } else if ![&fence.hide, &fence.show, &fence.keep]
                .iter()
                .any(|set| set.contains(&path))
            {
                fence.listed.push(path);
            }
        }
        fence.hide.push(folder);
    }
    Vec::new()
}

/// Makes each read-only path of `fence` the one it really is: a mount lands on what a link (or a linked parent) leads
/// to, never through the link, which bubblewrap can't follow to a target outside the sandbox it is making, and a
/// macOS rule holds the target too. One that leads into a hidden path is dropped: it stays hidden.
fn resolve_links(fence: &mut Fence) {
    for read_only in [false, true] {
        let paths = if read_only { &fence.keep } else { &fence.show };
        let resolved: Vec<PathBuf> = paths
            .iter()
            .filter_map(|p| {
                let r = real(p);
                (r == *p || fence.access(&r) != Access::Hidden).then_some(r)
            })
            .collect();
        let paths = if read_only {
            &mut fence.keep
        } else {
            &mut fence.show
        };
        *paths = resolved;
        paths.sort();
        paths.dedup();
    }
}

/// What runs outside the sandbox, made read-only where the fence would let the Navi write it: the programs in the
/// person's bin dirs ([`HOME_BINS`], [`MORE_HOME_BINS`], [`SYSTEM_BINS`], the node's PATH), and in each project's
/// checkout what fleetd's agents load there ([`PROJECT_KEPT`], [`GIT_KEPT`]). Nothing hidden is shown through it.
fn guard(fence: &mut Fence, p: &NaviPaths, user_home: &Path, folder: &Path) {
    let writable = |d: &Path| nix::unistd::access(d, nix::unistd::AccessFlags::W_OK).is_ok();
    let open = |f: &Fence, d: &Path| f.access(d) == Access::Write;
    // Bin dirs: read-only where they are. On Linux one that isn't there is made empty first where the Navi could make
    // it (its parent is written, and isn't the listed home's read-only top); on macOS a rule holds a path that isn't
    // there too.
    let bins: Vec<PathBuf> = HOME_BINS
        .iter()
        .chain(MORE_HOME_BINS)
        .map(|b| user_home.join(b))
        .chain(SYSTEM_BINS.iter().map(|b| real(Path::new(b))))
        .chain(
            p.path
                .iter()
                .map(|d| real(d))
                .filter(|d| !d.starts_with(user_home)),
        )
        .collect();
    for bin in bins {
        if !open(fence, &bin) {
            continue;
        }
        if bin.is_dir() {
            if writable(&bin) {
                fence.show.push(bin);
            }
        } else if cfg!(target_os = "macos") {
            fence.show.push(bin);
        } else if let Some(parent) = bin.parent()
            && parent != user_home
            && parent.is_dir()
            && writable(parent)
        {
            fence.keep.push(bin);
        }
    }
    // Checkouts: only those the person writes, so what is made first can be.
    for root in p.projects.iter().map(|r| real(r)) {
        if root == folder || !root.is_dir() || !writable(&root) || !open(fence, &root) {
            continue;
        }
        let mut kept: Vec<PathBuf> = PROJECT_KEPT.iter().map(|k| root.join(k)).collect();
        // A worktree's or submodule's `.git` file, which names the git dir whose config and hooks run.
        let dot_git = root.join(".git");
        if std::fs::symlink_metadata(&dot_git).is_ok_and(|m| m.is_file()) {
            kept.push(dot_git);
        }
        for git in git_dirs(&root) {
            if git.join("config").is_file() && writable(&git) {
                kept.extend(GIT_KEPT.iter().map(|k| git.join(k)));
            }
        }
        kept.retain(|k| open(fence, k));
        fence.keep.extend(kept);
    }
    fence.show.sort();
    fence.show.dedup();
    fence.keep.sort();
    fence.keep.dedup();
}

/// A checkout's git dirs: `.git` itself, or the one a `.git` file names (a worktree's, a submodule's), with the common
/// dir it shares hooks and config with.
fn git_dirs(root: &Path) -> Vec<PathBuf> {
    let dot = root.join(".git");
    let dir = if dot.is_dir() {
        dot
    } else {
        match std::fs::read_to_string(&dot).ok().and_then(|t| {
            t.trim()
                .strip_prefix("gitdir:")
                .map(|g| root.join(g.trim()))
        }) {
            Some(dir) => dir,
            None => return Vec::new(),
        }
    };
    let mut dirs = vec![real(&dir)];
    if let Ok(common) = std::fs::read_to_string(dir.join("commondir")) {
        dirs.push(real(&dir.join(common.trim())));
    }
    dirs
}

impl Fence {
    /// Makes what the sandbox mounts and the session writes: its written dirs, its private dirs and where they go,
    /// its `/tmp`, and the folder's kept dirs, so nothing can make them later. A kept file is kept only once it exists.
    pub fn prepare(&self) -> std::io::Result<()> {
        for dir in self
            .write
            .iter()
            .chain(self.private.iter().flat_map(|(a, b)| [a, b]))
            .chain(&self.tmp)
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

    /// Each path the sandbox mounts, with what it does there, shallowest first, so a deeper one lands on top (the
    /// folder inside the hidden node home). At one depth a hidden path goes first and the folder's kept paths last.
    fn ops(&self) -> Vec<(&Path, Op<'_>)> {
        let mut ops: Vec<(&Path, Op)> = Vec::new();
        ops.extend(self.hide.iter().map(|p| (p.as_path(), Op::Hide)));
        ops.extend(self.show.iter().map(|p| (p.as_path(), Op::Show)));
        ops.extend(
            self.write
                .iter()
                .chain(&self.listed)
                .chain(&self.held)
                .map(|p| (p.as_path(), Op::Write)),
        );
        ops.extend(
            self.links
                .iter()
                .map(|(at, to)| (at.as_path(), Op::Link(to))),
        );
        // Only Linux mounts one path in another's place.
        if cfg!(target_os = "linux") {
            ops.extend(
                self.private
                    .iter()
                    .map(|(from, to)| (to.as_path(), Op::Private(from))),
            );
            ops.extend(
                self.config_copy
                    .iter()
                    .map(|(config, copy)| (config.as_path(), Op::Private(copy))),
            );
        }
        ops.extend(self.keep.iter().map(|p| (p.as_path(), Op::Show)));
        ops.sort_by_key(|(p, _)| p.components().count());
        ops
    }

    /// A fence of a Navi's whose sandbox isn't known: its `folder` and its session's `scratch` dir, and nothing else.
    pub fn folder_only(folder: &Path, scratch: &Path) -> Fence {
        Fence {
            write: vec![real(folder), real(scratch)],
            hide: vec!["/".into()],
            ..Fence::default()
        }
    }

    /// What the session may do with `path`, once resolved, as its sandbox has it: what the deepest of the fence's
    /// paths that holds it says, the last of those at one depth; written where none does, as the person may.
    pub fn access(&self, path: &Path) -> Access {
        access_in(&self.ops(), path)
    }
}

/// [`Fence::access`] with the fence's [`Fence::ops`] made once.
fn access_in(ops: &[(&Path, Op<'_>)], path: &Path) -> Access {
    let mut access = Access::Write;
    for (at, op) in ops {
        if path.starts_with(at) {
            access = match op {
                Op::Hide => Access::Hidden,
                Op::Show => Access::Read,
                Op::Write | Op::Private(_) | Op::Link(_) => Access::Write,
            };
        }
    }
    access
}

/// What the sandbox does at a path.
enum Op<'a> {
    /// An empty read-only tmpfs, or `/dev/null` for a file.
    Hide,
    Show,
    Write,
    /// The path bound here instead.
    Private(&'a Path),
    /// A symlink to the path.
    Link(&'a Path),
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
) -> Result<Sandboxed, Refusal> {
    let tool = tool().ok_or_else(missing)?;
    command(&tool, fence, cwd, program, args)
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
) -> Result<Sandboxed, Refusal> {
    let tool = check_with(tool, fence, cwd)?;
    command(&tool, fence, cwd, program, args)
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
    let start = |own: &Sandboxed| {
        let mut probe = own.command();
        probe
            .arg(if cfg!(target_os = "macos") {
                "/usr/bin/true"
            } else {
                "true"
            })
            .env_clear()
            .stdin(std::process::Stdio::null());
        match probe.output() {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => Err(failed(&tool, &String::from_utf8_lossy(&out.stderr))),
            Err(e) => Err(failed(&tool, &e.to_string())),
        }
    };
    let own = invocation(&tool, fence, cwd)?;
    match start(&own) {
        Ok(()) => Ok(tool),
        // A hidden file that went away meanwhile (a short-lived copy of claude's config) leaves nothing to mount over:
        // once more without it.
        Err(refused) => {
            let again = invocation(&tool, fence, cwd)?;
            if again.args == own.args {
                return Err(refused);
            }
            start(&again).map(|()| tool)
        }
    }
}

/// `program args` inside the sandbox `tool`.
fn command(
    tool: &Path,
    fence: &Fence,
    cwd: &Path,
    program: &Path,
    args: Vec<String>,
) -> Result<Sandboxed, Refusal> {
    let mut sandboxed = invocation(tool, fence, cwd)?;
    sandboxed.args.push(program.to_string_lossy().into_owned());
    sandboxed.args.extend(args);
    Ok(sandboxed)
}

/// Landlock's ABI that scopes abstract Unix sockets (Linux 6.12).
#[cfg(target_os = "linux")]
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

/// The sandbox with its own arguments, up to the command. On Linux a Navi's joins its box, started now if it isn't
/// running ([`super::navi_box`]).
fn invocation(tool: &Path, fence: &Fence, cwd: &Path) -> Result<Sandboxed, Refusal> {
    let sandboxed = |args, inherit| Sandboxed {
        program: tool.to_owned(),
        args,
        inherit,
    };
    if cfg!(target_os = "macos") {
        return Ok(sandboxed(vec!["-p".into(), seatbelt(fence)], vec![]));
    }
    let Some(tmp) = &fence.tmp else {
        return Ok(sandboxed(bwrap_args(fence, cwd, None), vec![]));
    };
    let (user, pid) = super::navi_box::join(tool, tmp).map_err(|why| failed(tool, &why))?;
    let args = bwrap_args(fence, cwd, Some((user.as_raw_fd(), pid.as_raw_fd())));
    Ok(sandboxed(args, vec![user, pid]))
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

/// bubblewrap's arguments: the machine as it is but `/sys`, read-only; its own `/dev`, `/proc` and `/tmp` (the Navi's,
/// shared by its sessions); the user and pid namespaces of its box when it has one, else a pid namespace of its own;
/// then each of the fence's paths ([`Fence::ops`]).
fn bwrap_args(fence: &Fence, cwd: &Path, boxed: Option<(RawFd, RawFd)>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--die-with-parent",
        // Its own session: no controlling terminal of the node's to push keystrokes into (TIOCSTI).
        "--new-session",
        "--unshare-ipc",
    ]
    .map(str::to_owned)
    .into();
    if let Some((user, pid)) = boxed {
        args.extend([
            "--userns".into(),
            user.to_string(),
            "--pidns".into(),
            pid.to_string(),
        ]);
    } else {
        args.push("--unshare-pid".into());
    }
    args.extend(
        [
            "--bind",
            "/",
            "/",
            "--ro-bind",
            "/sys",
            "/sys",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
        ]
        .map(str::to_owned),
    );
    match &fence.tmp {
        Some(tmp) => args.extend(["--bind".into(), s(tmp), "/tmp".into()]),
        None => args.extend(["--tmpfs".into(), "/tmp".into()]),
    }
    let mut tmpfs = Vec::new();
    for (path, op) in fence.ops() {
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
            Op::Write => args.extend(["--bind-try".into(), p.clone(), p]),
            Op::Private(from) => args.extend(["--bind".into(), s(from), p]),
            Op::Link(to) => args.extend(["--symlink".into(), s(to), p]),
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
    if let Some(session) = &fence.session {
        args.extend([
            "--setenv".into(),
            super::process::SESSION_MARKER.into(),
            format!("{session}.navi"),
        ]);
    }
    args.extend(["--chdir".into(), s(cwd), "--".into()]);
    args
}

/// A string in a sandbox profile.
fn quoted(p: &Path) -> String {
    let text = s(p).replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{text}\"")
}

/// macOS's profile: everything as usual, but no writing the hidden paths, the shown ones, the folder's kept ones and
/// the held folders themselves (not what is in them), and no reading the hidden ones' contents. Later rules win, so each path's rules come after those of the paths
/// around it (shallowest first, as bubblewrap mounts them): the folder is read and written inside the hidden fleetd
/// dir, its kept paths aren't written inside it, and claude's other sessions aren't read inside its shown config dir.
/// A path's metadata stays readable, so resolving a path through a hidden dir still works.
fn seatbelt(fence: &Fence) -> String {
    let mut rules: Vec<(&PathBuf, &str)> = fence.hide.iter().map(|p| (p, "deny")).collect();
    rules.extend(fence.show.iter().map(|p| (p, "show")));
    rules.extend(fence.write.iter().map(|p| (p, "allow")));
    rules.extend(fence.keep.iter().map(|p| (p, "keep")));
    rules.extend(fence.held.iter().map(|p| (p, "hold")));
    rules.sort_by_key(|(p, _)| p.components().count());
    let mut profile = String::from("(version 1)\n(allow default)\n");
    for (path, rule) in rules {
        // A held folder itself, never what is in it.
        let at = if rule == "hold" {
            format!("(literal {})", quoted(path))
        } else {
            format!("(subpath {})", quoted(path))
        };
        let (read, write) = match rule {
            "deny" => (Some("deny"), "deny"),
            "show" => (Some("allow"), "deny"),
            "allow" => (Some("allow"), "allow"),
            _ => (None, "deny"),
        };
        if let Some(read) = read {
            profile.push_str(&format!("({read} file-read-data file-read-xattr {at})\n"));
        }
        profile.push_str(&format!("({write} file-write* {at})\n"));
    }
    profile
}

#[cfg(test)]
#[path = "sandbox_tests.rs"]
mod tests;
