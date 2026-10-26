//! The hub's update against a fake release feed and fake machines: it starts at once however busy the hub is, a
//! failed download or checksum leaves everything as it was, a hub that doesn't come up healthy is put back and its
//! nodes aren't asked, and each node's own result is said.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{HubChannel, HubUpdateOutput, UpdateRun, UpdateStage, UpdateState};
use fleetd_contracts::node_link::{NodeActionResult, NodeUpdate};
use fleetd_contracts::prim::Text;
use serde_json::json;

use super::{NodeFacts, Timing, UpdatePorts, Updates, by_machine};
use crate::clock::SystemClock;
use crate::update::finish::{Plan, Verdict};
use crate::update::service::Service;
use crate::update::tests::FakeFeed;
use crate::update::{BoxFuture, Channel, Feed};

const OLD: &str = "0.0.0-nightly.202610251000+aaaaaaa";
const NEW: &str = "0.0.0-nightly.202610261056+1b563d7";
const ASSET: &str = "fleetd-linux-x64";

/// How a fake node answers its update.
#[derive(Clone)]
enum Answer {
    /// Staged it, then reconnects on this version (the old one: its watcher put it back).
    BackOn(&'static str),
    Refuses(UpdateStage, &'static str),
}

struct Fake {
    feed: Arc<FakeFeed>,
    running: Mutex<String>,
    exe: PathBuf,
    service: Option<Service>,
    plans: Mutex<Vec<Plan>>,
    nodes: Mutex<Vec<NodeFacts>>,
    answers: HashMap<String, Answer>,
    asked: Mutex<Vec<String>>,
}

impl Fake {
    fn new(dir: &Path, binary: &[u8]) -> Self {
        let exe = dir.join("bin/fleetd");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"old").unwrap();
        Self {
            feed: Arc::new(FakeFeed::with(
                &[(ASSET, binary)],
                &format!(r#"{{"cliVersion":"{NEW}"}}"#),
            )),
            running: Mutex::new(OLD.into()),
            exe,
            service: Some(Service {
                name: "fleetd-hub.service".into(),
                unit: "hub".into(),
            }),
            plans: Mutex::default(),
            nodes: Mutex::default(),
            answers: HashMap::new(),
            asked: Mutex::default(),
        }
    }

    fn node(
        mut self,
        name: &str,
        version: &str,
        online: bool,
        can_update: bool,
        answer: Option<Answer>,
    ) -> Self {
        self.nodes.lock().unwrap().push(NodeFacts {
            machine_id: MachineId::unchecked(name),
            name: name.into(),
            version: version.into(),
            live_since: online.then_some(1),
            can_update,
        });
        if let Some(answer) = answer {
            self.answers.insert(name.into(), answer);
        }
        self
    }
}

impl UpdatePorts for Fake {
    fn feed(&self, _: Channel) -> Arc<dyn Feed> {
        self.feed.clone()
    }
    fn running(&self) -> String {
        self.running.lock().unwrap().clone()
    }
    fn release_build(&self) -> bool {
        true
    }
    fn exe(&self) -> std::io::Result<PathBuf> {
        Ok(self.exe.clone())
    }
    fn asset(&self) -> Result<String, String> {
        Ok(ASSET.into())
    }
    fn hub_service(&self, _: &Path) -> Option<Service> {
        self.service.clone()
    }
    fn previous(&self) -> std::io::Result<Vec<u8>> {
        Ok(b"old".to_vec())
    }
    fn health_url(&self) -> String {
        "http://127.0.0.1:4790".into()
    }
    fn start_watcher(&self, plan: &Plan, _: &Path) -> Result<(), String> {
        self.plans.lock().unwrap().push(plan.clone());
        Ok(())
    }
    fn nodes(&self) -> Vec<NodeFacts> {
        self.nodes.lock().unwrap().clone()
    }
    fn update_node<'a>(
        &'a self,
        machine_id: &'a MachineId,
        _: &'a NodeUpdate,
    ) -> BoxFuture<'a, Result<NodeActionResult, String>> {
        self.asked.lock().unwrap().push(machine_id.to_string());
        let answer = self.answers.get(machine_id.as_str()).cloned();
        let result = match answer {
            Some(Answer::BackOn(version)) => {
                // Its watcher restarts it: a new link, on whatever build came up.
                if let Some(n) = self
                    .nodes
                    .lock()
                    .unwrap()
                    .iter_mut()
                    .find(|n| &n.machine_id == machine_id)
                {
                    n.live_since = Some(i64::MAX / 2);
                    n.version = version.into();
                }
                Ok(result(true, None, "restarting"))
            }
            Some(Answer::Refuses(stage, message)) => Ok(result(false, Some(stage), message)),
            None => Err("the link to its node dropped while the command ran".into()),
        };
        Box::pin(async move { result })
    }
}

fn result(ok: bool, stage: Option<UpdateStage>, message: &str) -> NodeActionResult {
    NodeActionResult {
        id: Text::unchecked("a1".to_owned()),
        ok,
        message: Text::unchecked(message.to_owned()),
        probe: None,
        stage,
    }
}

fn fast() -> Timing {
    Timing {
        poll: Duration::from_millis(5),
        verdict: Duration::from_millis(300),
        node_back: Duration::from_millis(300),
        // Longer than any test: the old process's own deadline never cuts in, but where a test says.
        restart: Duration::from_secs(60),
    }
}

fn area(home: &Path, fake: &Arc<Fake>) -> Arc<Updates> {
    let updates = Updates::new(home, Arc::new(SystemClock), fast());
    updates.set_ports(fake.clone());
    updates
}

/// Waits (for real, briefly) until `done` holds of the run.
async fn until(updates: &Updates, done: impl Fn(&UpdateRun) -> bool) -> UpdateRun {
    for _ in 0..400 {
        if let Some(run) = updates.status().filter(|r| done(r)) {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never got there: {:?}", updates.status());
}

fn state(run: &UpdateRun, machine: Option<&str>) -> (UpdateState, Option<UpdateStage>) {
    let parts = by_machine(run);
    let p = &parts[&machine.map(MachineId::unchecked)];
    (p.state, p.stage)
}

fn hub_state(run: &UpdateRun) -> UpdateState {
    state(run, None).0
}

#[tokio::test]
async fn a_checksum_mismatch_or_a_failed_download_leaves_everything_as_it_was() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node("builder", OLD, true, true, None));
    fake.feed
        .files
        .lock()
        .unwrap()
        .insert(ASSET.into(), b"tampered".to_vec());
    let updates = area(home.path(), &fake);
    updates.start(None).unwrap();
    let run = until(&updates, |r| r.finished_at.is_some()).await;
    assert_eq!(
        state(&run, None),
        (UpdateState::Failed, Some(UpdateStage::Checksum))
    );
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Skipped);
    assert_eq!(
        fs::read(&fake.exe).unwrap(),
        b"old",
        "the hub's binary is untouched"
    );
    assert!(fake.plans.lock().unwrap().is_empty(), "nothing restarts");
    assert!(fake.asked.lock().unwrap().is_empty());

    fake.feed.files.lock().unwrap().remove(ASSET);
    updates.start(None).unwrap();
    let run = until(&updates, |r| {
        r.finished_at.is_some() && state(r, None).1 == Some(UpdateStage::Download)
    })
    .await;
    assert_eq!(hub_state(&run), UpdateState::Failed);
    assert_eq!(fs::read(&fake.exe).unwrap(), b"old");
}

#[tokio::test]
async fn a_hub_that_doesnt_come_up_healthy_is_put_back_and_its_nodes_are_not_asked() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    let updates = area(home.path(), &fake);
    updates.start(Some(HubChannel::Nightly)).unwrap();
    let run = until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert_eq!(run.to.as_ref().map(|t| t.as_str()), Some(NEW));
    assert_eq!(fs::read(&fake.exe).unwrap(), b"new");
    let plan = fake.plans.lock().unwrap()[0].clone();
    assert_eq!((plan.from.as_str(), plan.to.as_str()), (OLD, NEW));
    assert_eq!(
        fs::read(&plan.prev).unwrap(),
        b"old",
        "the running build is kept"
    );

    // The watcher put the old build back; the hub that comes up is the old one, and reads its verdict.
    fs::write(
        &plan.verdict,
        serde_json::to_vec(&Verdict {
            state: UpdateState::RolledBack,
            stage: Some(UpdateStage::Health),
            message: "it didn't come up healthy within 90 s, so the old build was put back and runs again".into(),
        })
        .unwrap(),
    )
    .unwrap();
    let after = area(home.path(), &fake);
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(
        state(&run, None),
        (UpdateState::RolledBack, Some(UpdateStage::Health))
    );
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Skipped);
    assert!(fake.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn after_the_hub_each_node_updates_and_says_how_it_went() {
    let home = tempfile::tempdir().unwrap();
    let fake = Fake::new(home.path(), b"new")
        .node("builder", OLD, true, true, Some(Answer::BackOn(NEW)))
        .node("laptop", OLD, true, true, Some(Answer::BackOn(OLD)))
        .node(
            "mac",
            OLD,
            true,
            true,
            Some(Answer::Refuses(
                UpdateStage::Checksum,
                "checksum mismatch; nothing was changed",
            )),
        )
        .node("nas", OLD, false, true, None)
        .node("old-box", "0.4.0", true, false, None)
        .node("pi", NEW, true, true, None)
        .node("quiet", OLD, true, true, None)
        .node("gone", OLD, true, true, Some(Answer::BackOn(NEW)));
    let fake = Arc::new(fake);
    let updates = area(home.path(), &fake);
    updates.start(None).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;

    // The hub's restart drops every link; the nodes that were online come back a moment after the new hub is up,
    // but for one that stays away. One offline when the run started was skipped then.
    let mut online: Vec<MachineId> = Vec::new();
    for n in fake.nodes.lock().unwrap().iter_mut() {
        if n.live_since.take().is_some() && n.name != "gone" {
            online.push(n.machine_id.clone());
        }
    }
    {
        let fake = fake.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            for n in fake.nodes.lock().unwrap().iter_mut() {
                if online.contains(&n.machine_id) {
                    n.live_since = Some(2);
                }
            }
        });
    }
    // The new hub comes up; its watcher says so.
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs the new build" }).to_string(),
    )
    .unwrap();
    let after = area(home.path(), &fake);
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(hub_state(&run), UpdateState::Done);
    let expect = [
        ("builder", UpdateState::Done, None),
        ("laptop", UpdateState::RolledBack, Some(UpdateStage::Health)),
        ("mac", UpdateState::Failed, Some(UpdateStage::Checksum)),
        ("nas", UpdateState::Skipped, None),
        ("old-box", UpdateState::Skipped, None),
        ("pi", UpdateState::Current, None),
        ("quiet", UpdateState::Failed, Some(UpdateStage::Download)),
        ("gone", UpdateState::Skipped, None),
    ];
    for (name, st, stage) in expect {
        assert_eq!(state(&run, Some(name)), (st, stage), "{name}");
    }
    let parts = by_machine(&run);
    let said = |name: &str| {
        parts[&Some(MachineId::unchecked(name))]
            .message
            .as_ref()
            .unwrap()
            .to_string()
    };
    assert!(
        said("old-box").contains("run `fleetd update` on old-box once"),
        "{}",
        said("old-box")
    );
    assert!(said("nas").starts_with("offline"), "{}", said("nas"));
    assert!(said("gone").starts_with("offline"), "{}", said("gone"));
    let mut asked = fake.asked.lock().unwrap().clone();
    asked.sort();
    assert_eq!(
        asked,
        ["builder", "laptop", "mac", "quiet"],
        "only online nodes that can, and need to"
    );
}

/// The watcher never restarted the hub (it died, or the service manager refused): the hub still running ends the
/// run past its deadline, with the previous binary back, instead of staying "restarting" for ever.
#[tokio::test]
async fn a_restart_that_never_happens_ends_the_run_and_says_so() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    let updates = Updates::new(
        home.path(),
        Arc::new(SystemClock),
        Timing {
            restart: Duration::from_millis(100),
            ..fast()
        },
    );
    updates.set_ports(fake.clone());
    updates.start(None).unwrap();
    let run = until(&updates, |r| r.finished_at.is_some()).await;
    assert_eq!(
        state(&run, None),
        (UpdateState::Failed, Some(UpdateStage::Restart))
    );
    let said = by_machine(&run)[&None]
        .message
        .as_ref()
        .unwrap()
        .to_string();
    assert!(said.starts_with("the hub didn't restart onto"), "{said}");
    assert!(said.ends_with("its previous binary was put back"), "{said}");
    assert_eq!(fs::read(&fake.exe).unwrap(), b"old");
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Skipped);
    assert!(fake.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_second_update_while_one_runs_is_the_same_one() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = area(home.path(), &fake);
    let first = updates.start(None).unwrap();
    let again = updates.start(None).unwrap();
    assert_eq!(first.id, again.id);
}

mod on_a_real_hub {
    use super::*;
    use crate::hub::api::{Caller, Hub, HubConfig};
    use crate::hub::leads::records::StoredLead;
    use crate::hub::store::test_clock::ManualClock;
    use crate::hub::store::{HubDb, StoredThread};
    use fleetd_contracts::auth::KeyKind;

    const AT: &str = "2026-10-26T10:00:00.000Z";

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

    fn thread(hub: &Hub, id: &str) {
        hub.store
            .thread_upsert(&StoredThread {
                thread: serde_json::from_value(json!({
                    "machineId": "devbox", "threadId": id, "projectId": "p1", "title": id, "status": "running",
                    "headline": "", "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT,
                }))
                .unwrap(),
                last_sequence: None,
                last_run_id: None,
                last_run_status: None,
            })
            .unwrap();
    }

    /// The idle gate is gone: a lead mid-turn and a running agent don't hold the update; they carry on afterwards
    /// (`leads::cut_off`, `tasks::recovery`).
    #[tokio::test]
    async fn an_update_while_the_lead_and_an_agent_are_mid_turn_starts_at_once() {
        let home = tempfile::tempdir().unwrap();
        let hub: Arc<Hub> = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            HubConfig {
                home: home.path().to_path_buf(),
                listen: Default::default(),
                url: None,
                queue_ttl_sec: None,
            },
            ManualClock::at(1_792_000_000_000),
        )
        .unwrap();
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": "p1", "title": "storefront", "workspaceRoot": "/work/storefront",
                    "threads": { "running": 1, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
        hub.leads
            .records
            .lead_put(&StoredLead {
                project_ref: serde_json::from_value(
                    json!({ "machineId": "devbox", "projectId": "p1" }),
                )
                .unwrap(),
                thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
                started_at: AT.into(),
                last_wake_at: None,
                session_generation: 1,
            })
            .unwrap();
        thread(&hub, "lead-thread");
        let busy = crate::hub::info::busy(&hub).unwrap();
        assert!(!busy.is_empty(), "the lead is mid-turn");

        let fake = Arc::new(Fake::new(home.path(), b"new"));
        hub.updates.set_ports(fake.clone());
        let tools = crate::hub::api::registry();
        let refused = tools
            .call(&hub, &person("operate"), "hub_update", json!({}))
            .await
            .unwrap_err();
        assert!(format!("{refused:?}").contains("Forbidden"), "{refused:?}");

        let out: HubUpdateOutput = serde_json::from_value(
            tools
                .call(&hub, &person("admin"), "hub_update", json!({}))
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(out.run.is_some());
        let run = until(&hub.updates, |r| hub_state(r) == UpdateState::Restarting).await;
        assert_eq!(run.to.as_ref().map(|t| t.as_str()), Some(NEW));
        assert_eq!(
            fake.plans.lock().unwrap().len(),
            1,
            "the restart was handed to the watcher at once"
        );
        let status: HubUpdateOutput = serde_json::from_value(
            tools
                .call(&hub, &person("read"), "hub_update_status", json!({}))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(status.run.map(|r| r.id), Some(run.id));
    }
}
