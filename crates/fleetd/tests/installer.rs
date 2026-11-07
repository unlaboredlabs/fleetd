//! site/install.sh, run by `sh` as `curl … | sh -s -- …` runs it, against a release directory on disk
//! (FLEETD_BASE_URL=file://…) whose "fleetd" only writes down the arguments it got. No network, nothing installed
//! outside a throwaway HOME.
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// What the stub fleetd writes: one argument a line.
const STUB: &str =
    "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done >\"$HOME/fleetd-args\"\n";

struct Release {
    dir: tempfile::TempDir,
}

impl Release {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::create_dir_all(dir.path().join("home")).unwrap();
        let mut sums = String::new();
        for os in ["linux", "darwin"] {
            for arch in ["x64", "arm64"] {
                let name = format!("fleetd-{os}-{arch}");
                std::fs::write(assets.join(&name), STUB).unwrap();
                sums += &format!("{}  {name}\n", sha256(STUB.as_bytes()));
            }
        }
        std::fs::write(assets.join("SHA256SUMS"), sums).unwrap();
        Release { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    /// `script` run by `sh -c`, with $INSTALLER the path of site/install.sh.
    fn run(&self, script: &str) -> Output {
        let installer = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../site/install.sh");
        Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("INSTALLER", installer)
            .env("HOME", self.home())
            .env(
                "FLEETD_BASE_URL",
                format!("file://{}", self.dir.path().join("assets").display()),
            )
            .env_remove("XDG_DATA_HOME")
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("FLEETD_CHANNEL")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    fn fleetd_args(&self) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(self.home().join("fleetd-args")).ok()?;
        Some(text.lines().map(str::to_owned).collect())
    }
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn the_printed_join_command_installs_and_joins_with_the_given_arguments() {
    let release = Release::new();
    // What `fleetd pair --worker` prints, with the installer read from disk instead of fleetd.sh.
    let line = fleetd::cli::pair::join_line(
        "http://devbox.example.ts.net:4790",
        "abc123",
        "laptop",
        Some("O'Neil Ada <1+ada@users.noreply.github.com>"),
    );
    let local = line.replace("curl -fsSL https://fleetd.sh |", "cat \"$INSTALLER\" |");
    assert_ne!(local, line);
    let output = release.run(&local);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        release.fleetd_args().expect("the installer ran fleetd"),
        [
            "init",
            "--join",
            "http://devbox.example.ts.net:4790",
            "--code",
            "abc123",
            "--machine-id",
            "laptop",
            "--git-identity",
            "O'Neil Ada <1+ada@users.noreply.github.com>",
        ]
    );
    assert!(release.home().join(".local/bin/fleetd").exists());

    let release = Release::new();
    let output = release.run("sh \"$INSTALLER\" --join http://hub:4790 --code c --rejoin");
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        release.fleetd_args().unwrap(),
        [
            "init",
            "--join",
            "http://hub:4790",
            "--code",
            "c",
            "--rejoin"
        ]
    );
}

#[test]
fn without_join_options_it_only_installs_when_there_is_no_terminal() {
    let release = Release::new();
    let output = release.run("cat \"$INSTALLER\" | sh");
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        release.fleetd_args(),
        None,
        "no terminal: the wizard is not started"
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Next, run:"));
}

#[test]
fn join_options_that_cannot_work_stop_before_anything_is_downloaded() {
    for (args, says) in [
        ("--join http://hub:4790", "--join and --code go together"),
        ("--code c", "--join and --code go together"),
        ("--join", "--join needs a value"),
        ("--join http://hub:4790 --code", "--code needs a value"),
        ("--machine-id laptop", "only go with --join and --code"),
        ("--mac", "only go with --join and --code"),
        ("--version 0.9.2", "only go with --join and --code"),
        ("--no-init --join http://hub:4790 --code c", "contradict"),
        ("--joint x", "unknown option: --joint"),
    ] {
        let release = Release::new();
        let output = release.run(&format!("sh \"$INSTALLER\" {args}"));
        assert_eq!(output.status.code(), Some(1), "{args}");
        assert!(
            stderr(&output).contains(says),
            "{args}: {}",
            stderr(&output)
        );
        assert!(
            !release.home().join(".fleetd").exists(),
            "{args}: installed anyway"
        );
    }
}

/// The agents' Mac's line carries the hub's version: it is the installer's, never `fleetd init`'s. On Edge, a release
/// that moved on past the hub's build installs the newer one, and says how to bring the hub level; while it is the
/// hub's own, it says nothing.
#[test]
fn the_hubs_version_picks_its_build_and_says_when_edge_moved_on() {
    let hub = "0.0.0-edge.202611071720+6d5a250";
    for (edge, says) in [("0.0.0-edge.202611071744+f893086", true), (hub, false)] {
        let release = Release::new();
        std::fs::write(
            release.dir.path().join("assets/release.json"),
            format!("{{\n  \"channel\": \"edge\",\n  \"cliVersion\": \"{edge}\"\n}}\n"),
        )
        .unwrap();
        let output = release.run(&format!(
            "sh \"$INSTALLER\" --join http://hub:4790 --code c --version {hub}"
        ));
        assert!(output.status.success(), "{}", stderr(&output));
        assert_eq!(
            release.fleetd_args().unwrap(),
            ["init", "--join", "http://hub:4790", "--code", "c"]
        );
        let out = String::from_utf8_lossy(&output.stdout);
        assert_eq!(
            out.contains("your hub runs an older edge build"),
            says,
            "{out}"
        );
        if says {
            assert!(out.contains("press Update in the app on your main machine"), "{out}");
            assert!(!out.contains("mismatch"), "{out}");
        }
    }
}

/// `--mac` joins the agents' Mac only on macOS: anywhere else it stops before anything is downloaded.
#[test]
fn the_agents_mac_join_refuses_any_other_os() {
    if cfg!(target_os = "macos") {
        return;
    }
    let release = Release::new();
    let output = release.run("sh \"$INSTALLER\" --join http://hub:4790 --code c --mac");
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("run the join line on a Mac"),
        "{}",
        stderr(&output)
    );
    assert!(!release.home().join(".fleetd").exists(), "installed anyway");
}

/// An admin at a Mac, faked on any OS: `uname`, `id`, `sudo` and `launchctl` on PATH say so, with launchd's
/// `gui/<uid>` domain there (a login at the Mac's screen) or not (`su`, ssh).
fn fake_mac(release: &Release, logged_in_at_screen: bool) -> String {
    let bin = release.dir.path().join("fake-mac");
    std::fs::create_dir_all(&bin).unwrap();
    for (tool, body) in [
        ("uname", "[ \"$1\" = -m ] && echo arm64 || echo Darwin".to_owned()),
        (
            "id",
            "case \"$1\" in -Gn) echo staff everyone admin ;; -un) echo ada ;; -u) echo 502 ;; esac"
                .to_owned(),
        ),
        ("sudo", "exit 0".to_owned()),
        (
            "launchctl",
            format!(
                "[ \"$*\" = 'print gui/502' ] && exit {}; exit 64",
                if logged_in_at_screen { 0 } else { 113 }
            ),
        ),
    ] {
        let path = bin.join(tool);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
    }
    format!("PATH=\"{}:$PATH\"", bin.display())
}

/// `--mac` from a shell with no login at the Mac's screen (su or ssh) stops before anything is downloaded, with where
/// to log in instead of launchctl's "Bootstrap failed: 125" later; logged in there, it joins, an admin's account too.
#[test]
fn the_agents_mac_join_needs_a_login_at_the_macs_screen() {
    let release = Release::new();
    let path = fake_mac(&release, false);
    let output = release.run(&format!(
        "{path} sh \"$INSTALLER\" --join http://hub:4790 --code c --mac"
    ));
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    let said = stderr(&output);
    assert!(
        said.contains("ada isn't logged in on this Mac's screen"),
        "{said}"
    );
    assert!(
        said.contains("open Terminal there, and paste the join line again"),
        "{said}"
    );
    assert!(!release.home().join(".fleetd").exists(), "installed anyway");

    let path = fake_mac(&release, true);
    let output = release.run(&format!(
        "{path} sh \"$INSTALLER\" --join http://hub:4790 --code c --mac"
    ));
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert!(
        release
            .fleetd_args()
            .is_some_and(|args| args.contains(&"--mac".to_owned())),
        "{}",
        stderr(&output)
    );
}
