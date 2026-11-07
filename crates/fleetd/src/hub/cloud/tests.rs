//! Cloud machines over a real hub with fake nodes: the hub's Claude configuration sealed to a cloud machine at its
//! enroll by a machine holding it and re-sealed after a change it slept through, forgets it missed replayed at its
//! hello while a fixed machine's are not kept, the catch-up marking it ready, its heartbeat's `busy`, and the setup
//! script's values.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use fleetd_contracts::claude_accounts::ClaudeAccount;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::{
    CAP_CLAUDE_ACCOUNTS, CAP_CLAUDE_RESEAL, HubToNode, NodeBusy, NodeToHub,
};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};

use super::claude::{self, Brought};
use super::outbox::Missed;
use super::setup::{SetupScript, render};
use crate::hub::api::Hub;
use crate::hub::claude_accounts::tests::{call, device, hub, owner, sealed};

const AT: &str = "2026-10-27T10:00:00.000Z";
const OLD: &str = "5ec2e7a1";
const NEW: &str = "0b5e55ed";

fn m(id: &str) -> MachineId {
    MachineId::unchecked(id)
}

/// A box key for a machine row, as a node's hello gives it.
fn box_key() -> String {
    use base64::Engine;
    let secret = crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng);
    base64::engine::general_purpose::STANDARD.encode(secret.public_key().as_bytes())
}

fn machine(hub: &Hub, id: &str, key: &str) {
    let machine = serde_json::from_value(json!({
        "machineId": id, "name": id, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
        "boxPubKey": key,
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
}

/// boat-1 enrolled with a pool token: a cloud machine.
fn enroll_pool(hub: &Hub, id: &str) {
    let token = hub.auth.create_pool_enroll_token(&m(id)).unwrap().token;
    hub.auth
        .enroll_node(
            &token,
            &m(id),
            &format!("pub-{id}"),
            Some(&format!("fp-{id}")),
        )
        .unwrap();
}

/// What one fake node holds of the hub's account, by fingerprint, and the calls it got.
#[derive(Clone, Default)]
struct Fake {
    holds: Arc<Mutex<Option<&'static str>>>,
    calls: Arc<Mutex<Vec<SessionCall>>>,
}

impl Fake {
    fn calls(&self) -> Vec<SessionCall> {
        std::mem::take(&mut self.calls.lock().unwrap())
    }
}

/// The fingerprint a box sealed now opens to: what the machines holding the account hold.
type Current = Arc<Mutex<&'static str>>;

/// Links `id`'s node, answering Claude account calls as a node would from what `fake` holds.
async fn link(hub: &Arc<Hub>, id: &str, link_id: u64, fake: &Fake, current: &Current) {
    let machine_id = m(id);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    hub.executors
        .attach(
            &machine_id,
            crate::hub::executor::NodeSessions { link_id, send: tx },
        )
        .await;
    let HubToNode::SessionCall(subscribe) = rx.recv().await.unwrap() else {
        panic!("not a subscribe")
    };
    let frame = |v: Value| {
        hub.executors
            .handle_frame(&machine_id, serde_json::from_value::<NodeToHub>(v).unwrap())
    };
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
        "projects": [], "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&machine_id).await;
    hub.link
        .set_capabilities(&machine_id, &[CAP_CLAUDE_ACCOUNTS, CAP_CLAUDE_RESEAL]);
    let (hub, fake, current) = (hub.clone(), fake.clone(), current.clone());
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let mut holds = fake.holds.lock().unwrap();
            let result = match &f.call {
                SessionCall::ClaudeAccountSecret { set: None, .. } => {
                    *holds = None;
                    json!({ "ok": { "kind": "claude_account_saved" } })
                }
                SessionCall::ClaudeAccountSecret { set: Some(set), .. } => {
                    if set.sealed.is_some() {
                        *holds = Some(*current.lock().unwrap());
                    }
                    match *holds {
                        Some(fp) => {
                            json!({ "ok": { "kind": "claude_account_saved", "fingerprint": fp } })
                        }
                        None => json!({ "err": { "code": "invalid",
                            "message": "this machine holds no the hub's API key: seal it again" } }),
                    }
                }
                SessionCall::ClaudeAccountReseal { .. } => match *holds {
                    Some(_) => {
                        json!({ "ok": { "kind": "claude_account_resealed", "sealed": sealed("sk-ant-api") } })
                    }
                    None => json!({ "ok": { "kind": "claude_account_resealed" } }),
                },
                _ => json!({ "ok": { "kind": "done" } }),
            };
            drop(holds);
            fake.calls.lock().unwrap().push(f.call.clone());
            let reply = json!({ "t": "session_reply", "id": f.id, "result": result });
            hub.executors.handle_frame(
                &machine_id,
                serde_json::from_value::<NodeToHub>(reply).unwrap(),
            );
        }
    });
}

/// The hub's API key, held on devbox, saved through the tools as the app does.
async fn hub_api_on(hub: &Arc<Hub>, machines: &[&str]) -> Value {
    let admin = device(hub, &owner(hub), "admin");
    let seals: Vec<Value> = machines
        .iter()
        .map(|id| json!({ "machineId": id, "sealed": sealed("sk-ant-api") }))
        .collect();
    call(
        hub,
        &admin,
        "claude_hub_api_set",
        json!({ "sealed": seals }),
    )
    .await
    .unwrap()
}

fn held_on(hub: &Hub) -> HashMap<String, String> {
    hub.db
        .claude_accounts()
        .hub_api()
        .unwrap()
        .unwrap()
        .sealed_on
        .into_iter()
        .map(|s| (s.machine_id.to_string(), s.fingerprint.to_string()))
        .collect()
}

#[tokio::test]
async fn a_cloud_machine_gets_the_hubs_claude_at_enroll_with_nobody_pasting_it() {
    let (hub, _home) = hub();
    let current: Current = Arc::new(Mutex::new(OLD));
    let devbox = Fake::default();
    machine(&hub, "devbox", &box_key());
    link(&hub, "devbox", 1, &devbox, &current).await;
    hub_api_on(&hub, &["devbox"]).await;
    devbox.calls();

    // boat-1 joins: a new VM, its own box key, holding nothing.
    let boat_key = box_key();
    machine(&hub, "boat-1", &boat_key);
    enroll_pool(&hub, "boat-1");
    let boat = Fake::default();
    link(&hub, "boat-1", 2, &boat, &current).await;
    assert_eq!(
        claude::bring(&hub, &m("boat-1")).await,
        Ok(Brought::Resealed {
            account: ClaudeAccount::Hub,
            from: m("devbox"),
        })
    );
    // devbox sealed its copy to boat-1's box key, and boat-1 took the box.
    let resealed = devbox.calls();
    assert!(
        matches!(&resealed[..], [SessionCall::ClaudeAccountReseal { account: ClaudeAccount::Hub, to }]
            if to.as_str() == boat_key),
        "{resealed:?}"
    );
    let took = boat.calls();
    assert!(
        matches!(took.last(), Some(SessionCall::ClaudeAccountSecret { set: Some(set), .. }) if set.sealed.is_some()),
        "{took:?}"
    );
    assert_eq!(held_on(&hub)["boat-1"], OLD);
    // Nothing of it is kept on the hub but fingerprints.
    let rows = crate::hub::claude_accounts::tests::every_row(&hub);
    assert!(!rows.contains("sk-ant-api"));

    // At its next wake it holds the current key: one call, nothing resealed.
    assert_eq!(
        claude::bring(&hub, &m("boat-1")).await,
        Ok(Brought::Current(ClaudeAccount::Hub))
    );
    assert!(devbox.calls().is_empty());
    let probed = boat.calls();
    assert!(
        matches!(&probed[..], [SessionCall::ClaudeAccountSecret { set: Some(set), .. }] if set.sealed.is_none()),
        "{probed:?}"
    );
}

#[tokio::test]
async fn a_key_replaced_while_a_cloud_machine_slept_is_resealed_at_its_wake() {
    let (hub, _home) = hub();
    let current: Current = Arc::new(Mutex::new(OLD));
    let devbox = Fake::default();
    machine(&hub, "devbox", &box_key());
    machine(&hub, "boat-1", &box_key());
    enroll_pool(&hub, "boat-1");
    link(&hub, "devbox", 1, &devbox, &current).await;
    let boat = Fake::default();
    link(&hub, "boat-1", 2, &boat, &current).await;
    hub_api_on(&hub, &["devbox", "boat-1"]).await;
    assert_eq!(held_on(&hub).len(), 2);

    // boat-1 goes to sleep; the admin replaces the key, sealed to every machine in the list.
    hub.executors.detach(&m("boat-1")).await;
    *current.lock().unwrap() = NEW;
    let saved = hub_api_on(&hub, &["devbox", "boat-1"]).await;
    assert!(
        saved["next"].as_str().unwrap().contains("boat-1"),
        "{saved}"
    );
    assert_eq!(held_on(&hub).keys().collect::<Vec<_>>(), ["devbox"]);
    // It must forget the old key: kept for its hello.
    assert_eq!(
        hub.db.cloud_outbox().list(&m("boat-1")).unwrap(),
        [(
            1,
            Missed::ClaudeForget {
                account: ClaudeAccount::Hub
            }
        )]
    );

    // It wakes: the catch-up forgets the old key, then the new one is sealed to it from devbox.
    boat.calls();
    link(&hub, "boat-1", 3, &boat, &current).await;
    assert!(
        !hub.cloud.ready(&hub, &m("boat-1")),
        "not before its catch-up"
    );
    let report = super::catch_up::catch_up(&hub, &m("boat-1")).await;
    assert!(report.problems.is_empty(), "{report:?}");
    assert_eq!(report.forgotten, 1);
    assert_eq!(
        report.claude,
        Some(Brought::Resealed {
            account: ClaudeAccount::Hub,
            from: m("devbox"),
        })
    );
    let calls = boat.calls();
    assert!(
        matches!(
            calls.first(),
            Some(SessionCall::ClaudeAccountSecret { set: None, .. })
        ),
        "the forget first: {calls:?}"
    );
    assert_eq!(held_on(&hub)["boat-1"], NEW);
    assert!(hub.db.cloud_outbox().list(&m("boat-1")).unwrap().is_empty());
    assert!(hub.cloud.ready(&hub, &m("boat-1")));
}

#[tokio::test]
async fn only_a_cloud_machine_keeps_what_it_missed() {
    let (hub, _home) = hub();
    let current: Current = Arc::new(Mutex::new(OLD));
    for id in ["devbox", "laptop", "boat-1"] {
        machine(&hub, id, &box_key());
    }
    enroll_pool(&hub, "boat-1");
    let fakes: Vec<Fake> = (0..3).map(|_| Fake::default()).collect();
    for (n, id) in ["devbox", "laptop", "boat-1"].iter().enumerate() {
        link(&hub, id, n as u64 + 1, &fakes[n], &current).await;
    }
    hub_api_on(&hub, &["devbox", "laptop", "boat-1"]).await;
    hub.executors.detach(&m("laptop")).await;
    hub.executors.detach(&m("boat-1")).await;
    let admin = device(&hub, &owner(&hub), "admin");
    call(&hub, &admin, "claude_hub_api_remove", json!({}))
        .await
        .unwrap();
    assert!(hub.db.cloud_outbox().list(&m("laptop")).unwrap().is_empty());
    assert_eq!(hub.db.cloud_outbox().list(&m("boat-1")).unwrap().len(), 1);
    // A fixed machine is always ready; a cloud machine offline never is.
    assert!(hub.cloud.ready(&hub, &m("laptop")));
    assert!(!hub.cloud.ready(&hub, &m("boat-1")));
    // With no hub configuration left, there is nothing to bring.
    link(&hub, "boat-1", 4, &fakes[2], &current).await;
    let report = super::catch_up::catch_up(&hub, &m("boat-1")).await;
    assert_eq!(report.claude, Some(Brought::Nothing));
    assert_eq!(report.forgotten, 1);
    assert!(
        fakes[2].holds.lock().unwrap().is_none(),
        "it forgot the key"
    );
}

#[tokio::test]
async fn the_hub_keeps_each_machines_busy_from_its_heartbeat() {
    let (hub, _home) = hub();
    let lab = m("lab");
    assert_eq!(hub.link.busy(&lab), None);
    let busy = NodeBusy {
        threads: 1,
        screens: 2,
        uploads: 0,
        hosted: 1,
    };
    hub.link.observe_busy(&lab, Some(busy));
    assert_eq!(hub.link.busy(&lab), Some(busy));
    assert!(!busy.idle());
    hub.link.observe_busy(&lab, Some(NodeBusy::default()));
    assert!(hub.link.busy(&lab).unwrap().idle());
    // An older node sends none: nothing is assumed.
    hub.link.observe_busy(&lab, None);
    assert_eq!(hub.link.busy(&lab), None);
    // On the wire, from a node.
    let beat: NodeToHub = serde_json::from_value(json!({ "t": "hb", "at": AT,
        "busy": { "threads": 0, "screens": 0, "uploads": 3, "hosted": 0 } }))
    .unwrap();
    let NodeToHub::Heartbeat(beat) = beat else {
        panic!("not a heartbeat")
    };
    assert_eq!(beat.busy.map(|b| b.uploads), Some(3));
}

#[test]
fn the_setup_script_joins_the_hub_through_its_tunnel_on_its_channel_with_every_value_quoted() {
    let slot = SetupScript {
        hub_url: "http://127.0.0.1:47900".into(),
        machine_id: m("boat-2"),
        version: "0.4.0".into(),
        release_build: true,
        git_identity: Some("Dev Box <dev@example.net>".into()),
        claude: "2.1.314".into(),
    };
    let script = render(&slot);
    for line in [
        "HUB=http://127.0.0.1:47900",
        "MACHINE=boat-2",
        "CHANNEL=stable",
        "BASE_URL=https://github.com/unlaboredlabs/fleetd/releases/download/v0.4.0",
        "IDENTITY='Dev Box <dev@example.net>'",
        "TOKEN_FILE=/tmp/fleetd-enroll-token",
        "AGENT=fleetd",
        "CLAUDE=2.1.314",
    ] {
        assert!(script.lines().any(|l| l == line), "no {line}");
    }
    assert!(!script.contains("=@"), "every placeholder filled");
    // An edge hub: the newest edge build, nothing pinned; no identity is an empty value.
    let edge = render(&SetupScript {
        version: "0.0.0-edge.202611031200+aeb0b7f".into(),
        git_identity: None,
        ..slot
    });
    assert!(edge.lines().any(|l| l == "CHANNEL=edge"));
    assert!(edge.lines().any(|l| l == "BASE_URL=''"));
    assert!(edge.lines().any(|l| l == "IDENTITY=''"));
}

/// A wake boots boat's base image before the VM's disk is attached, so logind misses the agents' linger and the node's
/// user unit never starts (spike): an enabled system unit, which boat starts at every wake, sets it again. Rust goes
/// to the agents' home, not boat's `/usr/local/rustup`, and boat's own Claude stays where it is.
#[test]
fn the_setup_script_lingers_again_at_every_wake_and_keeps_rust_in_the_agents_home() {
    let script = render(&SetupScript {
        hub_url: "http://127.0.0.1:47900".into(),
        machine_id: m("boat-1"),
        version: "0.4.0".into(),
        release_build: true,
        git_identity: None,
        claude: "2.1.314".into(),
    });
    let unit = script
        .split("/etc/systemd/system/fleetd-linger.service >/dev/null <<EOF\n")
        .nth(1)
        .and_then(|rest| rest.split("\nEOF\n").next())
        .expect("the linger unit");
    for line in [
        "After=systemd-logind.service",
        "Type=oneshot",
        "ExecStart=/usr/bin/loginctl enable-linger $AGENT",
        "WantedBy=multi-user.target",
    ] {
        assert!(unit.lines().any(|l| l == line), "no {line} in\n{unit}");
    }
    assert!(
        script
            .lines()
            .any(|l| l == "sudo systemctl enable --now fleetd-linger.service")
    );
    assert!(script.contains("export RUSTUP_HOME=\\$HOME/.rustup CARGO_HOME=\\$HOME/.cargo"));
    assert!(
        script.contains("'Environment=RUSTUP_HOME=%h/.rustup' 'Environment=CARGO_HOME=%h/.cargo'")
    );
    assert!(!script.contains("command -v -a"), "no Claude removal");
    if let Ok(out) = std::process::Command::new("bash")
        .args(["-n", "-c", &script])
        .output()
    {
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

/// A `large` cloud machine (8 vCPUs, 15,991 MiB as measured) runs 3 agents with 2 build jobs each.
#[test]
fn a_large_cloud_machine_runs_three_agents_with_two_build_jobs() {
    use crate::node::load::{agents_fit, build_jobs};
    let agents = agents_fit(
        8,
        Some(15_991 << 20),
        super::setup::MEM_PER_AGENT_GB * 1_000_000_000,
    );
    assert_eq!((agents, build_jobs(8, agents)), (3, 2));
}

/// A hub only its tailnet or LAN reaches makes cloud machines all the same: they join it on their own loopback, which
/// the hub's tunnel forwards to it, and wait for the tunnel first.
#[test]
fn a_private_hub_gives_its_cloud_machines_the_tunnels_address() {
    let (hub, _home) = hub();
    assert!(!hub.config.url().starts_with("https://"));
    let script = super::setup::for_slot(&hub, &m("boat-1")).unwrap();
    assert!(script.lines().any(|l| l == "HUB=http://127.0.0.1:47900"));
    let tunnel = script.find("step \"the hub's tunnel\"").unwrap();
    let join = script.find("step \"fleetd\"").unwrap();
    assert!(tunnel < join, "the tunnel is waited for before the join");
    assert!(script.contains("\"$HUB/healthz\""));
    // sshd drops a silent client, set at every wake by a system unit, so the hub's redial after an unclean drop gets
    // the tunnel's port back.
    let unit = script
        .split("/etc/systemd/system/fleetd-sshd-alive.service >/dev/null <<'EOF'\n")
        .nth(1)
        .and_then(|rest| rest.split("\nEOF\n").next())
        .expect("the sshd unit");
    for line in [
        "Type=oneshot",
        "ExecStart=/bin/sh -c 'f=/etc/ssh/sshd_config.d/00-00-fleetd-client-alive.conf; echo ClientAliveInterval 15 > $$f; echo ClientAliveCountMax 3 >> $$f'",
        "ExecStart=-/usr/bin/systemctl try-reload-or-restart ssh.service",
        "ExecStart=-/usr/bin/pkill -u user -x 'sshd|sshd-session'",
        "WantedBy=multi-user.target",
    ] {
        assert!(unit.lines().any(|l| l == line), "no {line} in\n{unit}");
    }
    let alive = script
        .find("enable --now fleetd-sshd-alive.service")
        .unwrap();
    assert!(alive < join, "set before the join");
}

/// A catch-up whose Claude step failed (the only machine holding the hub's key is offline) leaves the cloud machine not
/// ready, so no work goes there without the hub's Claude configuration; the next catch-up that brings it makes it ready.
#[tokio::test]
async fn a_failed_claude_step_leaves_the_cloud_machine_not_ready() {
    let (hub, _home) = hub();
    let current: Current = Arc::new(Mutex::new(OLD));
    let devbox = Fake::default();
    machine(&hub, "devbox", &box_key());
    machine(&hub, "boat-1", &box_key());
    enroll_pool(&hub, "boat-1");
    link(&hub, "devbox", 1, &devbox, &current).await;
    hub_api_on(&hub, &["devbox"]).await;
    hub.executors.detach(&m("devbox")).await;
    let boat = Fake::default();
    link(&hub, "boat-1", 2, &boat, &current).await;
    let report = super::catch_up::catch_up(&hub, &m("boat-1")).await;
    assert!(!report.ready, "{report:?}");
    assert!(
        report
            .problems
            .iter()
            .any(|p| p.starts_with("Claude not brought")),
        "{report:?}"
    );
    assert!(!hub.cloud.ready(&hub, &m("boat-1")));
    // devbox is back: the next catch-up brings the key, and boat-1 is ready.
    link(&hub, "devbox", 3, &devbox, &current).await;
    let report = super::catch_up::catch_up(&hub, &m("boat-1")).await;
    assert!(report.ready, "{report:?}");
    assert!(hub.cloud.ready(&hub, &m("boat-1")));
}

/// The setup script's own Rust step on an image that ships Rust (boat's does, W468): rustup-init, which refuses to
/// install beside a Rust on the PATH unless `RUSTUP_INIT_SKIP_PATH_CHECK=yes`, installs into the agents' home, and the
/// step's check passes. A stand-in rustup-init with the real one's PATH check; `sudo` and `curl` are fakes.
#[test]
fn the_setup_scripts_rust_step_installs_beside_the_images_own_rust() {
    let script = render(&SetupScript {
        hub_url: "http://127.0.0.1:47900".into(),
        machine_id: m("boat-1"),
        version: "0.4.0".into(),
        release_build: true,
        git_identity: None,
        claude: "2.1.314".into(),
    });
    let between = |from: &str, to: &str| -> String {
        let rest = script.split(from).nth(1).expect(from);
        format!("{from}{}", rest.split(to).next().expect(to))
    };
    let as_agent = between("as_agent() {", "\n}\n") + "\n}\n";
    let rust = between("step \"Rust\"", "step \"the node's environment\"");

    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let image = dir.path().join("image/bin");
    let bin = dir.path().join("bin");
    for d in [&home, &image, &bin] {
        std::fs::create_dir_all(d).unwrap();
    }
    let write = |path: std::path::PathBuf, body: &str| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    // The image's own Rust, on the PATH as boat's /usr/local/cargo/bin is.
    write(image.join("rustc"), "#!/bin/sh\necho rustc 1.80.0\n");
    write(image.join("cargo"), "#!/bin/sh\necho cargo 1.80.0\n");
    // `sudo -u fleetd -H env …`: the agent is the test's own user here.
    write(
        bin.join("sudo"),
        "#!/bin/sh\nwhile [ \"$1\" != env ]; do shift; done\nexec \"$@\"\n",
    );
    // rustup-init as sh.rustup.rs serves it, reduced to its PATH check and what it installs.
    let init = r#"#!/bin/sh
for d in $(echo "$PATH" | tr ':' ' '); do
  if [ -x "$d/rustc" ] && [ "$d" != "$CARGO_HOME/bin" ] && [ "${RUSTUP_INIT_SKIP_PATH_CHECK:-no}" != yes ]; then
    echo "error: cannot install while Rust is installed" >&2
    exit 1
  fi
done
mkdir -p "$CARGO_HOME/bin" "$RUSTUP_HOME"
printf '%s\n' '#!/bin/sh' 'case "$1" in default) exit 0;; show) echo "$RUSTUP_HOME";; esac' > "$CARGO_HOME/bin/rustup"
chmod +x "$CARGO_HOME/bin/rustup"
"#;
    std::fs::write(dir.path().join("rustup-init"), init).unwrap();
    write(
        bin.join("curl"),
        &format!(
            "#!/bin/sh\ncat '{}'\n",
            dir.path().join("rustup-init").display()
        ),
    );

    let harness = format!(
        "set -euo pipefail\nAGENT=fleetd\nAGENT_UID=1000\nstep() {{ :; }}\n{as_agent}\n{rust}\necho rust-step-done\n"
    );
    let Ok(out) = std::process::Command::new("bash")
        .args(["-c", &harness])
        .env_clear()
        .env("HOME", &home)
        .env(
            "PATH",
            format!("{}:{}:/usr/bin:/bin", bin.display(), image.display()),
        )
        .output()
    else {
        return;
    };
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success(), "{said}");
    assert!(said.contains("rust-step-done"), "{said}");
    assert!(home.join(".cargo/bin/rustup").exists(), "{said}");
    assert!(
        image.join("rustc").exists(),
        "the image's own Rust is left as it is"
    );
}
