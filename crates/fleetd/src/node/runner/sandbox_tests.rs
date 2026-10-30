use std::path::{Path, PathBuf};

use super::*;

/// A machine in a temp dir: a user's home with their logins and claude's config, fleetd's dir with the node's home,
/// a Navi's folder and own dir, another Navi's, another project's worktree and the token store, another project's
/// checkout, and the user's runtime dir with their D-Bus and systemd sockets.
struct Machine {
    _dir: tempfile::TempDir,
    home: PathBuf,
    fleetd: PathBuf,
    node: PathBuf,
    folder: PathBuf,
    scratch: PathBuf,
    session: PathBuf,
    claude: PathBuf,
    worktree: PathBuf,
    tokens: PathBuf,
    other: PathBuf,
    /// A bin dir outside the home the person writes, on the node's PATH (Homebrew's).
    brew: PathBuf,
    own: PathBuf,
    other_navi: PathBuf,
    runtime: PathBuf,
}

impl Machine {
    fn new() -> Self {
        // Beside the test binary, not under /tmp: the sandbox gives its session a /tmp of its own, which would hide
        // these whatever the fence said.
        let exe = std::env::current_exe().unwrap();
        let dir = tempfile::tempdir_in(exe.parent().unwrap()).unwrap();
        let root = real(dir.path());
        let home = root.join("home");
        let fleetd = home.join(".fleetd");
        let node = fleetd.join("node");
        let m = Self {
            folder: node.join("navi/ada"),
            scratch: node.join("tmp/0123456789abcdef"),
            session: node.join("sessions/s1"),
            claude: home.join(".claude"),
            worktree: node.join("worktrees/p2/w1"),
            tokens: node.join("secrets"),
            other: root.join("src/other"),
            brew: root.join("opt/brew/bin"),
            own: node.join("navis/p1"),
            other_navi: node.join("navis/p2"),
            runtime: root.join("run/user/1000"),
            _dir: dir,
            home,
            fleetd,
            node,
        };
        let files = [
            (m.home.join(".ssh/id_ed25519"), "PRIVATE KEY"),
            (m.home.join(".config/gh/hosts.yml"), "oauth_token: gho_x"),
            (m.fleetd.join("hub/hub.sqlite"), "hub"),
            (m.tokens.join("google.json"), "{\"refresh_token\":\"x\"}"),
            // The Navi's own browser profile (D221): only the node's Chrome reads its cookies.
            (navi_cookies(&m.node), "SQLite format 3"),
            (m.worktree.join("README.md"), "another project"),
            (m.other.join("README.md"), "another checkout"),
            // A git checkout another project's lead works in, outside any sandbox.
            (m.other.join(".git/config"), "[core]\n\tbare = false\n"),
            (m.other.join("CLAUDE.md"), "Run the tests before a commit."),
            (m.brew.join("git"), "#!/bin/sh\necho brew-git\n"),
            // Go's module cache, without its bin dir yet.
            (m.home.join("go/pkg/mod/cache.txt"), "x"),
            (m.session.join("mcp.json"), "{\"mcpServers\":{}}"),
            (m.claude.join("settings.json"), "{}"),
            // The home's programs, as installers leave them, and what else people keep there.
            (
                m.home.join(".local/share/claude/versions/2.1.302"),
                "#!/bin/sh\necho claude-ran\n",
            ),
            (
                m.home.join(".nvm/versions/node/v22/bin/node"),
                "#!/bin/sh\necho node-ran\n",
            ),
            (
                m.home
                    .join(".nvm/versions/node/v22/lib/node_modules/npm/package.json"),
                "{\"name\":\"npm\"}",
            ),
            (m.home.join(".cargo/bin/cargo"), "#!/bin/sh\n"),
            (
                m.home.join(".cargo/credentials.toml"),
                "token = \"cargo-secret\"",
            ),
            (m.home.join(".gitconfig"), "[user]\n\tname = Ada\n"),
            (
                m.home.join(".config/git/config"),
                "[core]\n\tautocrlf = false\n",
            ),
            (
                m.home.join(".config/git/credentials"),
                "https://ada:ghp_git@github.com",
            ),
            (
                m.home.join(".rustup/toolchains/stable/bin/rustc"),
                "#!/bin/sh\n",
            ),
            // fleetd's own bin on the PATH, beside the fleetd dir's secrets.
            (m.fleetd.join("bin/fleetd"), "#!/bin/sh\n"),
            (
                m.fleetd.join("claude.env"),
                "ANTHROPIC_AUTH_TOKEN=fleetd-secret",
            ),
            // A tool uv installed, linked from ~/.local/bin, with its library beside its bin.
            (
                m.home
                    .join(".local/share/uv/python/cpython-3.12/bin/python3.12"),
                "#!/bin/sh\n",
            ),
            (
                m.home
                    .join(".local/share/uv/python/cpython-3.12/lib/python3.12/os.py"),
                "# stdlib",
            ),
            // Another project checked out in the home, with a tool someone linked onto the PATH.
            (m.home.join("src/mine/bin/tool"), "#!/bin/sh\n"),
            (
                m.home.join("src/mine/README.md"),
                "another project in the home",
            ),
            (m.home.join(".bashrc"), "export GITHUB_TOKEN=ghp_rc"),
            (m.home.join("notes/diary.md"), "private"),
            (
                m.home.join(".claude.json.tmp.77.1792349295"),
                "{\"mcpServers\":{}}",
            ),
            (m.claude.join(".credentials.json"), "{\"claudeAiOauth\":{}}"),
            (
                m.claude.join("projects/-src-other/t1.jsonl"),
                "another task's conversation",
            ),
            (m.claude.join("history.jsonl"), "another session's prompt"),
            (
                m.claude.join("file-history/t1/backup"),
                "another session's file",
            ),
            (m.claude.join("session-env/t1/env"), "export TOKEN=x"),
            (m.home.join(".Xauthority"), "cookie"),
            (m.home.join(".npmrc"), "//registry.npmjs.org/:_authToken=x"),
            (m.home.join(".pgpass"), "db:5432:*:ada:hunter2"),
            (
                m.home.join(".claude.json.backup.1792349295"),
                "{\"mcpServers\":{\"gh\":{\"env\":{\"GITHUB_TOKEN\":\"ghp_backup\"}}}}",
            ),
            (m.claude.join("ide/1234.lock"), "{\"authToken\":\"x\"}"),
            (
                m.home.join(".claude.json"),
                "{\"numStartups\":3,\"mcpServers\":{\"gh\":{\"env\":{\"GITHUB_TOKEN\":\"ghp_secret\"}}},\
                 \"projects\":{\"/src/other\":{\"history\":[\"deploy the thing\"]}}}",
            ),
            (
                m.claude.join("shell-snapshots/snapshot-other.sh"),
                "# another session's",
            ),
            (m.node.join("bin/fleetd-agent-1"), "#!/bin/sh\n"),
            (m.node.join("node.sock"), ""),
            (m.folder.join("notes.md"), "hello"),
            // Where the user's D-Bus and systemd listen (a socket's path here would be too long to bind).
            (m.runtime.join("bus"), ""),
            (m.runtime.join("systemd/private"), ""),
            (
                m.other_navi.join("home/.local/bin/secret-tool"),
                "another Navi's",
            ),
        ];
        for (path, text) in files {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        std::fs::create_dir_all(&m.scratch).unwrap();
        use std::os::unix::fs::PermissionsExt;
        for program in [
            m.home.join(".local/share/claude/versions/2.1.302"),
            m.home.join(".nvm/versions/node/v22/bin/node"),
        ] {
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::create_dir_all(m.home.join(".local/bin")).unwrap();
        for (target, link) in [
            // Links at the home's top: one to the person's code, one to their keys.
            ("src", "code"),
            (".ssh", "keys"),
            (".local/share/claude/versions/2.1.302", ".local/bin/claude"),
            (
                ".local/share/uv/python/cpython-3.12/bin/python3.12",
                ".local/bin/python3.12",
            ),
            ("src/mine/bin/tool", ".local/bin/tool"),
            (".fleetd/hub/hub.sqlite", ".local/bin/sneaky"),
        ] {
            std::os::unix::fs::symlink(m.home.join(target), m.home.join(link)).unwrap();
        }
        m
    }

    /// The session's PATH: the home's program dirs first, as a node's often is.
    fn path(&self) -> Vec<PathBuf> {
        vec![
            self.fleetd.join("bin"),
            self.brew.clone(),
            self.home.join(".local/bin"),
            self.home.join(".nvm/versions/node/v22/bin"),
            self.home.join(".cargo/bin"),
            "/usr/bin".into(),
            "/bin".into(),
        ]
    }

    fn fence(&self) -> Fence {
        navi_fence(&NaviPaths {
            user_home: &self.home,
            fleetd_dir: &self.fleetd,
            node_home: &self.node,
            folder: &self.folder,
            scratch: &self.scratch,
            session_dir: &self.session,
            session_id: "s1",
            claude_dir: &self.claude,
            claude_json: &self.home.join(".claude.json"),
            claude_bin: &self.home.join(".local/bin/claude"),
            path: self.path(),
            exe: &self.node.join("bin/fleetd-agent-1"),
            socket: &self.node.join("node.sock"),
            runtime_dir: Some(&self.runtime),
            own: &self.own,
            projects: vec![
                self.other.clone(),
                self.home.join("src/mine"),
                self.folder.clone(),
                self.worktree.clone(),
            ],
        })
    }

    /// `script` in `sh`, inside the Navi's sandbox, with `tool` as the sandbox: whether it succeeded, and its output.
    fn run(&self, tool: &Path, script: &str) -> (bool, String) {
        self.run_in(tool, &self.fence(), script)
    }

    /// [`Machine::run`] in `fence`, made earlier.
    fn run_in(&self, tool: &Path, fence: &Fence, script: &str) -> (bool, String) {
        let sandboxed = wrap_with(
            Some(tool.to_owned()),
            fence,
            &self.folder,
            Path::new("/bin/sh"),
            vec!["-c".into(), script.into()],
        )
        .unwrap();
        let out = sandboxed
            .command()
            .current_dir(&self.folder)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.home)
            .envs(crate::node::sessions::share::scratch_env(&self.scratch))
            .env("DISPLAY", ":0")
            .env("XDG_RUNTIME_DIR", &self.runtime)
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}", self.runtime.join("bus").display()),
            )
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        (out.status.success(), text)
    }
}

/// The sandbox's program when one starts here; otherwise says why the test is skipped, or fails it where CI set
/// `FLEETD_REQUIRE_SANDBOX`.
fn sandbox_or_skip() -> Option<PathBuf> {
    let why = match tool() {
        None => "no bwrap (Linux) or sandbox-exec (macOS) on this machine".to_owned(),
        Some(tool) => {
            let m = Machine::new();
            match wrap_with(
                Some(tool.clone()),
                &m.fence(),
                &m.folder,
                Path::new("/bin/sh"),
                vec![],
            ) {
                Ok(_) => return Some(tool),
                Err(r) => format!("{}; {}", r.message, r.fix),
            }
        }
    };
    if std::env::var_os("FLEETD_REQUIRE_SANDBOX").is_some() {
        panic!("FLEETD_REQUIRE_SANDBOX is set, but {why}");
    }
    eprintln!("skipped: {why}");
    None
}

#[test]
fn a_navis_fence_writes_its_folder_and_home_and_hides_fleetd_and_logins() {
    let m = Machine::new();
    let fence = m.fence();
    for written in [
        &m.folder,
        &m.scratch,
        &m.session.join("agent-device"),
        &m.own.join("home"),
    ] {
        assert!(fence.write.contains(written), "{}", written.display());
    }
    // Its conversation, and its own session's state in claude's config dir; nothing else there.
    assert!(
        fence
            .write
            .iter()
            .any(|w| w.starts_with(m.claude.join("projects")))
    );
    assert!(fence.write.contains(&m.claude.join("session-env/s1")));
    assert!(fence.write.contains(&m.claude.join(".credentials.json")));
    for other in ["projects", "history.jsonl", "file-history", "session-env"] {
        assert!(fence.hide.contains(&m.claude.join(other)), "{other}");
    }
    if cfg!(target_os = "macos") {
        assert!(fence.hide.contains(&m.home.join(".Xauthority")));
    }
    for other in ["ide", "backups"] {
        assert!(fence.hide.contains(&m.claude.join(other)), "{other}");
    }
    assert_eq!(
        fence.config_copy,
        Some((
            m.home.join(".claude.json"),
            m.session.join("claude/.claude.json")
        ))
    );
    assert!(!fence.write.contains(&m.claude));
    assert!(fence.private.contains(&(
        m.session.join("claude/shell-snapshots"),
        m.claude.join("shell-snapshots")
    )));
    // The user's sockets that would run a command outside.
    assert!(fence.hide.contains(&m.runtime));
    // Another project's checkout is the person's, as written as the rest of the machine.
    assert!(!fence.hide.iter().any(|h| m.other.starts_with(h)));
    assert_eq!(fence.access(&m.other.join("README.md")), Access::Write);
    // The node's home hides every other Navi's home with it.
    assert_eq!(
        fence.access(&m.other_navi.join("home/.local/bin/secret-tool")),
        Access::Hidden
    );
    assert_eq!(fence.access(&m.own.join("home/.local/bin")), Access::Write);
    // The programs the node runs, and what runs on its own, are read-only.
    for back in [
        m.home.join(".local/bin"),
        m.home.join(".local/share/claude/versions"),
        m.home.join(".nvm/versions/node/v22"),
        m.home.join(".gitconfig"),
        m.home.join(".bashrc"),
        m.home.join(".profile"),
    ] {
        assert!(fence.show.contains(&back), "{}", back.display());
        assert_eq!(
            fence.access(&back.join("x")),
            Access::Read,
            "{}",
            back.display()
        );
    }
    if cfg!(target_os = "linux") {
        // The home is listed: hidden whole, and each of its entries comes back but the hidden ones.
        assert!(fence.hide.contains(&m.home));
        assert_eq!(fence.tmp, Some(m.own.join("tmp")));
        for entry in ["notes", "src", ".local", ".nvm"] {
            assert!(fence.listed.contains(&m.home.join(entry)), "{entry}");
        }
        for out in [
            ".ssh",
            ".config",
            ".fleetd",
            ".bashrc",
            ".claude",
            ".claude.json",
        ] {
            assert!(!fence.listed.contains(&m.home.join(out)), "{out}");
        }
        assert!(
            !fence
                .listed
                .iter()
                .any(|l| l.to_string_lossy().contains(".claude.json")),
            "{:?}",
            fence.listed
        );
        // A link comes back as a link, wherever it leads.
        assert!(
            fence
                .links
                .contains(&(m.home.join("keys"), m.home.join(".ssh")))
        );
        assert!(
            fence
                .private
                .contains(&(m.session.join("home-cache"), m.home.join(".cache")))
        );
        // A secret inside what comes back stays hidden; one elsewhere in the home is out of sight already.
        assert!(fence.hide.contains(&m.home.join(".cargo/credentials.toml")));
        assert!(!fence.hide.contains(&m.home.join(".ssh")));
        // fleetd's own bin on the PATH comes back alone: never fleetd's dir, which stays hidden.
        assert!(fence.show.contains(&m.fleetd.join("bin")));
        assert!(!fence.show.contains(&m.fleetd));
        assert!(
            !fence.show.iter().any(|s| s.starts_with(&m.fleetd)
                && *s != m.fleetd.join("bin")
                && !s.starts_with(&m.node)),
            "{:?}",
            fence.show
        );
        // A linked tool's install comes back read-only, the code it lives in too; a link into fleetd's dir brings
        // back nothing.
        for install in [
            m.home.join(".local/share/uv/python/cpython-3.12"),
            m.home.join("src/mine"),
        ] {
            assert!(fence.show.contains(&install), "{}", install.display());
        }
        // git's own settings, never its credential store.
        assert!(fence.show.contains(&m.home.join(".config/git/config")));
        assert!(!fence.show.contains(&m.home.join(".config/git")));
        assert!(fence.show.contains(&m.home.join(".rustup")));
    } else {
        for hidden in [
            &m.fleetd,
            &m.node,
            &m.home.join(".ssh"),
            &m.home.join(".config"),
        ] {
            assert!(fence.hide.contains(hidden), "{}", hidden.display());
        }
        assert!(!fence.hide.contains(&m.home));
    }
    for hidden in [
        m.home.join(".ssh/id_ed25519"),
        m.home.join(".config/gh/hosts.yml"),
        m.fleetd.join("hub/hub.sqlite"),
        m.tokens.join("google.json"),
    ] {
        assert_eq!(
            fence.access(&hidden),
            Access::Hidden,
            "{}",
            hidden.display()
        );
    }
    assert!(fence.show.contains(&m.session));
    assert!(fence.keep.contains(&m.folder.join(".claude")));
    assert_eq!(fence.session.as_deref(), Some("s1"));
    // What fleetd's agents load in a checkout, and the person's bin dirs, are read-only; never shown where hidden.
    for kept in [
        ".git/config",
        ".git/hooks",
        ".git/worktrees",
        ".claude",
        ".fleetd",
        ".mcp.json",
        "CLAUDE.md",
    ] {
        assert!(fence.keep.contains(&m.other.join(kept)), "{kept}");
    }
    assert!(fence.show.contains(&m.brew));
    if cfg!(target_os = "linux") {
        assert!(fence.keep.contains(&m.home.join("go/bin")));
    }
    assert!(
        !fence
            .keep
            .iter()
            .chain(&fence.show)
            .any(|k| k.starts_with(&m.worktree)),
        "a hidden checkout is shown"
    );
}

#[test]
fn a_navi_writes_where_the_person_can_but_not_fleetds_dir_or_what_runs_on_its_own() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    let mut refused = vec![
        m.fleetd.join("escape"),
        m.node.join("node.json"),
        m.worktree.join("README.md"),
        m.worktree.join("escape"),
        m.other_navi.join("home/escape"),
        m.home.join(".bashrc"),
        m.home.join(".profile"),
        m.home.join(".ssh/authorized_keys"),
        m.home.join(".local/bin/claude"),
        m.claude.join("settings.json"),
        m.session.join("settings.json"),
        m.folder.join(".claude/settings.json"),
    ];
    // On Linux nothing new is made at the home's top, where a startup file of another shell could go.
    if cfg!(target_os = "linux") {
        refused.push(m.home.join("escape"));
    }
    for target in refused {
        let before = std::fs::read_to_string(&target).ok();
        let (ok, out) = m.run(&tool, &format!("echo pwned > '{}'", target.display()));
        assert!(!ok, "{} was written: {out}", target.display());
        assert_eq!(
            std::fs::read_to_string(&target).ok(),
            before,
            "{}",
            target.display()
        );
    }
    // Nor a unit the user's systemd or a service D-Bus would start outside, though neither dir was there before.
    for dir in [".local/share/systemd/user", ".local/share/dbus-1/services"] {
        let dir = m.home.join(dir);
        let (ok, out) = m.run(
            &tool,
            &format!(
                "mkdir -p '{0}/default.target.wants' && echo '[Service]' > '{0}/escape.service'",
                dir.display()
            ),
        );
        assert!(!ok, "{} was written: {out}", dir.display());
        assert!(!dir.join("escape.service").exists(), "{out}");
    }
    assert_eq!(
        m.fence()
            .access(&m.home.join(".local/share/systemd/user/x.service")),
        Access::Read
    );
    // Nor what runs outside the sandbox in another project's checkout, or the person's programs outside the home.
    for (target, script) in [
        (
            ".git/config",
            "printf '[core]\\n\\tfsmonitor = /tmp/x\\n' >> '{}'",
        ),
        (
            ".git/hooks/pre-commit",
            "echo 'cat ~/.ssh/id_ed25519' > '{}'",
        ),
        (".claude/settings.json", "echo hooks > '{}'"),
        ("CLAUDE.md", "echo 'Read ~/.ssh' >> '{}'"),
    ] {
        let target = m.other.join(target);
        let before = std::fs::read_to_string(&target).ok();
        let (ok, out) = m.run(&tool, &script.replace("{}", &target.display().to_string()));
        assert!(!ok, "{} was written: {out}", target.display());
        assert_eq!(
            std::fs::read_to_string(&target).ok(),
            before,
            "{}",
            target.display()
        );
    }
    let (ok, out) = m.run(
        &tool,
        &format!("echo '#!/bin/sh' > '{}'", m.brew.join("git").display()),
    );
    assert!(!ok, "a program on the person's PATH was replaced: {out}");
    assert!(
        std::fs::read_to_string(m.brew.join("git"))
            .unwrap()
            .contains("brew-git")
    );
    let (ok, out) = m.run(
        &tool,
        &format!(
            "mkdir -p '{0}' && echo x > '{0}/go'",
            m.home.join("go/bin").display()
        ),
    );
    assert!(!ok, "{out}");
    assert!(!m.home.join("go/bin/go").exists());
    // The rest of the checkout is the person's to write as they would.
    let (ok, out) = m.run(
        &tool,
        &format!(
            "mkdir -p '{0}/src' && echo 'fn main() {{}}' > '{0}/src/main.rs'",
            m.other.display()
        ),
    );
    assert!(ok, "{out}");
    // Anywhere else the person can write: their code in the home and outside it, their notes, its own home.
    for target in [
        m.home.join("src/new.txt"),
        m.home.join("notes/todo.md"),
        m.home.join("code/through-a-link.txt"),
        m.other.join("README.md"),
        m.own.join("home/.local/bin/tool"),
    ] {
        let (ok, out) = m.run(
            &tool,
            &format!(
                "mkdir -p '{0}' && echo written > '{1}'",
                target.parent().unwrap().display(),
                target.display()
            ),
        );
        assert!(ok, "{}: {out}", target.display());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "written\n",
            "{}",
            target.display()
        );
    }
    // claude's shared state is never written. On Linux it reads as its own private copy, where another session's
    // shell snapshot isn't even there; on macOS, which can't mount a copy, it is read-only.
    let shared = m.claude.join("shell-snapshots/snapshot-other.sh");
    let (_, out) = m.run(
        &tool,
        &format!(
            "cat '{}'; echo pwned > '{}'",
            shared.display(),
            shared.display()
        ),
    );
    if cfg!(target_os = "linux") {
        assert!(!out.contains("another session's"), "{out}");
    } else {
        assert!(out.contains("Operation not permitted"), "{out}");
    }
    assert_eq!(
        std::fs::read_to_string(&shared).unwrap(),
        "# another session's"
    );
    // Nor through a symlink it makes in its folder.
    let (ok, out) = m.run(
        &tool,
        &format!(
            "ln -s '{}' link && echo pwned > link/escape",
            m.fleetd.display()
        ),
    );
    assert!(!ok, "{out}");
    assert!(!m.fleetd.join("escape").exists());
}

/// Where the node keeps the Navi's cookies, in the browser profile it keeps for it.
fn navi_cookies(node: &Path) -> PathBuf {
    crate::node::browser::chrome::kept_dir(node, "4f2c9a1e-ada")
        .unwrap()
        .join("Default/Cookies")
}

#[test]
fn a_navi_cant_read_keys_logins_fleetds_dir_or_another_navis_home() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    for secret in [
        m.tokens.join("google.json"),
        navi_cookies(&m.node),
        m.home.join(".ssh/id_ed25519"),
        m.home.join("keys/id_ed25519"),
        m.home.join(".config/gh/hosts.yml"),
        m.fleetd.join("hub/hub.sqlite"),
        m.fleetd.join("claude.env"),
        m.worktree.join("README.md"),
        m.other_navi.join("home/.local/bin/secret-tool"),
        // claude's record of every other session: conversations, prompts, file backups, environments.
        m.claude.join("projects/-src-other/t1.jsonl"),
        m.claude.join("history.jsonl"),
        m.claude.join("file-history/t1/backup"),
        m.claude.join("session-env/t1/env"),
        m.home.join(".Xauthority"),
        m.home.join(".npmrc"),
        m.home.join(".pgpass"),
        m.home.join(".config/git/credentials"),
        m.home.join(".cargo/credentials.toml"),
        m.claude.join("ide/1234.lock"),
        // A backup of claude's config, with the MCP servers its copy leaves out.
        m.home.join(".claude.json.backup.1792349295"),
    ] {
        let (ok, out) = m.run(&tool, &format!("cat '{}'", secret.display()));
        assert!(!ok, "{} was read: {out}", secret.display());
    }
    // The person's own files read as they are.
    for read in [
        m.home.join("notes/diary.md"),
        m.home.join(".bashrc"),
        m.other.join("README.md"),
    ] {
        let (ok, out) = m.run(&tool, &format!("cat '{}'", read.display()));
        assert!(ok, "{}: {out}", read.display());
    }
    let (_, out) = m.run(
        &tool,
        &format!("ls -a '{}'", m.node.join("worktrees").display()),
    );
    // By name: an error's path holds the random temp dir's, which can spell "p2" (.tmpp2E3RV).
    assert!(!out.lines().any(|l| l.trim() == "p2"), "{out}");
    if cfg!(target_os = "linux") {
        let (ok, out) = m.run(
            &tool,
            "test -z \"$DISPLAY\" && test -z \"$(ls -A /tmp/.X11-unix 2>/dev/null)\"",
        );
        assert!(ok, "the X server is in reach: {out}");
        // Neither the user's D-Bus nor their systemd, which would run a command outside: no socket, no address.
        let (ok, out) = m.run(
            &tool,
            &format!(
                "test -z \"$DBUS_SESSION_BUS_ADDRESS$XDG_RUNTIME_DIR\" && ! test -e '{}' && ! test -e '{}'",
                m.runtime.join("bus").display(),
                m.runtime.join("systemd/private").display()
            ),
        );
        assert!(ok, "D-Bus or systemd is in reach: {out}");
        // No process outside its box is in reach, so neither is a way back to the real disk through one
        // (/proc/<pid>/root).
        let (ok, out) = m.run(&tool, &format!("ls /proc/{}/root/", std::process::id()));
        assert!(!ok, "{out}");
        let (ok, out) = m.run(&tool, "ls /proc/1/root/home");
        assert!(!ok, "the box's init leads to the disk: {out}");
    }
}

#[test]
fn a_navi_works_in_its_folder_as_usual() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    // Files as claude's tools make them, git, its scratch dir, and fleetd's files for the session.
    let mut script = format!(
        "set -e
         cat notes.md
         mkdir -p drafts/2026 && echo plan > drafts/2026/plan.md && mv drafts/2026/plan.md drafts/ && rm -r drafts/2026
         git init -q .
         git add -A
         git -c user.name=Ada -c user.email=ada@example.com commit -qm first
         git config --file ~/.config/git/config --get core.autocrlf
         git log --oneline | wc -l
         echo s > \"$TMPDIR/scratch.txt\"
         cat '{mcp}'
         echo turn >> '{transcripts}/s1.jsonl'
         echo 'export A=1' > '{session_env}/hook-0.sh'
         echo '{{\"claudeAiOauth\":{{\"refreshToken\":\"rotated\"}}}}' > '{credentials}'
         test -x '{exe}'",
        mcp = m.session.join("mcp.json").display(),
        transcripts = super::super::claude::session_file(&m.claude, &m.folder, "s1")
            .unwrap()
            .parent()
            .unwrap()
            .display(),
        exe = m.node.join("bin/fleetd-agent-1").display(),
        session_env = m.claude.join("session-env/s1").display(),
        credentials = m.claude.join(".credentials.json").display(),
    );
    // On Linux, a /tmp and claude's shared state of its own.
    let tmp = format!("/tmp/fleetd-sandbox-{}.txt", std::process::id());
    let snapshot = m.claude.join("shell-snapshots/snapshot-navi.sh");
    if cfg!(target_os = "linux") {
        script.push_str(&format!(
            "\n echo t > {tmp} && cat {tmp}\n echo '{{}}' > '{}'",
            snapshot.display()
        ));
    }
    std::fs::set_permissions(
        m.node.join("bin/fleetd-agent-1"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let (ok, out) = m.run(&tool, &script);
    assert!(ok, "{out}");
    assert!(out.contains("hello") && out.contains("mcpServers"), "{out}");
    // git runs with the user's own settings under ~/.config, on macOS too, where the rest of ~/.config is hidden.
    assert!(out.contains("false"), "{out}");
    assert!(m.folder.join(".git").is_dir(), "{out}");
    assert!(m.folder.join("drafts/plan.md").is_file());
    assert!(m.scratch.join("scratch.txt").is_file());
    // A token claude refreshed inside is saved for every session.
    assert!(
        std::fs::read_to_string(m.claude.join(".credentials.json"))
            .unwrap()
            .contains("rotated")
    );
    if cfg!(target_os = "linux") {
        // Its /tmp is the Navi's own, on disk.
        assert!(!Path::new(&tmp).exists(), "/tmp was the machine's");
        assert!(
            m.own
                .join("tmp")
                .join(Path::new(&tmp).file_name().unwrap())
                .is_file()
        );
        // A shell snapshot it writes is its own, never one another session sources.
        assert!(
            m.session
                .join("claude/shell-snapshots/snapshot-navi.sh")
                .is_file()
        );
        assert!(!snapshot.exists());
    }
}

#[test]
fn a_navis_claude_makes_its_temp_dir_in_its_scratch_dir() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    // As claude (2.1.302) does before every command: `claude-<uid>` under CLAUDE_CODE_TMPDIR, else os.tmpdir(), which
    // on a Mac came out as /private/tmp, and every command failed with EPERM.
    let (ok, out) = m.run(
        &tool,
        r#"set -e
         dir="${CLAUDE_CODE_TMPDIR:?unset: claude falls back to /tmp}/claude-$(id -u)/-navi-ada/s1/tasks"
         mkdir -p "$dir"
         echo done > "$dir/b1.output""#,
    );
    assert!(ok, "{out}");
    let uid = nix::unistd::getuid();
    assert!(
        m.scratch
            .join(format!("claude-{uid}/-navi-ada/s1/tasks/b1.output"))
            .is_file(),
        "{out}"
    );
}

#[test]
fn a_navi_without_a_sandbox_is_refused_with_how_to_fix_it() {
    let m = Machine::new();
    let refused = wrap_with(None, &m.fence(), &m.folder, Path::new("/bin/sh"), vec![]).unwrap_err();
    assert!(
        refused
            .message
            .starts_with("A Navi runs only inside a sandbox"),
        "{refused:?}"
    );
    if cfg!(target_os = "linux") {
        assert!(refused.message.contains("bubblewrap"), "{refused:?}");
        assert!(
            refused.fix.contains("apt install bubblewrap"),
            "{refused:?}"
        );
    }
    // One that is there but can't start says why, and never runs the session without it.
    let refused = wrap_with(
        Some("/bin/false".into()),
        &m.fence(),
        &m.folder,
        Path::new("/bin/sh"),
        vec![],
    )
    .unwrap_err();
    assert!(
        refused.message.contains("could not start one"),
        "{refused:?}"
    );
    assert!(!refused.fix.is_empty());
}

#[test]
fn a_setuid_bubblewrap_says_to_enable_user_namespaces() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bwrap = dir.path().join("bwrap");
    std::fs::write(&bwrap, "").unwrap();
    std::fs::set_permissions(&bwrap, std::fs::Permissions::from_mode(0o4755)).unwrap();
    let refused = failed(
        &bwrap,
        "bwrap: Creating new namespace failed: Operation not permitted\n",
    );
    if cfg!(target_os = "linux") {
        assert!(
            refused
                .fix
                .starts_with("Enable unprivileged user namespaces"),
            "{refused:?}"
        );
        // Dropping the bit would break what relies on it (flatpak on some systems): never the advice.
        assert!(!refused.fix.contains("chmod"), "{refused:?}");
    }
}

#[test]
fn a_blocked_user_namespace_points_at_apparmor() {
    let refused = failed(
        Path::new("/usr/bin/bwrap"),
        "bwrap: setting up uid map: Permission denied\n",
    );
    assert!(
        refused
            .message
            .ends_with("setting up uid map: Permission denied")
    );
    if cfg!(target_os = "linux") {
        assert!(refused.fix.contains("AppArmor"), "{refused:?}");
        assert!(refused.fix.contains("bwrap-userns-restrict"), "{refused:?}");
    }
}

#[test]
fn macoss_profile_writes_all_but_the_hidden_and_read_only_paths_and_reads_no_hidden_one() {
    let fence = Fence {
        write: vec![
            "/Users/ada/.fleetd/node/navi/ada".into(),
            "/Users/ada/.claude/projects/-navi-ada".into(),
        ],
        hide: vec![
            "/Users/ada/.fleetd".into(),
            "/Users/ada/.ssh".into(),
            "/Users/ada/.claude/projects".into(),
        ],
        show: vec![
            "/Users/ada/.fleetd/node/sessions/s1".into(),
            "/Users/ada/.claude".into(),
            "/Users/ada/.zshrc".into(),
        ],
        keep: vec!["/Users/ada/.fleetd/node/navi/ada/.claude".into()],
        ..Fence::default()
    };
    let profile = seatbelt(&fence);
    assert!(
        profile.starts_with("(version 1)\n(allow default)\n"),
        "{profile}"
    );
    assert!(!profile.contains("(deny file-write*)\n"), "{profile}");
    let line = |rule: &str, what: &str, path: &str| {
        let line = format!("({rule} {what} (subpath \"{path}\"))");
        profile
            .lines()
            .position(|l| l == line)
            .unwrap_or_else(|| panic!("{line}: {profile}"))
    };
    let read = "file-read-data file-read-xattr";
    let write = "file-write*";
    // Each path's rules after those of the paths around it: the folder is read and written inside the hidden fleetd
    // dir, its kept paths aren't written inside it, and claude's other sessions aren't inside its shown config dir.
    let fleetd = "/Users/ada/.fleetd";
    let folder = "/Users/ada/.fleetd/node/navi/ada";
    assert!(line("deny", write, fleetd) < line("allow", write, folder));
    assert!(line("deny", read, fleetd) < line("allow", read, folder));
    assert!(line("allow", write, folder) < line("deny", write, &format!("{folder}/.claude")));
    assert!(
        line("allow", read, "/Users/ada/.claude")
            < line("deny", read, "/Users/ada/.claude/projects")
    );
    assert!(
        line("deny", write, "/Users/ada/.claude")
            < line("allow", write, "/Users/ada/.claude/projects/-navi-ada")
    );
    assert!(
        line("deny", read, "/Users/ada/.claude/projects")
            < line("allow", read, "/Users/ada/.claude/projects/-navi-ada")
    );
    line("deny", read, "/Users/ada/.ssh");
    line("deny", write, "/Users/ada/.ssh");
    // What runs on its own reads, but takes no write.
    line("allow", read, "/Users/ada/.zshrc");
    line("deny", write, "/Users/ada/.zshrc");
    assert_eq!(quoted(Path::new("/a \"b\"\\c")), "\"/a \\\"b\\\"\\\\c\"");
}

#[test]
fn a_navis_claude_config_is_its_own_copy_without_other_tools_secrets() {
    let config = sanitized_config(
        r#"{"numStartups":3,"oauthAccount":{"emailAddress":"ada@example.com"},"primaryApiKey":"sk-ant-x",
            "mcpServers":{"gh":{"env":{"GITHUB_TOKEN":"ghp_x"}}},"projects":{"/src/other":{}},
            "customApiKeyResponses":{"approved":["x"]},"githubToken":"x","slackSecret":"x"}"#,
    );
    let config: serde_json::Value = serde_json::from_str(&config).unwrap();
    assert_eq!(config["numStartups"], 3);
    // claude's own login stays: the Navi's claude needs it, and can read the login file anyway.
    assert_eq!(config["primaryApiKey"], "sk-ant-x");
    assert!(config.get("oauthAccount").is_some());
    for gone in [
        "mcpServers",
        "projects",
        "customApiKeyResponses",
        "githubToken",
        "slackSecret",
    ] {
        assert!(config.get(gone).is_none(), "{gone}");
    }
    assert_eq!(sanitized_config("not json"), "{}\n");

    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    let real = m.home.join(".claude.json");
    let before = std::fs::read_to_string(&real).unwrap();
    let (ok, out) = m.run(
        &tool,
        &format!(
            "cat '{0}'; echo '{{\"numStartups\":4}}' > '{0}'",
            real.display()
        ),
    );
    if cfg!(target_os = "linux") {
        assert!(ok, "{out}");
        assert!(out.contains("numStartups"), "{out}");
        assert!(
            !out.contains("ghp_secret") && !out.contains("deploy the thing"),
            "{out}"
        );
    } else {
        assert!(!out.contains("ghp_secret"), "{out}");
    }
    // What it wrote stayed in its copy.
    assert_eq!(std::fs::read_to_string(&real).unwrap(), before);
}

#[cfg(target_os = "linux")]
#[test]
fn a_navi_reaches_no_abstract_socket_made_outside() {
    use std::os::linux::net::SocketAddrExt;
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    if scope_hook().is_none() {
        eprintln!(
            "skipped: this kernel's Landlock (ABI {}) can't scope abstract sockets",
            landlock_abi()
        );
        return;
    }
    if !Path::new("/usr/bin/python3").exists() {
        eprintln!("skipped: no python3 to connect to an abstract socket with");
        return;
    }
    // Like an X server's `@/tmp/.X11-unix/X0`, made outside the sandbox.
    let name = format!("fleetd-sandbox-test-{}", std::process::id());
    let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
    let listener = std::os::unix::net::UnixListener::bind_addr(&addr).unwrap();
    listener.set_nonblocking(true).unwrap();
    let connect = format!(
        "python3 -c \"import socket; s = socket.socket(socket.AF_UNIX); s.connect('\\0{name}'); print('connected')\""
    );
    let m = Machine::new();
    let (ok, out) = m.run(&tool, &connect);
    // Refused by the scope, not missing: Landlock answers EPERM.
    assert!(!ok && out.contains("Operation not permitted"), "{out}");
    assert!(listener.accept().is_err(), "the sandbox reached the socket");
    // Its own processes still reach each other's.
    let own = "python3 -c \"
import socket
a = socket.socket(socket.AF_UNIX); a.bind('\\0navi-own'); a.listen(1)
b = socket.socket(socket.AF_UNIX); b.connect('\\0navi-own'); print('own')\"";
    let (ok, out) = m.run(&tool, own);
    assert!(ok && out.contains("own"), "{out}");
}

#[test]
fn the_machine_says_which_sandbox_a_navi_gets() {
    let Some(_) = sandbox_or_skip() else {
        return;
    };
    let said = describe().expect("a sandbox here");
    assert_ne!(said.status, SandboxStatus::Missing, "{said:?}");
    assert!(said.line.starts_with("Navis run in"), "{said:?}");
}

#[test]
fn a_copy_of_claudes_config_gone_before_the_start_fails_nothing() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    let gone = m.home.join(".claude.json.tmp.4242.1792349295");
    std::fs::write(&gone, "{}").unwrap();
    let fence = m.fence();
    // On Linux the home's tmpfs hides it without naming it.
    assert!(fence.hide.contains(&gone) || cfg!(target_os = "linux"));
    std::fs::remove_file(&gone).unwrap();
    let sandboxed = wrap_with(
        Some(tool),
        &fence,
        &m.folder,
        Path::new("/bin/sh"),
        vec!["-c".into(), "true".into()],
    )
    .expect("a vanished copy is skipped, not mounted over");
    assert!(sandboxed.command().env_clear().status().unwrap().success());
    // The backups stay hidden.
    let backup = m.home.join(".claude.json.backup.1792349295");
    assert!(fence.hide.contains(&backup) || fence.hide.contains(&m.home));
}

#[cfg(target_os = "linux")]
#[test]
fn a_navi_sees_the_persons_home_as_it_is_but_what_stays_hidden() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    let path = m
        .path()
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(":");
    let script = format!(
        "set -e
         export PATH={path}
         claude
         node
         cat ~/.nvm/versions/node/v22/lib/node_modules/npm/package.json
         git config --global --get user.name
         git config --file ~/.config/git/config --get core.autocrlf
         ls -A ~/.config/git
         cat ~/.local/share/uv/python/cpython-3.12/lib/python3.12/os.py
         test -d ~/.rustup/toolchains/stable
         test -f ~/.fleetd/bin/fleetd
         cat ~/notes/diary.md
         mkdir -p ~/.cache/claude && echo log > ~/.cache/claude/log"
    );
    let (ok, out) = m.run(&tool, &script);
    assert!(ok, "{out}");
    for ran in [
        "claude-ran",
        "node-ran",
        "\"npm\"",
        "Ada",
        "false",
        "# stdlib",
        "private",
    ] {
        assert!(out.contains(ran), "{ran}: {out}");
    }
    assert!(
        !out.contains("credentials"),
        "git's credential store is in sight: {out}"
    );
    // Its cache is its own.
    assert!(m.session.join("home-cache/claude/log").is_file());
    assert!(!m.home.join(".cache/claude/log").exists());
    // The person's files are there, but not their keys, another session's temporary copy of claude's config, or
    // anything made after the fence was. (`.config` and `.fleetd` are there only as the way to what comes back in
    // them.)
    let fence = m.fence();
    std::fs::write(m.home.join("made-later.txt"), "x").unwrap();
    let listed = m.run_in(&tool, &fence, "ls -A ~").1;
    let names: Vec<&str> = listed.lines().collect();
    for present in ["notes", "src", ".bashrc", ".local", "code", "keys"] {
        assert!(names.contains(&present), "{present}: {listed}");
    }
    for absent in [
        ".claude.json.tmp.77.1792349295",
        ".claude.json.backup.1792349295",
        ".ssh",
        "made-later.txt",
    ] {
        assert!(!names.contains(&absent), "{absent}: {listed}");
    }
    for unreadable in [
        m.home.join(".cargo/credentials.toml"),
        m.home.join("made-later.txt"),
        // fleetd's dir, whatever of it is on the PATH.
        m.fleetd.join("claude.env"),
        m.fleetd.join("hub/hub.sqlite"),
        m.home.join(".local/bin/sneaky"),
        // git's credential store, beside the settings that come back.
        m.home.join(".config/git/credentials"),
    ] {
        let (ok, out) = m.run_in(&tool, &fence, &format!("cat '{}'", unreadable.display()));
        assert!(!ok, "{} was read: {out}", unreadable.display());
    }
}

/// `script` as claude runs a Navi's command in a turn of session `session`: its command environment
/// ([`navi_env`]) sourced first, as `CLAUDE_ENV_FILE` has it.
#[cfg(target_os = "linux")]
fn turn(m: &Machine, tool: &Path, session: &str, script: &str) -> (bool, String) {
    let env = m.session.join(format!("{session}-env.sh"));
    std::fs::write(&env, navi_env(&m.own, &m.home)).unwrap();
    m.run(tool, &format!(". '{}'\n{script}", env.display()))
}

#[cfg(target_os = "linux")]
#[test]
fn a_navi_installs_a_program_in_its_home_and_it_runs_on_after_the_turn() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    // A release tarball, as a download leaves it: one program that keeps a heartbeat.
    let release = m.folder.join("release");
    std::fs::create_dir_all(&release).unwrap();
    std::fs::write(
        release.join("beat"),
        "#!/bin/sh\necho $$ > /tmp/beat.pid\nn=0\nwhile :; do n=$((n+1)); echo $n > /tmp/beat.count; sleep 0.1; done\n",
    )
    .unwrap();
    std::fs::set_permissions(
        release.join("beat"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let (ok, out) = turn(
        &m,
        &tool,
        "s1",
        "set -e
         cd \"$TMPDIR\" && tar -czf beat.tar.gz -C \"$OLDPWD/release\" beat
         mkdir -p ~/.local/bin && tar -xzf beat.tar.gz -C ~/.local/bin
         command -v beat
         nohup beat > /tmp/beat.log 2>&1 &
         sleep 0.5
         cat /tmp/beat.pid",
    );
    assert!(ok, "{out}");
    let installed = m.own.join("home/.local/bin/beat");
    assert!(out.contains(&installed.display().to_string()), "{out}");
    assert!(installed.is_file());
    // The turn is over: its sandbox exited. The next turn, another session, finds the program running, and hears it.
    let (ok, out) = turn(
        &m,
        &tool,
        "s2",
        "set -e
         pid=$(cat /tmp/beat.pid)
         kill -0 \"$pid\"
         a=$(cat /tmp/beat.count); sleep 0.5; b=$(cat /tmp/beat.count)
         test \"$b\" -gt \"$a\" && echo beating
         command -v beat
         ps -e -o pid=,comm= | wc -l",
    );
    assert!(ok, "{out}");
    assert!(out.contains("beating"), "{out}");
    // Its mark names its session, never the spawn's: the end of a session leaves it be, and the node still tells it
    // from the person's own shell.
    let program = installed.display().to_string();
    let running = super::super::process::table()
        .into_iter()
        .filter(|p| {
            std::fs::read(format!("/proc/{}/cmdline", p.pid))
                .is_ok_and(|c| String::from_utf8_lossy(&c).contains(&program))
        })
        .collect::<Vec<_>>();
    assert_eq!(running.len(), 1, "{running:?}");
    let environ = std::fs::read(format!("/proc/{}/environ", running[0].pid)).unwrap();
    assert!(
        String::from_utf8_lossy(&environ).contains("FLEETD_RUNNER_SESSION=s1.navi\0"),
        "{}",
        String::from_utf8_lossy(&environ)
    );
    // Only the box's processes are in sight: its init, its `cat`, the program, and this turn's.
    let seen: usize = out.lines().last().unwrap().trim().parse().unwrap();
    assert!(seen < 10, "{out}");
    // The box ends with its Navi, and what ran in it.
    forget_navi(&m.own);
    assert!(!m.own.exists());
    let (ok, out) = turn(
        &m,
        &tool,
        "s3",
        "test ! -e /tmp/beat.pid && ! command -v beat",
    );
    assert!(ok, "a new box starts empty: {out}");
}
