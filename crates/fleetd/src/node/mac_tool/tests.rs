use std::path::Path;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::ids::{MachineId, ProjectId, ThreadId};
use fleetd_contracts::mac::{MacCallFrame, MacCaller, MacEnv};
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::tasks::TaskId;

use super::host::Host;
use super::*;
use crate::node::identity::load_or_create_box_key;

fn caller(thread: &str) -> MacCaller {
    MacCaller {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
        task_id: Some(TaskId::unchecked("T1")),
        thread_id: ThreadId::unchecked(thread),
    }
}

/// A Mac under `dir`, and its public key.
fn mac(dir: &Path) -> (Host, [u8; 32]) {
    let key = load_or_create_box_key(&dir.join("node")).unwrap();
    let public: [u8; 32] = B64.decode(key.public_key()).unwrap().try_into().unwrap();
    (
        Host::new(MacToolConfig::default(), key, dir.join("work")),
        public,
    )
}

/// A step sealed as an agent's node seals it, with its answer key.
fn sealed(to: &[u8; 32], thread: &str, at_ms: i64, nonce: &str, step: Step) -> (String, [u8; 32]) {
    let answer_key: [u8; 32] = rand::random();
    let envelope = Envelope {
        thread: thread.into(),
        at_ms,
        nonce: nonce.into(),
        answer_key: B64.encode(answer_key),
        step,
    };
    (
        seal_to(to, &serde_json::to_vec(&envelope).unwrap()).unwrap(),
        answer_key,
    )
}

fn frame(thread: &str, sealed: String) -> MacCallFrame {
    MacCallFrame {
        id: NonEmpty::unchecked("1"),
        caller: caller(thread),
        sealed: NonEmpty::unchecked(sealed),
    }
}

#[tokio::test]
async fn a_step_runs_only_sealed_to_this_mac_for_the_session_the_hub_names_once_and_lately() {
    let dir = tempfile::tempdir().unwrap();
    let (host, key) = mac(dir.path());
    let (step, answer_key) = sealed(&key, "s1", now_ms(), "n1", Step::Ps);
    let answer = host.answer(frame("s1", step.clone())).await;
    let (opened, _) = open_answer(&answer_key, answer.sealed.unwrap().as_str()).unwrap();
    assert_eq!(opened.done, Some(Done::Ps { jobs: vec![] }));
    // The hub plays it again: refused, in clear, with nothing of the agent's.
    let again = host.answer(frame("s1", step)).await;
    assert!(again.sealed.is_none());
    assert!(again.error.unwrap().message.contains("second time"));
    // Sealed for another session than the hub says.
    let (other, _) = sealed(&key, "s2", now_ms(), "n2", Step::Ps);
    let moved = host.answer(frame("s1", other)).await;
    assert!(
        moved
            .error
            .unwrap()
            .message
            .contains("another agent's session")
    );
    // Too old.
    let (old, _) = sealed(&key, "s1", now_ms() - 2 * SKEW_MS, "n3", Step::Ps);
    assert!(host.answer(frame("s1", old)).await.error.is_some());
    // Sealed to another key.
    let (elsewhere, _) = sealed(&rand::random(), "s1", now_ms(), "n4", Step::Ps);
    let refused = host.answer(frame("s1", elsewhere)).await;
    assert!(
        refused
            .error
            .unwrap()
            .message
            .contains("not sealed to this Mac")
    );
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// The agent's worktree pushed to the Mac, as the client does it: snapshot, have, pack, put, checkout.
async fn push(host: &Host, worktree: &Path, scratch: &Path) -> (String, u64) {
    let agent = host.agent(&caller("s1")).unwrap();
    let Done::Have { snapshots, .. } = host.step(&agent, Step::Have).await.unwrap() else {
        panic!()
    };
    let known = push::known(worktree, &snapshots);
    let snapshot = push::snapshot(worktree, scratch, known.first().map(String::as_str)).unwrap();
    let mut sent = 0;
    let pack = if known.contains(&snapshot) {
        None
    } else {
        let path = push::pack(worktree, scratch, &snapshot, &known).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        sent = bytes.len() as u64;
        let put = Step::Put {
            name: "push.pack".into(),
            offset: 0,
            data_b64: B64.encode(&bytes),
        };
        host.step(&agent, put).await.unwrap();
        Some("push.pack".to_owned())
    };
    let done = host
        .step(&agent, Step::Checkout { snapshot, pack })
        .await
        .unwrap();
    let Done::Checkout { folder } = done else {
        panic!()
    };
    (folder, sent)
}

#[tokio::test]
async fn a_push_brings_commits_changes_and_new_files_and_next_time_only_what_changed() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _) = mac(dir.path());
    let (wt, scratch) = (dir.path().join("wt"), dir.path().join("scratch"));
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::create_dir_all(&scratch).unwrap();
    git(&wt, &["init", "-q"]);
    std::fs::write(wt.join(".gitignore"), "build/\n").unwrap();
    // Random, so it doesn't pack small.
    let big: Vec<u8> = (0..200_000).map(|_| rand::random::<u8>()).collect();
    std::fs::write(wt.join("big.bin"), big).unwrap();
    std::fs::write(wt.join("gone.txt"), "old").unwrap();
    git(&wt, &["add", "-A"]);
    git(&wt, &["commit", "-qm", "base"]);
    let head = git(&wt, &["rev-parse", "HEAD"]);
    // Uncommitted, new, and ignored files.
    std::fs::write(wt.join("gone.txt"), "changed").unwrap();
    std::fs::write(wt.join("new.txt"), "new").unwrap();
    std::fs::create_dir_all(wt.join("build")).unwrap();
    std::fs::write(wt.join("build/out.o"), "obj").unwrap();

    let (folder, first) = push(&host, &wt, &scratch).await;
    let repo = Path::new(&folder);
    assert_eq!(repo, dir.path().join("work/T1/repo"));
    assert_eq!(
        std::fs::read_to_string(repo.join("gone.txt")).unwrap(),
        "changed"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("new.txt")).unwrap(),
        "new"
    );
    assert!(!repo.join("build").exists(), "ignored files stay behind");
    // The agent's own repository is as it was: same HEAD, same index.
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git(&wt, &["status", "--porcelain"]),
        "M gone.txt\n?? new.txt"
    );

    // A build on the Mac (ignored there too) survives the next push; a file deleted here goes there.
    std::fs::create_dir_all(repo.join("build")).unwrap();
    std::fs::write(repo.join("build/app"), "built").unwrap();
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    std::fs::write(wt.join("new.txt"), "newer").unwrap();
    let (_, second) = push(&host, &wt, &scratch).await;
    assert!(!repo.join("gone.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.join("new.txt")).unwrap(),
        "newer"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("build/app")).unwrap(),
        "built"
    );
    assert!(
        second < first / 10,
        "only what changed went: {second} after {first}"
    );
    // Nothing changed: nothing goes.
    assert_eq!(push(&host, &wt, &scratch).await.1, 0);
}

#[tokio::test]
async fn a_pull_brings_a_file_or_a_folder_from_the_agents_folder_into_its_worktree_only() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _) = mac(dir.path());
    let agent = host.agent(&caller("s1")).unwrap();
    let app = agent.dir.join("DerivedData/Build/App.app");
    std::fs::create_dir_all(app.join("Assets")).unwrap();
    std::fs::write(app.join("Info.plist"), "plist").unwrap();
    std::fs::write(app.join("Assets/a.png"), "png").unwrap();
    std::fs::create_dir_all(agent.repo()).unwrap();
    std::fs::write(agent.repo().join("shot.png"), "shot").unwrap();
    let wt = dir.path().join("wt");
    std::fs::create_dir_all(&wt).unwrap();

    let pull = |path: String, to: Option<&'static str>| {
        let (dir, repo, wt) = (agent.dir.clone(), agent.repo(), wt.clone());
        async move {
            let dest = client::destination(&wt, &path, to)?;
            let Done::Get {
                data_b64, folder, ..
            } = host::get(&dir, &repo, &path, 0, false)?.0
            else {
                panic!()
            };
            let part = wt.join(".part");
            std::fs::write(&part, B64.decode(data_b64).unwrap()).unwrap();
            client::place(&part, &dest, folder).map_err(|e| {
                fleetd_contracts::mcp::McpToolError::new(
                    fleetd_contracts::mcp::ErrorCode::Failed,
                    e,
                )
            })?;
            Ok::<_, fleetd_contracts::mcp::McpToolError>(dest)
        }
    };
    let shot = pull("shot.png".into(), None).await.unwrap();
    assert_eq!(std::fs::read_to_string(shot).unwrap(), "shot");
    let dest = pull(app.to_string_lossy().into_owned(), Some("out/App.app"))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(dest.join("Assets/a.png")).unwrap(),
        "png"
    );
    // Nothing from outside the agent's folder on the Mac, nothing outside the worktree here.
    let elsewhere = dir.path().join("node");
    assert!(
        pull(elsewhere.to_string_lossy().into_owned(), None)
            .await
            .is_err()
    );
    assert!(pull("../../other/repo/x".into(), None).await.is_err());
    assert!(client::destination(&wt, "shot.png", Some("../x")).is_err());
    assert!(client::destination(&wt, "shot.png", Some("/etc/x")).is_err());
    let inside = wt.join("in/x").to_string_lossy().into_owned();
    assert_eq!(
        client::destination(&wt, "shot.png", Some(&inside)).unwrap(),
        wt.join("in/x")
    );
}

/// The job's whole output and exit code, following it as `mac run` does.
async fn follow(host: &Host, agent: &host::Agent, job: u32) -> (String, Option<i32>) {
    let (mut out, mut offset) = (Vec::new(), 0);
    loop {
        let Done::Logs {
            data_b64,
            offset: next,
            done,
            exit_code,
        } = host.step(agent, Step::Logs { job, offset }).await.unwrap()
        else {
            panic!()
        };
        out.extend(B64.decode(data_b64).unwrap());
        offset = next;
        if done {
            return (String::from_utf8(out).unwrap(), exit_code);
        }
    }
}

#[tokio::test]
async fn a_run_streams_its_output_masked_and_ends_with_its_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _) = mac(dir.path());
    let agent = host.agent(&caller("s1")).unwrap();
    let run = Step::Run {
        args: vec!["echo dir=$FLEETD_MAC_DIR; echo token=$GH_TOKEN; echo sock=$FLEETD_NODE_SOCK >&2; exit 3".into()],
        env: vec![MacEnv {
            name: "GH_TOKEN".into(),
            value: "ghp_secretvalue123".into(),
        }],
        background: false,
    };
    let Done::Run { job } = host.step(&agent, run).await.unwrap() else {
        panic!()
    };
    let (out, code) = follow(&host, &agent, job).await;
    assert_eq!(code, Some(3));
    assert!(
        out.contains(&format!("dir={}", agent.dir.display())),
        "{out}"
    );
    assert!(out.contains("token=***GH_TOKEN***"), "{out}");
    assert!(!out.contains("ghp_secretvalue123"));
    assert!(out.contains("sock=/dev/null"), "{out}");
    let Done::Ps { jobs } = host.step(&agent, Step::Ps).await.unwrap() else {
        panic!()
    };
    assert_eq!(jobs.len(), 1);
    assert_eq!((jobs[0].running, jobs[0].exit_code), (false, Some(3)));
}

#[tokio::test]
async fn kill_ends_a_background_job_and_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _) = mac(dir.path());
    let agent = host.agent(&caller("s1")).unwrap();
    let run = Step::Run {
        args: vec!["sleep 30 & sleep 30".into()],
        env: vec![],
        background: true,
    };
    let Done::Run { job } = host.step(&agent, run).await.unwrap() else {
        panic!()
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        host.step(&agent, Step::Kill { job }).await.unwrap(),
        Done::Kill { job, killed: true }
    );
    let (_, code) = tokio::time::timeout(Duration::from_secs(20), follow(&host, &agent, job))
        .await
        .unwrap();
    assert_eq!(code, Some(128 + 15));
    assert_eq!(
        host.step(&agent, Step::Kill { job }).await.unwrap(),
        Done::Kill { job, killed: false }
    );
}

#[tokio::test]
async fn the_activity_file_lists_running_jobs_with_their_project_masked_and_drops_them_once_they_end()
 {
    let dir = tempfile::tempdir().unwrap();
    let (host, _) = mac(dir.path());
    let agent = host.agent(&caller("s1")).unwrap();
    let run = Step::Run {
        args: vec!["sleep 30 # NPM_TOKEN=s3cret".into()],
        env: vec![MacEnv {
            name: "NPM_TOKEN".into(),
            value: "s3cret".into(),
        }],
        background: true,
    };
    let Done::Run { job } = host.step(&agent, run).await.unwrap() else {
        panic!()
    };
    let now = host.activity();
    assert!(now.simulators.is_empty());
    let [running] = now.jobs.as_slice() else {
        panic!("{now:?}")
    };
    assert_eq!(
        (
            running.agent.as_str(),
            running.project_id.as_str(),
            running.job
        ),
        ("T1", "app", job)
    );
    assert!(!running.command.contains("s3cret"), "{}", running.command);

    // Written whole, in the names the app reads (app/desktop/src/main/menuBar.ts), and only when it changed.
    let home = dir.path().join("node");
    let mut last = None;
    activity::write(&home, &now, &mut last);
    let file = activity::file(&home);
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(json["jobs"][0]["projectId"], "app");
    assert!(json["jobs"][0]["startedMs"].is_i64());
    assert_eq!(json["simulators"], serde_json::json!([]));
    std::fs::remove_file(&file).unwrap();
    activity::write(&home, &now, &mut last);
    assert!(!file.exists(), "unchanged, so not written again");

    host.step(&agent, Step::Kill { job }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), follow(&host, &agent, job))
        .await
        .unwrap();
    assert!(host.activity().jobs.is_empty());
    activity::write(&home, &host.activity(), &mut last);
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(json["jobs"], serde_json::json!([]));
}

#[test]
fn a_long_command_is_clipped_for_the_activity_file() {
    let long = "x".repeat(activity::COMMAND_MAX + 50);
    assert_eq!(
        activity::clip_command(&long).chars().count(),
        activity::COMMAND_MAX + 1
    );
    assert_eq!(activity::clip_command("xcodebuild test"), "xcodebuild test");
}

#[test]
fn a_job_gets_its_folders_and_the_named_variables_and_nothing_else_of_the_nodes() {
    let agent = host::Agent {
        dir: "/w/T1".into(),
        project: "app".into(),
        name: "T1".into(),
    };
    let node = [
        ("PATH", "/usr/bin:/bin"),
        ("HOME", "/Users/agents"),
        ("FLEETD_HUB_KEY", "k"),
        ("SSH_AUTH_SOCK", "/tmp/s"),
    ]
    .map(|(k, v)| (k.to_owned(), v.to_owned()));
    let named = [MacEnv {
        name: "NPM_TOKEN".into(),
        value: "v".into(),
    }];
    let env = jobs::job_env(
        &agent,
        Path::new("/w/.cache"),
        &named,
        node.clone().into_iter(),
        None,
    );
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    // Homebrew's commands last (CocoaPods), and UTF-8 for CocoaPods where the node had no LANG.
    assert_eq!(
        get("PATH"),
        Some("/w/T1/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
    );
    assert_eq!(get("LANG"), Some("en_US.UTF-8"));
    assert_eq!(get("FLEETD_MAC_DERIVED_DATA"), Some("/w/T1/DerivedData"));
    assert_eq!(get("FLEETD_MAC_CACHE"), Some("/w/.cache"));
    assert_eq!(get("TMPDIR"), Some("/w/T1/tmp"));
    assert_eq!(get("NPM_TOKEN"), Some("v"));
    assert_eq!(get("FLEETD_HUB_KEY"), None);
    assert_eq!(get("SSH_AUTH_SOCK"), None);
    assert_eq!(get("AGENT_DEVICE_HOME"), None);
    assert_eq!(get("FLEETD_MAC_SIM"), None);
    // Holding a simulator: agent-device's wrapper comes first, pointed at it, and plain simctl gets its udid and set.
    let device = jobs::SimEnv {
        home: "/n".into(),
        key: host::sim_key("T1"),
        udid: "8A1B2C3D-0000-4000-8000-000000000002".into(),
    };
    let env = jobs::job_env(
        &agent,
        Path::new("/w/.cache"),
        &[],
        node.into_iter(),
        Some(&device),
    );
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(
        get("PATH"),
        Some("/n/device/ios/bin:/w/T1/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
    );
    assert_eq!(
        get("AGENT_DEVICE_HOME"),
        Some("/n/sessions/mac-T1/agent-device")
    );
    assert_eq!(
        get("FLEETD_MAC_SIM"),
        Some("8A1B2C3D-0000-4000-8000-000000000002")
    );
    assert_eq!(get("FLEETD_MAC_SIM_SET"), Some("/n/device/ios/set"));
    // A node whose PATH has Homebrew already, and a LANG of its own: neither twice, nor changed.
    let node = [
        ("PATH", "/opt/homebrew/bin:/usr/bin"),
        ("LANG", "fr_FR.UTF-8"),
    ]
    .map(|(k, v)| (k.to_owned(), v.to_owned()));
    let env = jobs::job_env(&agent, Path::new("/w/.cache"), &[], node.into_iter(), None);
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(
        get("PATH"),
        Some("/w/T1/bin:/opt/homebrew/bin:/usr/bin:/usr/local/bin")
    );
    assert_eq!(get("LANG"), Some("fr_FR.UTF-8"));
    assert_eq!(env.iter().filter(|(k, _)| k == "LANG").count(), 1);
}

#[test]
fn the_simulator_budget_comes_from_the_macs_memory_unless_set() {
    let gb = |n: u64| n << 30;
    assert_eq!(sim_budget(gb(8)), 1);
    assert_eq!(sim_budget(gb(16)), 2);
    assert_eq!(sim_budget(gb(32)), 8);
    assert_eq!(sim_budget(gb(64)), 18);
    let dir = tempfile::tempdir().unwrap();
    let key = load_or_create_box_key(dir.path()).unwrap();
    let set = MacToolConfig {
        enabled: Some(true),
        simulators: Some(3),
    };
    assert_eq!(Host::new(set, key, dir.path().join("work")).sim_budget(), 3);
}

#[tokio::test]
async fn a_mac_without_simulators_says_so_and_jobs_get_no_device() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _) = mac(dir.path());
    let agent = host.agent(&caller("s1")).unwrap();
    for wait in [true, false] {
        let refused = host
            .step(&agent, Step::SimStart { device: None, wait })
            .await
            .unwrap_err();
        assert!(
            refused.message.contains("no iOS simulators"),
            "{}",
            refused.message
        );
    }
    assert_eq!(
        host.step(&agent, Step::SimEnd).await.unwrap(),
        Done::SimEnd { ended: false }
    );
}

#[test]
fn folders_nothing_touched_for_days_go_with_their_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for name in ["T1", "T2"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
        std::fs::write(root.join(name).join(".used"), "").unwrap();
    }
    let old = std::time::SystemTime::now() - Duration::from_secs(5 * 86_400);
    std::fs::File::options()
        .write(true)
        .open(root.join("T1/.used"))
        .unwrap()
        .set_modified(old)
        .unwrap();
    std::fs::create_dir_all(root.join(".cache")).unwrap();
    host::sweep(root, host::FOLDER_DAYS);
    assert!(!root.join("T1").exists());
    assert!(root.join("T2").exists());
    assert!(root.join(".cache").exists());
}

#[test]
fn an_answer_opens_only_with_its_own_key() {
    let key: [u8; 32] = rand::random();
    let answer = Answer {
        done: Some(Done::Run { job: 4 }),
        error: None,
    };
    let sealed = seal_answer(&key, &answer, &[]);
    assert_eq!(
        open_answer(&key, &sealed).unwrap().0.done,
        Some(Done::Run { job: 4 })
    );
    // Raw bytes after the answer come back as they went.
    let tail = [0u8, b'{', b'}', 255, b'\n'];
    let (opened, raw) = open_answer(&key, &seal_answer(&key, &answer, &tail)).unwrap();
    assert_eq!(opened.done, Some(Done::Run { job: 4 }));
    assert_eq!(raw, tail);
    assert!(open_answer(&rand::random(), &sealed).is_none());
}

#[test]
fn a_sessions_agent_device_runs_on_the_mac_while_it_holds_a_simulator() {
    assert_eq!(
        client::forwarder("/n/bin/fleetd"),
        "#!/bin/sh\n# fleetd's: agent-device commands for your iOS simulator on the agents' Mac (mac sim).\nexec '/n/bin/fleetd' mac agent-device \"$@\"\n"
    );
    let dir = tempfile::tempdir().unwrap();
    client::install_forwarder(dir.path(), "s1", "/n/bin/fleetd").unwrap();
    let bin = crate::node::device::remote::bin_dir(dir.path(), "s1").join("agent-device");
    assert!(bin.is_file());
    crate::node::device::remote::remove_forwarder(dir.path(), "s1");
    assert!(!bin.exists());
}

#[test]
fn mac_on_the_path_runs_fleetd_mac() {
    assert_eq!(
        client::shim("/n/bin/fleetd"),
        "#!/bin/sh\n# fleetd's: the agents' Mac, for this session (fleetd mac --help).\nexec '/n/bin/fleetd' mac \"$@\"\n"
    );
}

#[test]
fn a_pull_never_replaces_the_worktree_or_deletes_a_folder_there() {
    let dir = tempfile::tempdir().unwrap();
    let wt = dir.path().join("wt");
    std::fs::create_dir_all(wt.join(".git")).unwrap();
    std::fs::create_dir_all(wt.join("out")).unwrap();
    std::fs::write(wt.join("out/kept.txt"), "kept").unwrap();
    // The worktree itself is a folder to pull into, never what's replaced.
    for to in [".", "./", ""] {
        assert_eq!(
            client::destination(&wt, "shot.png", Some(to)).unwrap(),
            wt.join("shot.png"),
            "{to:?}"
        );
    }
    assert!(client::destination(&wt, "shot.png", Some("out/..")).is_err());
    assert!(client::destination(&wt, "HEAD", Some(".git/HEAD")).is_err());
    assert!(client::destination(&wt, ".git", None).is_err());
    // Into an existing folder, as cp puts it.
    let into = client::destination(&wt, "shots/shot.png", Some("out")).unwrap();
    assert_eq!(into, wt.join("out/shot.png"));
    let part = dir.path().join("part");
    std::fs::write(&part, "png").unwrap();
    client::place(&part, &into, false).unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("out/kept.txt")).unwrap(),
        "kept"
    );
    assert_eq!(
        std::fs::read_to_string(wt.join("out/shot.png")).unwrap(),
        "png"
    );
    // A file never takes a folder's place.
    std::fs::write(&part, "png").unwrap();
    assert!(client::place(&part, &wt.join("out"), false).is_err());
    assert!(wt.join("out/kept.txt").exists());
    // A folder pulled over one of its name merges into it: what's there and wasn't pulled stays.
    let src = dir.path().join("src/out");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("sub/new.txt"), "new").unwrap();
    std::fs::write(src.join("kept.txt"), "pulled").unwrap();
    let tgz = dir.path().join("out.tgz");
    let packed = std::process::Command::new("tar")
        .arg("-czf")
        .arg(&tgz)
        .arg("-C")
        .arg(dir.path().join("src"))
        .arg("out")
        .status()
        .unwrap();
    assert!(packed.success());
    client::place(&tgz, &wt.join("out"), true).unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("out/kept.txt")).unwrap(),
        "pulled"
    );
    assert_eq!(
        std::fs::read_to_string(wt.join("out/sub/new.txt")).unwrap(),
        "new"
    );
    assert_eq!(
        std::fs::read_to_string(wt.join("out/shot.png")).unwrap(),
        "png"
    );
    assert!(wt.join(".git").is_dir());
}

type Logged = std::sync::Arc<std::sync::Mutex<Vec<fleetd_contracts::sessions::ThreadItem>>>;

/// A client whose action log lands in the returned list, reaching no hub.
fn client_logging(dir: &Path) -> (client::Client, Logged) {
    let logged: Logged = Default::default();
    let log = logged.clone();
    let wt = dir.join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    let client = client::Client::new(
        crate::node::lead::LeadRelay::new(),
        std::sync::Arc::new(move |_: &str| Some(wt.clone())),
        std::sync::Arc::new(|_: &str| Ok(crate::node::mask::Masker::default())),
        std::sync::Arc::new(move |_: &str, item| log.lock().unwrap().push(item)),
        dir.to_path_buf(),
    );
    (client, logged)
}

#[tokio::test(start_paused = true)]
async fn a_foreground_runs_line_closes_when_nobody_follows_it_and_keeps_its_start() {
    use fleetd_contracts::sessions::ItemStatus;
    let dir = tempfile::tempdir().unwrap();
    let (client, logged) = client_logging(dir.path());
    client.log_run("s1", 1, "xcodebuild test", false);
    client.log_run("s1", 2, "npx expo start", true);
    {
        let items = logged.lock().unwrap();
        assert_eq!(items[0].status, ItemStatus::Running);
        assert_eq!(
            items[1].status,
            ItemStatus::Completed,
            "--bg is done once started"
        );
    }
    // Its CLI stopped: no logs step follows it, and the Mac can't be asked (no hub here), so it ends cancelled.
    tokio::time::sleep(client::UNFOLLOWED + 2 * client::RUN_CHECK).await;
    let items = logged.lock().unwrap();
    let closed = items.last().unwrap();
    assert_eq!(closed.id, items[0].id);
    assert_eq!(closed.status, ItemStatus::Cancelled);
    assert_eq!(
        closed.started_at, items[0].started_at,
        "its start is when it started"
    );
    assert!(closed.completed_at.is_some());
}

/// What the stand-in hub does with one `mac_send`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fault {
    /// The Mac does the step and its answer is lost on the way back.
    LoseAnswer,
    /// The step never reaches the Mac: the link is down.
    Unreachable,
}

/// The steps the stand-in hub passed on: each as the Mac read it, with the bytes after it.
type Passed = std::sync::Arc<std::sync::Mutex<Vec<(Step, usize)>>>;

/// A client for session `s1` and worktree `wt`, linked to a stand-in hub in front of `host`: the `n`th `mac_send`
/// (from 0) meets `faults`' fault for `n`, if any.
fn linked(
    dir: &Path,
    host: std::sync::Arc<Host>,
    mac_key: [u8; 32],
    wt: &Path,
    faults: Vec<(usize, Fault)>,
) -> (client::Client, Passed) {
    use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, LeadResultFrame};
    use fleetd_contracts::mac::{MacSendResult, MacWhereResult};
    use fleetd_contracts::mcp::{ErrorCode, McpToolError};
    use fleetd_contracts::node_link::NodeToHub;
    let relay = crate::node::lead::LeadRelay::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let attached = relay.attach(tx);
    let passed: Passed = Default::default();
    let (hub_relay, seen) = (relay.clone(), passed.clone());
    // The Mac's own key opens each step for the record.
    let opener = load_or_create_box_key(&dir.join("node")).unwrap();
    tokio::spawn(async move {
        let _attached = attached;
        let mut sends = 0;
        while let Some(line) = rx.recv().await {
            let Ok(NodeToHub::LeadCall(frame)) = serde_json::from_str::<NodeToHub>(&line) else {
                continue;
            };
            let offline = || {
                Some(McpToolError::new(
                    ErrorCode::MachineOffline,
                    "the link to the fleetd hub dropped before it answered",
                ))
            };
            let (result, error) = match frame.call {
                LeadCall::MacWhere(_) => (
                    Some(LeadCallResult::MacWhere(MacWhereResult {
                        machine_id: MachineId::unchecked("mac1"),
                        box_pub_key: serde_json::from_value(serde_json::json!(B64.encode(mac_key)))
                            .unwrap(),
                    })),
                    None,
                ),
                LeadCall::MacSend(call) => {
                    let fault = faults.iter().find(|(n, _)| *n == sends).map(|(_, f)| *f);
                    sends += 1;
                    if fault == Some(Fault::Unreachable) {
                        (None, offline())
                    } else {
                        let plain = opener
                            .open(&B64.decode(call.sealed.as_str()).unwrap())
                            .unwrap();
                        let (envelope, raw) = split_raw::<Envelope>(&plain).unwrap();
                        seen.lock().unwrap().push((envelope.step, raw.len()));
                        let answer = host
                            .answer(MacCallFrame {
                                id: NonEmpty::unchecked("1"),
                                caller: caller(call.thread_id.as_str()),
                                sealed: call.sealed,
                            })
                            .await;
                        match (fault, answer.sealed) {
                            (Some(Fault::LoseAnswer), _) => (None, offline()),
                            (_, Some(sealed)) => (
                                Some(LeadCallResult::MacSend(MacSendResult { sealed })),
                                None,
                            ),
                            (_, None) => (None, answer.error),
                        }
                    }
                }
                _ => continue,
            };
            hub_relay.resolve(LeadResultFrame {
                id: frame.id,
                result,
                error,
            });
        }
    });
    let wt = wt.to_path_buf();
    let client = client::Client::new(
        relay,
        std::sync::Arc::new(move |_: &str| Some(wt.clone())),
        std::sync::Arc::new(|_: &str| Ok(crate::node::mask::Masker::default())),
        std::sync::Arc::new(|_: &str, _| {}),
        dir.join("home"),
    );
    (client, passed)
}

fn random_bytes(n: usize) -> Vec<u8> {
    (0..n).map(|_| rand::random::<u8>()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_push_cut_mid_way_goes_on_from_its_piece_and_sends_pieces_raw() {
    let dir = tempfile::tempdir().unwrap();
    let (host, key) = mac(dir.path());
    let wt = dir.path().join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    git(&wt, &["init", "-q"]);
    // Three pieces' worth, random so it doesn't pack small.
    let big = random_bytes(PIECE * 2 + 1000);
    std::fs::write(wt.join("big.bin"), &big).unwrap();
    // Steps: have 0, put 1 (answer lost), put 1 again 2, put 3 (unreachable), put 3 again 4, put 5, checkout 6 (answer
    // lost), checkout again 7.
    let faults = vec![
        (1, Fault::LoseAnswer),
        (3, Fault::Unreachable),
        (6, Fault::LoseAnswer),
    ];
    let (client, passed) = linked(dir.path(), std::sync::Arc::new(host), key, &wt, faults);
    let done = client
        .call("s1", fleetd_contracts::mac::MacCall::Push)
        .await
        .unwrap();
    let fleetd_contracts::mac::MacDone::Push { folder, sent_bytes } = done else {
        panic!("{done:?}")
    };
    assert_eq!(
        std::fs::read(Path::new(&folder).join("big.bin")).unwrap(),
        big
    );
    let passed = passed.lock().unwrap().clone();
    let puts: Vec<(u64, usize)> = passed
        .iter()
        .filter_map(|(step, raw)| match step {
            Step::Put {
                offset, data_b64, ..
            } => {
                assert!(data_b64.is_empty(), "the piece goes raw, not in base64");
                Some((*offset, *raw))
            }
            _ => None,
        })
        .collect();
    // The piece whose answer was lost went again from its own offset, never from the start.
    let p = PIECE as u64;
    assert_eq!(
        puts.iter().map(|(o, _)| *o).collect::<Vec<_>>(),
        [0, 0, p, 2 * p]
    );
    assert_eq!(
        sent_bytes,
        puts[1..].iter().map(|(_, n)| *n as u64).sum::<u64>()
    );
    let checkouts = passed
        .iter()
        .filter(|(s, _)| matches!(s, Step::Checkout { .. }))
        .count();
    assert_eq!(checkouts, 2, "a checkout whose answer was lost goes again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pull_cut_mid_way_goes_on_from_its_piece_and_a_folders_lost_last_piece_starts_it_again() {
    let dir = tempfile::tempdir().unwrap();
    let (host, key) = mac(dir.path());
    let agent = host.agent(&caller("s1")).unwrap();
    std::fs::create_dir_all(agent.repo().join("out")).unwrap();
    let big = random_bytes(PIECE * 2 + 1000);
    std::fs::write(agent.repo().join("big.bin"), &big).unwrap();
    std::fs::write(agent.repo().join("out/a.bin"), &big).unwrap();
    std::fs::write(agent.repo().join("out/b.txt"), "b").unwrap();
    let wt = dir.path().join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    // The file: get 0, get 1 (answer lost), get 1 again 2, get 3 (unreachable), get 3 again 4. The folder: get 5, 6,
    // get 7 (its last, answer lost), get 7 again 8 (the tar.gz is gone), then from the start: 9, 10, 11.
    let faults = vec![
        (1, Fault::LoseAnswer),
        (3, Fault::Unreachable),
        (7, Fault::LoseAnswer),
    ];
    let (client, passed) = linked(dir.path(), std::sync::Arc::new(host), key, &wt, faults);
    let pull = |path: &str| fleetd_contracts::mac::MacCall::Pull {
        path: path.into(),
        to: None,
    };
    let done = client.call("s1", pull("big.bin")).await.unwrap();
    assert_eq!(
        done,
        fleetd_contracts::mac::MacDone::Pull {
            path: wt.join("big.bin").to_string_lossy().into_owned(),
            bytes: big.len() as u64,
        }
    );
    assert_eq!(std::fs::read(wt.join("big.bin")).unwrap(), big);
    client.call("s1", pull("out")).await.unwrap();
    assert_eq!(std::fs::read(wt.join("out/a.bin")).unwrap(), big);
    assert_eq!(std::fs::read_to_string(wt.join("out/b.txt")).unwrap(), "b");
    let p = PIECE as u64;
    let offsets: Vec<u64> = passed
        .lock()
        .unwrap()
        .iter()
        .map(|(step, _)| match step {
            Step::Get { offset, raw, .. } => {
                assert!(raw, "asks for raw pieces");
                *offset
            }
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(offsets, [0, p, p, 2 * p, 0, p, 2 * p, 2 * p, 0, p, 2 * p]);
}

#[tokio::test]
async fn an_older_node_and_an_older_mac_still_push_and_pull_in_base64() {
    let dir = tempfile::tempdir().unwrap();
    let (host, key) = mac(dir.path());
    let agent = host.agent(&caller("s1")).unwrap();
    // An older node's put: base64, nothing after the step.
    let piece = random_bytes(1000);
    let put = Step::Put {
        name: "push.pack".into(),
        offset: 0,
        data_b64: B64.encode(&piece),
    };
    let (sealed, answer_key) = sealed(&key, "s1", now_ms(), "n1", put);
    let answer = host.answer(frame("s1", sealed)).await;
    // ...opens as it always did: the JSON alone.
    let plain = {
        use crypto_secretbox::KeyInit;
        use crypto_secretbox::aead::Aead;
        crypto_secretbox::XSalsa20Poly1305::new(crypto_secretbox::Key::from_slice(&answer_key))
            .decrypt(
                &crypto_secretbox::Nonce::default(),
                B64.decode(answer.sealed.unwrap().as_str())
                    .unwrap()
                    .as_slice(),
            )
            .unwrap()
    };
    let old: Answer = serde_json::from_slice(&plain).unwrap();
    assert_eq!(old.done, Some(Done::Put { bytes: 1000 }));
    assert_eq!(
        std::fs::read(agent.dir.join("in/push.pack")).unwrap(),
        piece
    );
    // An older node's get has no `raw`: the piece comes in base64, with nothing after the answer.
    std::fs::create_dir_all(agent.repo()).unwrap();
    std::fs::write(agent.repo().join("f.txt"), "file").unwrap();
    let get: Step = serde_json::from_value(serde_json::json!({
        "step": "get", "path": "f.txt", "offset": 0
    }))
    .unwrap();
    let (done, raw) = host.step_with(&agent, get, Vec::new()).await.unwrap();
    assert!(raw.is_empty());
    assert!(matches!(done, Done::Get { data_b64, .. } if data_b64 == B64.encode("file")));
    // An older Mac's have says nothing of `raw`: the new node sends base64 then.
    let have: Done =
        serde_json::from_value(serde_json::json!({ "step": "have", "snapshots": [] })).unwrap();
    assert_eq!(
        have,
        Done::Have {
            snapshots: vec![],
            raw: false
        }
    );
    // An older Mac reads the new get, `raw` and all, and answers in base64 (which the node takes).
    #[derive(serde::Deserialize)]
    #[serde(tag = "step", rename_all = "snake_case")]
    enum OlderStep {
        Get { path: String, offset: u64 },
    }
    let new = serde_json::to_value(Step::Get {
        path: "f.txt".into(),
        offset: 7,
        raw: true,
    })
    .unwrap();
    let OlderStep::Get { path, offset } = serde_json::from_value(new).unwrap();
    assert_eq!((path.as_str(), offset), ("f.txt", 7));
}
