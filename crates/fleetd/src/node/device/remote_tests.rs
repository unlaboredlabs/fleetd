use super::*;

fn args(line: &[&str]) -> Vec<String> {
    line.iter().map(|s| (*s).to_owned()).collect()
}

fn refused(line: &[&str]) -> String {
    match parse(&args(line)) {
        Ok(parsed) => panic!("{line:?} was allowed: {parsed:?}"),
        Err(e) => e.message,
    }
}

#[test]
fn only_commands_that_drive_the_screen_run_on_another_machine() {
    for line in [
        &["batch", "--steps", "[]"][..],
        &["replay", "flow.ad"],
        &["test", "suite"],
        &["mcp"],
        &["daemon", "stop"],
        &["proxy"],
        &["connect"],
        &["plugins", "install", "x"],
        &["metro", "reload"],
        &["devices"],
        &["boot"],
        &["shutdown"],
        &["clipboard", "read"],
        &["install-from-source", "https://example.com/app.zip"],
        &["logs", "path"],
        &["sh", "-c", "id"],
    ] {
        let why = refused(line);
        assert!(why.contains("doesn't run here"), "{line:?}: {why}");
    }
    // No flag picks another device, platform, session or config, or runs a script.
    for line in [
        &[
            "open",
            "Settings",
            "--udid",
            "8A1B2C3D-0000-4000-8000-000000000002",
        ][..],
        &["snapshot", "--platform", "macos"],
        &["snapshot", "--platform=macos"],
        &["press", "@e1", "--device", "iPhone 17"],
        &["press", "@e1", "--session", "other"],
        &["snapshot", "--config", "/Users/me/c.json"],
        &["open", "Settings", "--save-script", "x.ad"],
        &["open", "Settings", "--launch-console", "/Users/me/.zshrc"],
        &["close", "--shutdown"],
        &["fill", "@e1", "--text-stdin"],
    ] {
        let why = refused(line);
        assert!(why.contains("doesn't run here"), "{line:?}: {why}");
    }
    assert!(refused(&["--config", "c.json", "snapshot"]).contains("doesn't run here"));
    // Nothing of the Mac's own.
    assert!(refused(&["open", "/System/Applications/Calculator.app"]).contains("names a file"));
    assert!(refused(&["open", "Safari", "FILE:///etc/passwd"]).contains("names a file"));
    assert!(refused(&["open", "App", "--launch-url", "file:///Users/me"]).contains("names a file"));
    assert!(refused(&["settings", "permission", "grant", "accessibility"]).contains("host Mac"));
    assert!(refused(&["record", "contact-sheet", "v.mp4"]).contains("record start"));
    // A file a command writes is always named, so it can come back.
    assert!(refused(&["screenshot"]).contains("file name"));
    assert!(refused(&["record", "start"]).contains("file name"));
    assert!(refused(&["snapshot", "-i=1"]).contains("no value"));
}

#[test]
fn a_command_reads_as_the_screens_node_runs_it() {
    let parsed = parse(&args(&[
        "screenshot",
        "--out=shots/a.png",
        "--pixel-density",
        "3",
    ]))
    .unwrap();
    assert_eq!(
        parsed.args,
        args(&["screenshot", "--out", "shots/a.png", "--pixel-density", "3"])
    );
    assert_eq!(
        parsed.roles,
        vec![
            Role::Plain,
            Role::Plain,
            Role::Out,
            Role::Plain,
            Role::Plain
        ]
    );
    let swipe = parse(&args(&["swipe", "10", "-20", "30", "40"])).unwrap();
    assert!(swipe.roles.iter().all(|r| *r == Role::Plain));
    assert_eq!(
        parse(&args(&["install", "build/app.zip"])).unwrap().roles,
        vec![Role::Plain, Role::In]
    );
    assert_eq!(
        parse(&args(&["reinstall", "sh.fleetd.app", "app.zip"]))
            .unwrap()
            .roles,
        vec![Role::Plain, Role::Plain, Role::In]
    );
    assert_eq!(
        parse(&args(&["push", "sh.fleetd.app", "{\"aps\":{}}"]))
            .unwrap()
            .roles,
        vec![Role::Plain; 3]
    );
    assert_eq!(
        parse(&args(&["push", "sh.fleetd.app", "payload.json"]))
            .unwrap()
            .roles[2],
        Role::InOrJson
    );
    for line in [
        &["open", "com.apple.Preferences", "--foreground"][..],
        &["open", "Expo Go", "exp://127.0.0.1:8081"],
        &["snapshot", "-i"],
        &["press", "@e3", "--settle"],
        &["fill", "@e7", "Ada Lovelace", "--settle"],
        &["record", "stop"],
        &["settings", "appearance", "dark"],
        &["help", "workflow"],
        &["--help"],
        &[],
    ] {
        assert!(parse(&args(line)).is_ok(), "{line:?}");
    }
}

#[test]
fn files_come_only_from_the_worktree_and_go_back_into_it() {
    let dir = tempfile::tempdir().unwrap();
    let worktree = dir.path().join("work");
    std::fs::create_dir_all(worktree.join("build/App.app")).unwrap();
    std::fs::write(worktree.join("build/app.zip"), b"PK zipped app").unwrap();
    std::fs::write(dir.path().join("secret.txt"), b"not the agent's").unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.txt"), worktree.join("link.zip")).unwrap();
    std::os::unix::fs::symlink(dir.path(), worktree.join("up")).unwrap();
    let mut seq = 0;
    let mapped = map(
        &args(&["install", "app.zip"]),
        &worktree.join("build"),
        &worktree,
        &mut seq,
    )
    .unwrap();
    assert_eq!(mapped.args, args(&["install", "in/1-app.zip"]));
    let real = std::fs::canonicalize(&worktree).unwrap();
    assert_eq!(
        mapped.inputs,
        vec![Local {
            name: "1-app.zip".into(),
            path: real.join("build/app.zip"),
            shown: "app.zip".into(),
        }]
    );
    let shot = map(
        &args(&["screenshot", "shots/new/home.png"]),
        &worktree,
        &worktree,
        &mut seq,
    )
    .unwrap();
    assert_eq!(shot.args, args(&["screenshot", "out/2-home.png"]));
    assert_eq!(shot.outputs[0].path, real.join("shots/new/home.png"));
    for (line, cwd) in [
        (&["install", "../secret.txt"][..], &worktree),
        (&["install", "/etc/hosts"], &worktree),
        (&["install", "link.zip"], &worktree),
        (&["screenshot", "../out.png"], &worktree),
        (&["screenshot", "up/out.png"], &worktree),
        (&["screenshot", "/tmp/out.png"], &worktree),
    ] {
        let why = map(&args(line), cwd, &worktree, &mut seq)
            .unwrap_err()
            .message;
        assert!(why.contains("outside your worktree"), "{line:?}: {why}");
    }
    let folder = map(
        &args(&["install", "build/App.app"]),
        &worktree,
        &worktree,
        &mut seq,
    )
    .unwrap_err();
    assert!(folder.message.contains("is a folder"), "{}", folder.message);
    assert!(folder.fix.unwrap().contains("zip"));
    // Back into the worktree: its folders made, never written through a link out of it.
    write_output(&worktree, &shot.outputs[0].path, b"png").unwrap();
    assert_eq!(
        std::fs::read(worktree.join("shots/new/home.png")).unwrap(),
        b"png"
    );
    assert!(write_output(&worktree, &worktree.join("up/x.png"), b"png").is_err());
    assert!(!dir.path().join("x.png").exists());
}

#[test]
fn what_the_command_says_names_the_files_as_the_agent_did() {
    let shot = Local {
        name: "2-home.png".into(),
        path: "/w/shots/home.png".into(),
        shown: "shots/home.png".into(),
    };
    assert_eq!(
        shown_back("Saved out/2-home.png (390x844)", &[&shot]),
        "Saved shots/home.png (390x844)"
    );
    assert_eq!(
        command_line(&args(&["fill", "@e7", "Ada Lovelace"])),
        "agent-device fill @e7 'Ada Lovelace'"
    );
}

/// A stand-in for the node's agent-device wrapper: copies what it reads to what it writes, and says what it was
/// given.
fn fake_agent_device(dir: &Path) -> PathBuf {
    let program = dir.join("agent-device");
    std::fs::write(
        &program,
        "#!/bin/sh\n\
         echo \"ran $* in $(pwd) as ${AGENT_DEVICE_HOME:-nobody} ${AGENT_DEVICE_PLATFORM:-}\"\n\
         if [ \"$1\" = install ]; then cat \"$2\" > out/9-copy.bin; fi\n\
         if [ \"$1\" = screenshot ]; then printf 'png' > \"$2\"; echo \"saved $(pwd)/$2\" >&2; fi\n\
         exit 3\n",
    )
    .unwrap();
    std::fs::set_permissions(
        &program,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    program
}

#[test]
fn a_command_held_back_drops_its_files_so_they_never_pile_up() {
    let dir = tempfile::tempdir().unwrap();
    let work = Work::at(dir.path(), "H0123456789abcdef0123456789abcdef");
    let piece = B64.encode(vec![7u8; PIECE]);
    // An install sent again every few seconds while the screen's runner starts: more than FILE_MAX in all.
    for _ in 0..(FILE_MAX / PIECE as u64 + 2) {
        work.put("1-app.zip", 0, &piece).unwrap();
        let held = work.held_back(RUNNER_STARTING);
        assert_eq!(
            (held.exit_code, held.stderr.as_str()),
            (75, RUNNER_STARTING)
        );
        assert!(!work.dir().join("in").exists(), "its files go");
    }
}

#[tokio::test]
async fn a_file_goes_in_and_a_file_comes_back_on_the_screens_node() {
    let dir = tempfile::tempdir().unwrap();
    let work = Work::at(dir.path(), "H0123456789abcdef0123456789abcdef");
    let program = fake_agent_device(dir.path());
    let app = vec![7u8; PIECE + 10];
    let first = B64.encode(&app[..PIECE]);
    assert_eq!(
        work.put("1-app.zip", 0, &first).unwrap(),
        DeviceDone::Put {
            bytes: PIECE as u64
        }
    );
    // Pieces go in order, under plain names only.
    assert!(work.put("1-app.zip", 0, &first).is_err());
    assert!(work.put("../app.zip", 0, &first).is_err());
    assert!(work.put(".agent-device.json", 0, &first).is_err());
    work.put("1-app.zip", PIECE as u64, &B64.encode(&app[PIECE..]))
        .unwrap();
    // Only what this folder holds, and only an install the node allows.
    let install = args(&["install", "in/1-app.zip"]);
    work.check(&install, true).unwrap();
    let off = work.check(&install, false).unwrap_err();
    assert_eq!(off.code, ErrorCode::Forbidden);
    assert!(
        off.message.contains("\"remoteInstall\": false"),
        "{}",
        off.message
    );
    for bad in [
        &["install", "in/2-other.zip"][..],
        &["install", "/Users/me/App.zip"],
        &["install", "in/../../secret"],
        &["screenshot", "/Users/me/.zshrc"],
        &["screenshot", "shot.png"],
        &["screenshot", "--out=out/1.png"],
    ] {
        assert!(work.check(&args(bad), true).is_err(), "{bad:?}");
    }
    let env = vec![(
        "AGENT_DEVICE_HOME".to_owned(),
        "/n/sessions/H/agent-device".to_owned(),
    )];
    let ran = work.run(&program, &env, &install, RUN_WAIT).await;
    assert_eq!(ran.exit_code, 3);
    assert_eq!(
        ran.stdout.trim(),
        format!(
            "ran install in/1-app.zip in {} as /n/sessions/H/agent-device",
            work.dir().display()
        )
    );
    assert_eq!(
        ran.files,
        vec![DeviceFile {
            name: "9-copy.bin".into(),
            bytes: app.len() as u64
        }]
    );
    assert!(!work.dir().join("in").exists(), "what it read goes");
    let mut back = Vec::new();
    loop {
        let DeviceDone::Get { data_b64, total } =
            work.get("9-copy.bin", back.len() as u64).unwrap()
        else {
            panic!("a get");
        };
        back.extend(B64.decode(data_b64).unwrap());
        if back.len() as u64 >= total {
            break;
        }
    }
    assert_eq!(back, app);
    assert!(work.get("9-copy.bin", 0).is_err(), "gone once read");
    // Its folder's own path stays on its machine.
    let shot = work
        .run(
            &program,
            &env,
            &args(&["screenshot", "out/3-home.png"]),
            RUN_WAIT,
        )
        .await;
    assert_eq!(shot.stderr.trim(), "saved out/3-home.png");
    work.remove();
    assert!(!work.dir().exists());
}

#[tokio::test]
async fn a_command_that_runs_too_long_is_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("agent-device");
    std::fs::write(&program, "#!/bin/sh\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(
        &program,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let work = Work::at(dir.path(), "H0123456789abcdef0123456789abcdef");
    let ran = work
        .run(
            &program,
            &[],
            &args(&["snapshot"]),
            Duration::from_millis(200),
        )
        .await;
    assert_eq!(ran.exit_code, 124);
}

#[test]
fn the_forwarder_is_there_only_while_a_screen_runs_elsewhere() {
    let home = tempfile::tempdir().unwrap();
    install_forwarder(home.path(), "th-1", "/n/bin/fleetd-agent-7").unwrap();
    let bin = bin_dir(home.path(), "th-1").join("agent-device");
    assert_eq!(
        std::fs::read_to_string(&bin).unwrap(),
        forwarder_script("/n/bin/fleetd-agent-7")
    );
    assert!(
        forwarder_script("/n/bin/fleetd-agent-7")
            .contains("exec '/n/bin/fleetd-agent-7' agent-device \"$@\"")
    );
    remove_forwarder(home.path(), "th-1");
    assert!(!bin.exists());
    install_forwarder(home.path(), "th-2", "/x").unwrap();
    std::fs::create_dir_all(Work::at(home.path(), "H1").dir()).unwrap();
    sweep(home.path());
    assert!(!bin_dir(home.path(), "th-2").exists());
    assert!(!Work::at(home.path(), "H1").dir().exists());
}
