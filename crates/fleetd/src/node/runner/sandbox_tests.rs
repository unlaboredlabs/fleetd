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
        m
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
        let out = std::process::Command::new(program)
            .args(args)
            .current_dir(&self.folder)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.home)
            .env("TMPDIR", &self.scratch)
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
    assert!(!fence.write.contains(&m.claude));
    assert!(fence.private.contains(&(
        m.session.join("claude/shell-snapshots"),
        m.claude.join("shell-snapshots")
    )));
    for hidden in [
        &m.fleetd,
        &m.node,
        &m.home.join(".ssh"),
        &m.home.join(".config"),
        &m.other,
    ] {
        assert!(fence.hide.contains(hidden), "{}", hidden.display());
    }
    // A project whose root holds the whole home isn't hidden: the Navi's folder and its tools are in it.
    assert!(!fence.hide.contains(&m.home));
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
    // claude's shared state reads as its own private copy: another session's shell snapshot isn't even there.
    let shared = m.claude.join("shell-snapshots/snapshot-other.sh");
    let (_, out) = m.run(
        &tool,
        &format!(
            "cat '{}'; echo pwned > '{}'",
            shared.display(),
            shared.display()
        ),
    );
    assert!(!out.contains("another session's"), "{out}");
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
    ] {
        let (ok, out) = m.run(&tool, &format!("cat '{}'", secret.display()));
        assert!(!ok, "{} was read: {out}", secret.display());
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
         test -x '{exe}'",
        mcp = m.session.join("mcp.json").display(),
        transcripts = super::super::claude::session_file(&m.claude, &m.folder, "s1")
            .unwrap()
            .parent()
            .unwrap()
            .display(),
        exe = m.node.join("bin/fleetd-agent-1").display(),
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
        write: vec!["/Users/ada/.fleetd/node/navi/ada".into()],
        hide: vec!["/Users/ada/.fleetd".into(), "/Users/ada/.ssh".into()],
        show: vec!["/Users/ada/.fleetd/node/sessions/s1".into()],
        keep: vec!["/Users/ada/.fleetd/node/navi/ada/.claude".into()],
        private: vec![],
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
    let hidden = line("(deny file-read-data file-read-xattr");
    let shown = line("(allow file-read-data file-read-xattr");
    assert!(hidden < shown);
    assert!(
        profile
            .lines()
            .nth(hidden)
            .unwrap()
            .contains("\"/Users/ada/.ssh\"")
    );
    // The folder is under the hidden fleetd dir, and is read again.
    assert!(profile.lines().nth(shown).unwrap().contains("navi/ada"));
    assert_eq!(quoted(Path::new("/a \"b\"\\c")), "\"/a \\\"b\\\"\\\\c\"");
}
