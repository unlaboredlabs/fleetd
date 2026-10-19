//! A second fleet on one machine (`--home`, `FLEETD_HOME`) never reads or writes the first one's files: the real
//! binary, run with a throwaway HOME and XDG_CONFIG_HOME that hold a "real" enrolled node.
use std::path::Path;
use std::process::{Command, Output};

struct Machine {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
}

impl Machine {
    /// A user whose own fleet has an enrolled node, as on a worker.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let node = root.join("user/.fleetd/node");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::write(
            node.join("node.json"),
            r#"{"hub":"http://127.0.0.1:1","machineId":"real","name":"real","tags":[],"enrolled":true}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("xdg")).unwrap();
        Machine { _dir: dir, root }
    }

    fn fleetd(&self, args: &[&str], fleetd_home: Option<&Path>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fleetd"));
        command
            .args(args)
            .env("HOME", self.root.join("user"))
            .env("XDG_CONFIG_HOME", self.root.join("xdg"))
            .env_remove("FLEETD_HOME")
            .stdin(std::process::Stdio::null());
        if let Some(dir) = fleetd_home {
            command.env("FLEETD_HOME", dir);
        }
        command.output().unwrap()
    }

    /// The user's own fleet and app config are as they were.
    fn untouched(&self) {
        let fleetd: Vec<_> = std::fs::read_dir(self.root.join("user/.fleetd"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(fleetd, ["node"], "only the real node is under ~/.fleetd");
        assert!(
            std::fs::read_dir(self.root.join("xdg"))
                .unwrap()
                .next()
                .is_none(),
            "nothing written under XDG_CONFIG_HOME"
        );
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn home_keeps_init_and_pair_beside_it() {
    let m = Machine::new();
    let hub = m.root.join("second/hub");
    let hub_arg = hub.to_str().unwrap();
    let listen = format!("127.0.0.1:{}", free_port());
    let init = m.fleetd(
        &[
            "init",
            "--home",
            hub_arg,
            "--no-service",
            "--listen",
            &listen,
        ],
        None,
    );
    let said = String::from_utf8_lossy(&init.stderr);
    assert!(init.status.success(), "{said}");
    assert!(
        said.contains("hub home"),
        "a fresh home gets the plain hub setup, not a repair of the real worker: {said}"
    );
    assert!(hub.join("setup.json").exists());

    let pair = m.fleetd(&["pair", "--home", hub_arg], None);
    assert!(
        pair.status.success(),
        "{}",
        String::from_utf8_lossy(&pair.stderr)
    );
    assert!(m.root.join("second/app-pair.json").exists());
    m.untouched();
}

#[test]
fn fleetd_home_moves_every_default() {
    let m = Machine::new();
    let fleet = m.root.join("third");
    let pair = m.fleetd(&["pair"], Some(&fleet));
    assert!(
        pair.status.success(),
        "{}",
        String::from_utf8_lossy(&pair.stderr)
    );
    assert!(fleet.join("hub/hub.sqlite").exists());
    assert!(fleet.join("app-pair.json").exists());

    let status = m.fleetd(&["status"], Some(&fleet));
    let said = String::from_utf8_lossy(&status.stderr);
    assert!(
        said.contains(&format!(
            "{} has no hub set up",
            fleet.join("hub").display()
        )),
        "{said}"
    );
    m.untouched();
}

#[test]
fn client_commands_take_home() {
    let m = Machine::new();
    let hub = m.root.join("fourth/hub");
    let hub_arg = hub.to_str().unwrap();
    let key = m.root.join("human.key");
    std::fs::write(&key, "fld_x\n").unwrap();
    let key_arg = key.to_str().unwrap();
    for args in [
        vec!["status", "--home", hub_arg],
        vec!["time", "--home", hub_arg],
        vec!["steers", "--key-file", key_arg, "--home", hub_arg],
        vec!["answer", "--key-file", key_arg, "--home", hub_arg],
    ] {
        let out = m.fleetd(&args, None);
        let said = String::from_utf8_lossy(&out.stderr);
        assert!(
            said.contains(&format!("{} has no hub set up", hub.display()))
                || said.contains(&format!(
                    "no hub is set up on this machine ({})",
                    hub.display()
                )),
            "{args:?}: {said}"
        );
    }
    m.untouched();
}
