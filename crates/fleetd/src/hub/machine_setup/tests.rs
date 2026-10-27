//! The machine tools over a fake SSH runner and a temp hub home: the CLI's own `machine add` and `remove` run, and
//! only the machine on the other end is pretend.
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::SetupPorts;
use crate::cli::setup::detect::Peer;
use crate::cli::setup::machine::Runner;
use crate::cli::setup::machine_plan::local_target;
use crate::cli::setup::ssh::{RunResult, SshTarget};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;
use crate::update::BoxFuture;

const AT: &str = "2026-10-26T10:00:00.000Z";
const NOW_MS: u64 = 1_792_000_000_000;
const FLEETD: &[u8] = b"#!/bin/sh\necho fake fleetd\n";

/// What ran: the host, the command and its stdin.
type Ran = (String, String, Option<Vec<u8>>);

/// A machine at the other end of ssh: it answers the probe as a fresh one of the hub's own OS and CPU, remembers what
/// was installed, and fails the step whose command contains `fail`. Its node links up after a (re)start.
struct FakeMachine {
    hub: Mutex<Weak<Hub>>,
    ran: Mutex<Vec<Ran>>,
    fail: Mutex<Option<String>>,
    installed: Mutex<bool>,
    logged_in: bool,
}

impl FakeMachine {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            hub: Mutex::default(),
            ran: Mutex::default(),
            fail: Mutex::default(),
            installed: Mutex::new(false),
            logged_in: true,
        })
    }

    fn commands(&self) -> Vec<String> {
        self.ran
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.1.clone())
            .collect()
    }

    fn probe(&self) -> String {
        let (os, arch) = local_target();
        let os = if os == "darwin" { "Darwin" } else { "Linux" };
        let arch = if arch == "arm64" { "arm64" } else { "x86_64" };
        let mut out = format!(
            "home /home/ada\nconfig /home/ada/.config\nuser ada\nuid 1000\nos {os}\narch {arch}\npath /usr/bin:/bin\n\
             claude /home/ada/.local/bin/claude\nclaude_version {} (Claude Code)\nlinger yes\n",
            crate::node::runner::claude::version::TESTED
        );
        if *self.installed.lock().unwrap() {
            out += &format!(
                "digest /home/ada/.fleetd/bin/fleetd {:x}\n",
                Sha256::digest(FLEETD)
            );
        }
        out
    }

    /// The node links a moment after its service (re)starts, as a real one does.
    fn link_soon(&self, machine: String) {
        let Some(hub) = self.hub.lock().unwrap().upgrade() else {
            return;
        };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let now = crate::hub::store::iso_ms(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64,
            );
            let m = serde_json::from_value(json!({
                "machineId": machine, "name": machine, "tags": [], "status": "online", "lastSeenAt": now,
                "nodeVersion": "0.1.0",
            }))
            .unwrap();
            hub.store.machine_upsert(&m, None).unwrap();
        });
    }
}

impl Runner for FakeMachine {
    fn run<'a>(
        &'a self,
        target: &'a SshTarget,
        command: &'a str,
        stdin: Option<&'a [u8]>,
    ) -> BoxFuture<'a, RunResult> {
        Box::pin(async move {
            self.ran.lock().unwrap().push((
                target.host.clone(),
                command.to_owned(),
                stdin.map(<[u8]>::to_vec),
            ));
            let ok = |stdout: String| RunResult {
                code: 0,
                stdout,
                stderr: String::new(),
            };
            if let Some(fail) = self.fail.lock().unwrap().as_deref()
                && command.contains(fail)
            {
                return RunResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: "mkdir: cannot create directory: Permission denied".into(),
                };
            }
            if command.contains(r#"echo "home $H""#) {
                return ok(self.probe());
            }
            if command.contains("auth status --json") {
                return ok(json!({ "loggedIn": self.logged_in }).to_string());
            }
            if command.contains("fleetd.fleetd-tmp") && stdin.is_some_and(|b| b == FLEETD) {
                *self.installed.lock().unwrap() = true;
            }
            if command.contains(" restart ") || command.contains("kickstart") {
                self.link_soon(machine_of(&target.host));
            }
            if command.contains("'join'") || command.contains(" join ") {
                return ok("enrolled".into());
            }
            ok(String::new())
        })
    }
}

fn machine_of(host: &str) -> String {
    crate::cli::setup::machine::machine_id_from_host(host)
}

struct Ports {
    machine: Arc<FakeMachine>,
    exe: PathBuf,
}

impl SetupPorts for Ports {
    fn runner(&self) -> Arc<dyn Runner> {
        self.machine.clone()
    }
    fn exe(&self) -> Result<PathBuf, String> {
        Ok(self.exe.clone())
    }
    fn hosts(&self) -> BoxFuture<'_, (Vec<String>, Vec<Peer>)> {
        Box::pin(async {
            (
                vec!["builder-1".into(), "lab".into()],
                vec![
                    Peer {
                        name: "mac-mini".into(),
                        dns_name: "mac-mini.tail1234.ts.net".into(),
                    },
                    Peer {
                        name: "lab".into(),
                        dns_name: "lab.tail1234.ts.net".into(),
                    },
                ],
            )
        })
    }
}

/// A hub in a temp home that `fleetd init` set up, with a fake machine behind ssh.
fn hub() -> (Arc<Hub>, Arc<FakeMachine>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("setup.json"),
        json!({
            "listen": "127.0.0.1:4790", "url": "http://devbox.example.ts.net:4790", "unitSuffix": "",
            "gitIdentity": { "name": "ada-lovelace", "email": "1+ada-lovelace@users.noreply.github.com" },
            "machines": {},
        })
        .to_string(),
    )
    .unwrap();
    let exe = home.path().join("fleetd");
    std::fs::write(&exe, FLEETD).unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(NOW_MS),
    )
    .unwrap();
    let machine = FakeMachine::new();
    *machine.hub.lock().unwrap() = Arc::downgrade(&hub);
    hub.machine_setup.set_ports(Arc::new(Ports {
        machine: machine.clone(),
        exe,
    }));
    (hub, machine, home)
}

fn person(role: &str) -> Caller {
    let c: Caller = serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": role, "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(KeyKind::Human),
        ..c
    }
}

async fn call_as(
    hub: &Arc<Hub>,
    caller: &Caller,
    name: &str,
    input: Value,
) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(hub, caller, name, input)
        .await
}

async fn call(hub: &Arc<Hub>, name: &str, input: Value) -> Value {
    match call_as(hub, &person("admin"), name, input).await {
        Ok(v) => v,
        Err(CallError::Tool(e)) => panic!("{name}: {e:?}"),
        Err(e) => panic!("{name}: {e:?}"),
    }
}

/// Follows machine_add_status until the run ends.
async fn finished(hub: &Arc<Hub>, run_id: &str) -> Value {
    for _ in 0..100 {
        let status = call(hub, "machine_add_status", json!({ "runId": run_id })).await;
        let run = status["runs"][0].clone();
        if run["state"] != "running" {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the run never ended");
}

fn titles(steps: &Value) -> Vec<(String, String)> {
    steps
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["title"].as_str().unwrap().to_owned(),
                s["state"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn setup_json(home: &tempfile::TempDir) -> Value {
    serde_json::from_str(&std::fs::read_to_string(home.path().join("setup.json")).unwrap()).unwrap()
}

#[tokio::test]
async fn the_plan_reads_the_machine_and_changes_nothing() {
    let (hub, machine, home) = hub();
    let plan = call(&hub, "machine_add_plan", json!({ "host": "builder-1" })).await;
    assert_eq!(plan["machineId"], "builder-1");
    assert_eq!(plan["joined"], false);
    let (os, arch) = local_target();
    assert_eq!(plan["platform"], format!("{os}-{arch}"));
    let steps = titles(&plan["steps"]);
    assert_eq!(steps[0].0, "create fleetd's directories");
    assert!(
        steps.iter().all(|(_, state)| state == "planned"),
        "{steps:?}"
    );
    assert_eq!(
        steps.last().unwrap().0,
        "waiting until builder-1 is online (up to 2 min)"
    );
    assert!(
        steps
            .iter()
            .any(|(t, _)| t == "enroll the node with a one-time token (sent on stdin)")
    );
    // Only the read-only probe ran; nothing recorded, nothing enrolled.
    assert_eq!(machine.commands().len(), 1);
    assert_eq!(setup_json(&home)["machines"], json!({}));
}

#[tokio::test]
async fn adds_a_machine_step_by_step_with_events() {
    let (hub, machine, home) = hub();
    let out = call(&hub, "machine_add", json!({ "host": "builder-1" })).await;
    assert_eq!(out["run"]["state"], "running");
    let run_id = out["run"]["runId"].as_str().unwrap().to_owned();
    let run = finished(&hub, &run_id).await;
    assert_eq!(run["state"], "done", "{run:#}");
    assert_eq!(run["loggedIn"], true);
    let steps = titles(&run["steps"]);
    assert_eq!(steps[0].0, "read the machine's state (read-only)");
    assert!(steps.iter().all(|(_, state)| state == "done"), "{steps:?}");
    assert_eq!(
        steps.last().unwrap().0,
        "waiting until builder-1 is online (up to 2 min)"
    );

    // The one-time token went to the enroll step's stdin, and nowhere into the run.
    let ran = machine.ran.lock().unwrap().clone();
    let token = ran
        .iter()
        .find(|r| r.1.contains("'--token-file'") || r.1.contains("--token-file"))
        .and_then(|r| r.2.clone())
        .map(|b| String::from_utf8(b).unwrap())
        .unwrap();
    assert!(token.starts_with("fle_"), "{token}");
    assert!(!run.to_string().contains(token.trim()));
    assert!(ran.iter().all(|r| r.0 == "builder-1"));

    // Recorded for machine remove, and the hub sees the machine.
    assert_eq!(
        setup_json(&home)["machines"]["builder-1"]["sshHost"],
        "builder-1"
    );
    assert!(
        hub.store
            .machine_get(&MachineId::unchecked("builder-1"))
            .unwrap()
            .is_some()
    );

    // Each step started and ended out loud, for the app to read the run again.
    let events = hub
        .events
        .page(0, Some(&[HubEventType::MachineAddStep]), None)
        .unwrap()
        .events;
    assert!(events.len() >= 2 * steps.len(), "{}", events.len());
    assert!(
        events
            .iter()
            .all(|e| e.data.as_ref().unwrap()["runId"] == run_id.as_str())
    );
    assert_eq!(events.last().unwrap().summary.as_str(), "Added builder-1");
}

#[tokio::test]
async fn a_failed_step_shows_its_output_and_retry_skips_what_is_done() {
    let (hub, machine, _home) = hub();
    *machine.fail.lock().unwrap() = Some("fleetd-node.service.fleetd-tmp".into());
    let out = call(&hub, "machine_add", json!({ "host": "builder-1" })).await;
    let run = finished(&hub, out["run"]["runId"].as_str().unwrap()).await;
    assert_eq!(run["state"], "failed");
    let failed: Vec<_> = run["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["state"] == "failed")
        .collect();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["title"], "write the node service");
    assert_eq!(
        failed[0]["output"],
        "mkdir: cannot create directory: Permission denied"
    );
    assert!(
        run["message"]
            .as_str()
            .unwrap()
            .starts_with("step 3 failed (exit 1)")
    );
    assert!(
        run["fix"]
            .as_str()
            .unwrap()
            .contains("finished steps are skipped")
    );
    // What comes after it never ran.
    assert_eq!(
        titles(&run["steps"]).last().unwrap(),
        &(
            "waiting until builder-1 is online (up to 2 min)".to_owned(),
            "planned".to_owned()
        )
    );

    // Retry: fleetd went on in the first run, so the second doesn't copy it again.
    *machine.fail.lock().unwrap() = None;
    let again = call(&hub, "machine_add", json!({ "host": "builder-1" })).await;
    let run = finished(&hub, again["run"]["runId"].as_str().unwrap()).await;
    assert_eq!(run["state"], "done", "{run:#}");
    assert!(
        titles(&run["steps"])
            .iter()
            .all(|(t, _)| !t.starts_with("install fleetd"))
    );
    let all = call(&hub, "machine_add_status", json!({})).await;
    assert_eq!(all["runs"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn a_machine_whose_read_fails_says_how_to_reach_it() {
    let (hub, machine, _home) = hub();
    *machine.fail.lock().unwrap() = Some(r#"echo "home $H""#.into());
    let Err(CallError::Tool(e)) = call_as(
        &hub,
        &person("admin"),
        "machine_add_plan",
        json!({ "host": "builder-1" }),
    )
    .await
    else {
        panic!("planned a machine it can't read");
    };
    assert_eq!(e.code, ErrorCode::Failed);
    assert!(
        e.message.starts_with("cannot read builder-1 over SSH"),
        "{}",
        e.message
    );
    assert!(e.fix.unwrap().contains("ssh-copy-id builder-1"));
}

#[tokio::test]
async fn only_an_admins_device_adds_or_removes() {
    let (hub, machine, _home) = hub();
    let agent: Caller = serde_json::from_value(json!({
        "keyId": "k2", "name": "lead", "prefix": "fld_ghijkl", "createdAt": AT,
        "grants": [{ "role": "admin", "machines": "*" }],
    }))
    .unwrap();
    for (caller, tool) in [
        (&person("operate"), "machine_add"),
        (&agent, "machine_add"),
        (&agent, "machine_remove"),
        (&agent, "machine_join"),
    ] {
        let input = json!({ "host": "builder-1", "machineId": "builder-1" });
        let input = if tool == "machine_add" {
            json!({ "host": "builder-1" })
        } else {
            json!({ "machineId": input["machineId"] })
        };
        match call_as(&hub, caller, tool, input).await {
            Err(CallError::Tool(e)) => assert_eq!(e.code, ErrorCode::Forbidden),
            other => panic!("{tool}: {other:?}"),
        }
    }
    assert!(machine.commands().is_empty());
    // Never an ssh option for a host.
    assert!(matches!(
        call_as(
            &hub,
            &person("admin"),
            "machine_add",
            json!({ "host": "-oProxyCommand=sh" })
        )
        .await,
        Err(CallError::Invalid(_))
    ));
    assert!(matches!(
        call_as(
            &hub,
            &person("admin"),
            "machine_add",
            json!({ "host": "lab", "local": true })
        )
        .await,
        Err(CallError::Invalid(_))
    ));
}

#[tokio::test]
async fn hosts_list_this_machine_ssh_config_and_the_tailnet_once_each() {
    let (hub, _machine, _home) = hub();
    let m = serde_json::from_value(json!({
        "machineId": "mac-mini", "name": "mac-mini", "tags": [], "status": "offline", "lastSeenAt": AT,
        "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&m, None).unwrap();
    let out = call(&hub, "machine_hosts", json!({})).await;
    let hosts = out["hosts"].as_array().unwrap();
    assert_eq!(hosts[0]["source"], "hub");
    assert!(hosts[0].get("host").is_none());
    let rest: Vec<_> = hosts[1..]
        .iter()
        .map(|h| {
            (
                h["machineId"].as_str().unwrap(),
                h["host"].as_str().unwrap(),
                h["source"].as_str().unwrap(),
                h["joined"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rest,
        [
            ("builder-1", "builder-1", "ssh_config", false),
            ("lab", "lab", "ssh_config", false),
            ("mac-mini", "mac-mini.tail1234.ts.net", "tailnet", true),
        ]
    );
}

#[tokio::test]
async fn removes_a_machine_it_set_up() {
    let (hub, machine, home) = hub();
    let out = call(&hub, "machine_add", json!({ "host": "builder-1" })).await;
    finished(&hub, out["run"]["runId"].as_str().unwrap()).await;
    let before = machine.commands().len();
    let removed = call(&hub, "machine_remove", json!({ "machineId": "builder-1" })).await;
    let steps = titles(&removed["steps"]);
    assert_eq!(
        steps[0],
        ("stop and remove the node service".into(), "done".into())
    );
    assert!(steps.iter().all(|(_, s)| s == "done"));
    assert!(machine.commands().len() > before);
    assert_eq!(setup_json(&home)["machines"], json!({}));
    assert!(
        hub.store
            .machine_get(&MachineId::unchecked("builder-1"))
            .unwrap()
            .is_none()
    );

    // One that joined by itself: only its key goes.
    let joined = call(&hub, "machine_remove", json!({ "machineId": "laptop" })).await;
    assert_eq!(joined["steps"], json!([]));
    assert!(
        joined["next"]
            .as_str()
            .unwrap()
            .contains("stop its node by hand")
    );
}

#[tokio::test]
async fn a_join_code_comes_with_the_line_to_paste() {
    let (hub, _machine, _home) = hub();
    let out = call(&hub, "machine_join", json!({ "machineId": "laptop" })).await;
    let code = out["code"].as_str().unwrap();
    assert!(code.starts_with("fle_"));
    let line = out["line"].as_str().unwrap();
    assert!(
        line.starts_with("curl -fsSL https://fleetd.sh | sh -s -- --join "),
        "{line}"
    );
    assert!(
        line.contains(code) && line.contains("--machine-id laptop"),
        "{line}"
    );
    assert_eq!(
        out["gitIdentity"],
        "ada-lovelace <1+ada-lovelace@users.noreply.github.com>"
    );
    assert_eq!(out["hubUrl"], "http://devbox.example.ts.net:4790");
}
