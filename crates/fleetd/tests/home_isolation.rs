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

/// Services are per user, not per fleet: a second fleet's uninstall and machine remove never stop or delete the first
/// fleet's units, nor (with --purge) what an older fleetd left in ~/.fleetd. `systemctl` and `launchctl` are stubs
/// that only log, so nothing here reaches this machine's real services.
#[test]
fn a_second_fleet_never_touches_the_first_fleets_services() {
    use std::os::unix::fs::PermissionsExt;
    let m = Machine::new();
    let user = m.root.join("user");
    let (hub_unit, node_unit) = if cfg!(target_os = "macos") {
        let agents = user.join("Library/LaunchAgents");
        (
            agents.join("sh.fleetd.hub.plist"),
            agents.join("sh.fleetd.node.plist"),
        )
    } else {
        let units = m.root.join("xdg/systemd/user");
        (
            units.join("fleetd-hub.service"),
            units.join("fleetd-node.service"),
        )
    };
    std::fs::create_dir_all(hub_unit.parent().unwrap()).unwrap();
    let real_hub = format!(
        "ExecStart=fleetd hub start --home {}/.fleetd/hub\n",
        user.display()
    );
    let real_node = format!(
        "ExecStart=fleetd node run --home {}/.fleetd/node\n",
        user.display()
    );
    std::fs::write(&hub_unit, &real_hub).unwrap();
    std::fs::write(&node_unit, &real_node).unwrap();
    std::fs::create_dir_all(user.join(".fleetd/t3")).unwrap();

    let stubs = m.root.join("stubs");
    std::fs::create_dir_all(&stubs).unwrap();
    let log = m.root.join("service-calls.log");
    for tool in ["systemctl", "launchctl"] {
        let stub = stubs.join(tool);
        std::fs::write(
            &stub,
            format!("#!/bin/sh\necho \"{tool} $*\" >> '{}'\n", log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = format!(
        "{}:{}",
        stubs.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let run = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_fleetd"))
            .args(args)
            .env("HOME", &user)
            .env("XDG_CONFIG_HOME", m.root.join("xdg"))
            .env("PATH", &path)
            .env_remove("FLEETD_HOME")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stderr).into_owned()
    };

    let hub = m.root.join("second/hub");
    let hub_arg = hub.to_str().unwrap();
    let listen = format!("127.0.0.1:{}", free_port());
    run(&[
        "init",
        "--home",
        hub_arg,
        "--no-service",
        "--listen",
        &listen,
    ]);
    // A local machine on the second fleet, with the default (empty) unit suffix.
    let setup = hub.join("setup.json");
    let mut state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&setup).unwrap()).unwrap();
    state["machines"]["here"] = serde_json::json!({
        "sshHost": "localhost", "local": true,
        "platform": if cfg!(target_os = "macos") { "darwin" } else { "linux" },
        "home": user, "configHome": m.root.join("xdg"), "uid": 1000, "unitSuffix": "",
    });
    std::fs::write(&setup, state.to_string()).unwrap();

    let removed = run(&["machine", "remove", "here", "--purge", "--home", hub_arg]);
    assert!(removed.contains("another fleet's node"), "{removed}");
    let uninstalled = run(&["uninstall", "--purge", "--home", hub_arg]);
    assert!(uninstalled.contains("another fleet's hub"), "{uninstalled}");

    assert_eq!(std::fs::read_to_string(&hub_unit).unwrap(), real_hub);
    assert_eq!(std::fs::read_to_string(&node_unit).unwrap(), real_node);
    assert!(
        user.join(".fleetd/t3").exists(),
        "the first fleet's T3 leftovers stay"
    );
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(
        !calls.contains("fleetd-") && !calls.contains("sh.fleetd."),
        "{calls}"
    );
    assert!(!hub.exists(), "the second fleet's own hub home is purged");
}
