use std::path::{Path, PathBuf};

use super::*;

/// A machine in a temp dir: a user's home with their logins and claude's config, fleetd's dir with the node's home,
/// a Navi's folder, another project's worktree and the token store, and another project's checkout.
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
            (m.worktree.join("README.md"), "another project"),
            (m.other.join("README.md"), "another checkout"),
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
        std::os::unix::fs::symlink(
            m.home.join(".local/share/claude/versions/2.1.302"),
            m.home.join(".local/bin/claude"),
        )
        .unwrap();
        m
    }

    /// The session's PATH: the home's program dirs first, as a node's often is.
    fn path(&self) -> Vec<PathBuf> {
        vec![
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
            runtime_dir: None,
            other_roots: vec![self.other.clone(), self.home.clone()],
        })
    }

    /// `script` in `sh`, inside the Navi's sandbox, with `tool` as the sandbox: whether it succeeded, and its output.
    fn run(&self, tool: &Path, script: &str) -> (bool, String) {
        let (program, args) = wrap_with(
            Some(tool.to_owned()),
            &self.fence(),
            &self.folder,
            Path::new("/bin/sh"),
            vec!["-c".into(), script.into()],
        )
        .unwrap();
        let mut command = std::process::Command::new(program);
        with_scope(&mut command);
        let out = command
            .args(args)
            .current_dir(&self.folder)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.home)
            .env("TMPDIR", &self.scratch)
            .env("DISPLAY", ":0")
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
fn a_navis_fence_writes_its_folder_and_hides_fleetd_logins_and_other_projects() {
    let m = Machine::new();
    let fence = m.fence();
    for written in [&m.folder, &m.scratch, &m.session.join("agent-device")] {
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
    assert!(fence.hide.contains(&m.other));
    if cfg!(target_os = "linux") {
        // The home is an allow-list: hidden whole, and only what a Navi runs and works in comes back.
        assert!(fence.hide.contains(&m.home));
        for back in [
            m.home.join(".local/bin"),
            m.home.join(".local/share/claude/versions"),
            m.home.join(".nvm/versions/node/v22"),
            m.home.join(".gitconfig"),
        ] {
            assert!(fence.show.contains(&back), "{}", back.display());
        }
        assert!(!fence.show.contains(&m.home.join(".local")));
        assert!(
            fence
                .private
                .contains(&(m.session.join("home-cache"), m.home.join(".cache")))
        );
        // A secret inside what comes back stays hidden; one elsewhere in the home is out of sight already.
        assert!(fence.hide.contains(&m.home.join(".cargo/credentials.toml")));
        assert!(!fence.hide.contains(&m.home.join(".ssh")));
    } else {
        for hidden in [
            &m.fleetd,
            &m.node,
            &m.home.join(".ssh"),
            &m.home.join(".config"),
        ] {
            assert!(fence.hide.contains(hidden), "{}", hidden.display());
        }
        // A project whose root holds the whole home isn't hidden: the Navi's folder and its tools are in it.
        assert!(!fence.hide.contains(&m.home));
    }
    assert!(fence.show.contains(&m.session));
    assert!(fence.keep.contains(&m.folder.join(".claude")));
}

#[test]
fn a_navi_cant_write_outside_its_folder() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    for target in [
        m.fleetd.join("escape"),
        m.node.join("node.json"),
        m.worktree.join("README.md"),
        m.worktree.join("escape"),
        m.other.join("README.md"),
        m.home.join("escape"),
        m.home.join(".bashrc"),
        m.claude.join("settings.json"),
        m.session.join("settings.json"),
        m.folder.join(".claude/settings.json"),
    ] {
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

#[test]
fn a_navi_cant_read_the_token_store_logins_or_other_projects() {
    let Some(tool) = sandbox_or_skip() else {
        return;
    };
    let m = Machine::new();
    for secret in [
        m.tokens.join("google.json"),
        m.home.join(".ssh/id_ed25519"),
        m.home.join(".config/gh/hosts.yml"),
        m.fleetd.join("hub/hub.sqlite"),
        m.worktree.join("README.md"),
        m.other.join("README.md"),
        // claude's record of every other session: conversations, prompts, file backups, environments.
        m.claude.join("projects/-src-other/t1.jsonl"),
        m.claude.join("history.jsonl"),
        m.claude.join("file-history/t1/backup"),
        m.claude.join("session-env/t1/env"),
        m.home.join(".Xauthority"),
        m.home.join(".npmrc"),
        m.home.join(".pgpass"),
        m.claude.join("ide/1234.lock"),
        // A backup of claude's config, with the MCP servers its copy leaves out.
        m.home.join(".claude.json.backup.1792349295"),
    ] {
        let (ok, out) = m.run(&tool, &format!("cat '{}'", secret.display()));
        assert!(!ok, "{} was read: {out}", secret.display());
    }
    if cfg!(target_os = "linux") {
        let (ok, out) = m.run(
            &tool,
            "test -z \"$DISPLAY\" && test -z \"$(ls -A /tmp/.X11-unix 2>/dev/null)\"",
        );
        assert!(ok, "the X server is in reach: {out}");
    }
    let (_, out) = m.run(
        &tool,
        &format!("ls -a '{}'", m.node.join("worktrees").display()),
    );
    assert!(!out.contains("p2"), "{out}");
    // No other process is in reach, so neither is a way back to the real disk through one (/proc/<pid>/root).
    if cfg!(target_os = "linux") {
        let (ok, out) = m.run(&tool, &format!("ls /proc/{}/root/", std::process::id()));
        assert!(!ok, "{out}");
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
         git init -q . && git add -A && git -c user.name=Ada -c user.email=ada@example.com commit -qm first
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
    assert!(m.folder.join(".git").is_dir());
    assert!(m.folder.join("drafts/plan.md").is_file());
    assert!(m.scratch.join("scratch.txt").is_file());
    // A token claude refreshed inside is saved for every session.
    assert!(
        std::fs::read_to_string(m.claude.join(".credentials.json"))
            .unwrap()
            .contains("rotated")
    );
    if cfg!(target_os = "linux") {
        assert!(!Path::new(&tmp).exists(), "/tmp was its own");
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
fn macoss_profile_writes_only_the_fence_and_reads_no_hidden_path() {
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
        ],
        keep: vec!["/Users/ada/.fleetd/node/navi/ada/.claude".into()],
        private: vec![],
        config_copy: None,
    };
    let profile = seatbelt(&fence);
    let line = |start: &str| {
        profile
            .lines()
            .position(|l| l.starts_with(start))
            .unwrap_or_else(|| panic!("{start}: {profile}"))
    };
    assert!(
        line("(deny file-write*)")
            < line("(allow file-write* (subpath \"/Users/ada/.fleetd/node/navi/ada\")")
    );
    assert!(
        line("(allow file-write*")
            < line("(deny file-write* (subpath \"/Users/ada/.fleetd/node/navi/ada/.claude\")")
    );
    // Each read rule after those of the paths around it: the folder is read inside the hidden fleetd dir, and claude's
    // other sessions aren't inside its shown config dir.
    let read = |rule: &str, path: &str| {
        line(&format!(
            "({rule} file-read-data file-read-xattr (subpath \"{path}\"))"
        ))
    };
    assert!(read("deny", "/Users/ada/.fleetd") < read("allow", "/Users/ada/.fleetd/node/navi/ada"));
    assert!(read("allow", "/Users/ada/.claude") < read("deny", "/Users/ada/.claude/projects"));
    assert!(
        read("deny", "/Users/ada/.claude/projects")
            < read("allow", "/Users/ada/.claude/projects/-navi-ada")
    );
    read("deny", "/Users/ada/.ssh");
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
    let (program, args) = wrap_with(
        Some(tool),
        &fence,
        &m.folder,
        Path::new("/bin/sh"),
        vec!["-c".into(), "true".into()],
    )
    .expect("a vanished copy is skipped, not mounted over");
    let mut command = std::process::Command::new(program);
    with_scope(&mut command);
    assert!(command.args(args).env_clear().status().unwrap().success());
    // The backups stay hidden.
    let backup = m.home.join(".claude.json.backup.1792349295");
    assert!(fence.hide.contains(&backup) || fence.hide.contains(&m.home));
}

#[cfg(target_os = "linux")]
#[test]
fn a_navis_home_holds_only_what_it_runs_and_works_in() {
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
         mkdir -p ~/.cache/claude && echo log > ~/.cache/claude/log"
    );
    let (ok, out) = m.run(&tool, &script);
    assert!(ok, "{out}");
    for ran in ["claude-ran", "node-ran", "\"npm\"", "Ada"] {
        assert!(out.contains(ran), "{ran}: {out}");
    }
    // Its cache is its own.
    assert!(m.session.join("home-cache/claude/log").is_file());
    assert!(!m.home.join(".cache/claude/log").exists());
    // Nothing else of the home is there: not its notes, its shell's startup files, another session's temporary copy
    // of claude's config, or anything made after the fence was.
    std::fs::write(m.home.join("made-later.txt"), "x").unwrap();
    let listed = m.run(&tool, "ls -A ~").1;
    let names: Vec<&str> = listed.lines().collect();
    for absent in [
        "notes",
        ".bashrc",
        ".claude.json.tmp.77.1792349295",
        ".claude.json.backup.1792349295",
        ".ssh",
        "made-later.txt",
    ] {
        assert!(!names.contains(&absent), "{absent}: {listed}");
    }
    for unreadable in [
        m.home.join(".bashrc"),
        m.home.join("notes/diary.md"),
        m.home.join(".cargo/credentials.toml"),
        m.home.join("made-later.txt"),
    ] {
        let (ok, out) = m.run(&tool, &format!("cat '{}'", unreadable.display()));
        assert!(!ok, "{} was read: {out}", unreadable.display());
    }
    let (ok, _) = m.run(&tool, "echo x > ~/new-file");
    assert!(!ok, "the home took a write");
}
