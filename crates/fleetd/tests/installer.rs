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
