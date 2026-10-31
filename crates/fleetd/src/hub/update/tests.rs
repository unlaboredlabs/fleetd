//! The hub's update against a fake release feed and fake machines: it starts at once however busy the hub is, a
//! failed download or checksum leaves everything as it was, a hub that doesn't come up healthy is put back and its
//! nodes aren't asked, and each node's own result is said. No machine is ever moved back to an older build, and a run
//! the hub moved past, or nothing drives any more, ends.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{
    HubChannel, HubUpdateOutput, UpdatePart, UpdatePartKind, UpdateRun, UpdateStage, UpdateState,
};
use fleetd_contracts::node_link::{NodeActionResult, NodeUpdate};
use fleetd_contracts::prim::Text;
use serde_json::json;

use super::{NodeAnswer, NodeFacts, Refusal, Timing, UpdatePorts, Updates, by_machine};
use crate::clock::SystemClock;
use crate::hub::store::test_clock::ManualClock;
use crate::update::finish::{Plan, Verdict};
use crate::update::service::Service;
use crate::update::tests::{FakeFeed, FakeRunner};
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
    /// Staged it, but its service manager refused the restart: it stays on its link and build, and says so.
    RestartRefused(&'static str),
}

/// The fake node's second answer, already there.
struct Said(Option<NodeActionResult>);

impl Refusal for Said {
    fn try_take(&mut self) -> Option<NodeActionResult> {
        self.0.take()
    }
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
    /// The nodes asked to fetch the build ahead.
    fetched: Mutex<Vec<String>>,
    /// Bumped when a test moves a node's link.
    links: tokio::sync::watch::Sender<u64>,
    /// How a node's Claude Code install goes, by machine: its answer's words, or its failure's. Absent: installed.
    claude: HashMap<String, Result<&'static str, &'static str>>,
    claude_asked: Mutex<Vec<String>>,
    /// Its agents mid-step, by machine, as its hold answers. Absent: none.
    steps: Mutex<HashMap<String, u32>>,
    /// The machines asked to hold their agents, once per ask.
    held: Mutex<Vec<String>>,
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
            fetched: Mutex::default(),
            links: tokio::sync::watch::channel(0).0,
            claude: HashMap::new(),
            claude_asked: Mutex::default(),
            steps: Mutex::default(),
            held: Mutex::default(),
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
            can_fetch: can_update,
            can_hold: can_update,
            claude: Some("2.1.310 (Claude Code)".into()),
            can_install_claude: can_update,
            busy: None,
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
    fn fetch_on_node(&self, machine_id: &MachineId, update: &NodeUpdate) {
        assert_eq!(update.version.as_str(), NEW);
        self.fetched.lock().unwrap().push(machine_id.to_string());
    }
    fn hold_node<'a>(&'a self, machine_id: &'a MachineId) -> BoxFuture<'a, Result<u32, String>> {
        self.held.lock().unwrap().push(machine_id.to_string());
        let steps = self
            .steps
            .lock()
            .unwrap()
            .get(machine_id.as_str())
            .copied()
            .unwrap_or(0);
        Box::pin(async move { Ok(steps) })
    }
    fn claude_target(&self) -> String {
        "2.1.314".into()
    }
    fn install_claude<'a>(
        &'a self,
        machine_id: &'a MachineId,
        version: &'a str,
    ) -> BoxFuture<'a, Result<NodeActionResult, String>> {
        assert_eq!(version, "2.1.314");
        self.claude_asked
            .lock()
            .unwrap()
            .push(machine_id.to_string());
        let answer = match self.claude.get(machine_id.as_str()) {
            None => result(true, None, "Claude Code 2.1.310 -> 2.1.314"),
            Some(Ok(said)) => result(true, None, said),
            Some(Err(why)) => result(false, Some(UpdateStage::Install), why),
        };
        Box::pin(async move { Ok(answer) })
    }
    fn node_changed(&self, _: &MachineId) -> BoxFuture<'static, ()> {
        let mut links = self.links.subscribe();
        Box::pin(async move {
            let _ = links.changed().await;
        })
    }
    fn update_node<'a>(
        &'a self,
        machine_id: &'a MachineId,
        _: &'a NodeUpdate,
    ) -> BoxFuture<'a, Result<NodeAnswer, String>> {
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
                Ok((result(true, None, "restarting"), Said(None)))
            }
            Some(Answer::Refuses(stage, message)) => {
                Ok((result(false, Some(stage), message), Said(None)))
            }
            Some(Answer::RestartRefused(message)) => Ok((
                result(true, None, "restarting"),
                Said(Some(result(false, Some(UpdateStage::Restart), message))),
            )),
            None => Err("the link to its node dropped while the command ran".into()),
        }
        .map(|(r, said)| (r, Box::new(said) as Box<dyn Refusal>));
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
        login_url: None,
        steps: None,
    }
}

fn fast() -> Timing {
    Timing {
        poll: Duration::from_millis(5),
        node_poll: Duration::from_millis(5),
        verdict: Duration::from_millis(300),
        node_back: Duration::from_millis(300),
        // Longer than any test: the old process's own deadline never cuts in, but where a test says.
        restart: Duration::from_secs(60),
        prefetch_every: Duration::from_secs(600),
        drain_poll: Duration::from_millis(5),
        drain: Duration::from_secs(60),
        auto_gap: Duration::from_secs(3600),
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

/// A machine's Claude Code part.
fn claude(run: &UpdateRun, machine: &str) -> UpdatePart {
    run.parts
        .iter()
        .find(|p| {
            p.part == UpdatePartKind::Claude && p.machine_id == Some(MachineId::unchecked(machine))
        })
        .unwrap()
        .clone()
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
    updates.start(None, false).unwrap();
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
    updates.start(None, false).unwrap();
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
    updates.start(Some(HubChannel::Edge), false).unwrap();
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
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;

    // The hub's restart drops every link; the nodes that were online come back a moment after the new hub is up,
    // but for one that stays away. One offline when the run started was skipped then.
    let mut online: Vec<MachineId> = Vec::new();
    for n in fake.nodes.lock().unwrap().iter_mut() {
        if n.live_since.take().is_some() && n.name != "gone" {
            online.push(n.machine_id.clone());
        }
    }
    // The new hub comes up; its watcher says so.
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs the new build" }).to_string(),
    )
    .unwrap();
    // Its time only moves here, so the nodes' moment back always falls well inside the while it waits for them.
    let clock = ManualClock::at(1_792_000_000_000);
    let after = Updates::new(home.path(), clock.clone(), fast());
    after.set_ports(fake.clone());
    tokio::spawn(after.clone().resume());
    let back_at = Duration::from_millis(60);
    let mut moved = Duration::ZERO;
    let run = loop {
        if let Some(run) = after.status().filter(|r| r.finished_at.is_some()) {
            break run;
        }
        assert!(
            moved < Duration::from_secs(10),
            "never got there: {:?}",
            after.status()
        );
        if moved == back_at {
            for n in fake.nodes.lock().unwrap().iter_mut() {
                if online.contains(&n.machine_id) {
                    n.live_since = Some(2);
                }
            }
        }
        clock.advance(fast().poll);
        moved += fast().poll;
        tokio::time::sleep(Duration::from_millis(1)).await;
    };
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

/// While the hub downloads its build, each node it will update downloads it too (`fetch`): only those online that can
/// and don't run it already. Nothing is installed on them, and none is asked to update before the hub runs it.
#[tokio::test]
async fn while_the_hub_downloads_the_nodes_it_will_update_fetch_the_build() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(
        Fake::new(home.path(), b"new")
            .node("builder", OLD, true, true, Some(Answer::BackOn(NEW)))
            .node("laptop", OLD, true, true, Some(Answer::BackOn(NEW)))
            .node("nas", OLD, false, true, None)
            .node("old-box", "0.4.0", true, false, None)
            .node("pi", NEW, true, true, None),
    );
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    let mut fetched = fake.fetched.lock().unwrap().clone();
    fetched.sort();
    assert_eq!(fetched, ["builder", "laptop"]);
    assert!(fake.asked.lock().unwrap().is_empty(), "no node updates yet");

    // A download that fails asks nothing more of them: the hub didn't update, so neither do they.
    let home = tempfile::tempdir().unwrap();
    let tampered = Fake::new(home.path(), b"new").node("builder", OLD, true, true, None);
    tampered
        .feed
        .files
        .lock()
        .unwrap()
        .insert(ASSET.into(), b"evil".to_vec());
    let tampered = Arc::new(tampered);
    let updates = area(home.path(), &tampered);
    updates.start(None, false).unwrap();
    let run = until(&updates, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Skipped);
    assert!(tampered.asked.lock().unwrap().is_empty());
}

/// The new hub updates a node the moment its link is back, and sees it come back on the new build the moment it does:
/// it wakes on the link, not on a timer (here one that would take a minute).
#[tokio::test]
async fn a_node_is_followed_by_its_link_not_a_timer() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    // The hub's restart drops the node's link; the new hub comes up and its watcher says so.
    fake.nodes.lock().unwrap()[0].live_since = None;
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let slow = Timing {
        node_poll: Duration::from_secs(60),
        node_back: Duration::from_secs(600),
        ..fast()
    };
    let after = Updates::new(home.path(), Arc::new(SystemClock), slow);
    after.set_ports(fake.clone());
    tokio::spawn(after.clone().resume());
    until(&after, |r| hub_state(r) == UpdateState::Done).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(fake.asked.lock().unwrap().is_empty(), "not back yet");

    let back = std::time::Instant::now();
    fake.nodes.lock().unwrap()[0].live_since = Some(2);
    fake.links.send_modify(|n| *n += 1);
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Done);
    assert!(
        back.elapsed() < Duration::from_secs(5),
        "{:?}",
        back.elapsed()
    );
}

/// Once a machine's node runs the new build, its Claude Code goes to the version that build was tested with, as a
/// part of its own. One whose install fails keeps its version and says why; the others still finish, and a machine
/// whose fleetd didn't update isn't asked.
#[tokio::test]
async fn each_machines_claude_follows_its_node_and_a_failed_install_stops_nothing_else() {
    let home = tempfile::tempdir().unwrap();
    let mut fake = Fake::new(home.path(), b"new")
        .node("brewbox", OLD, true, true, Some(Answer::BackOn(NEW)))
        .node("builder", OLD, true, true, Some(Answer::BackOn(NEW)))
        .node("laptop", OLD, true, true, Some(Answer::BackOn(OLD)))
        .node("mac", OLD, true, true, Some(Answer::BackOn(NEW)))
        .node("nas", OLD, false, true, None)
        .node("pi", NEW, true, true, None);
    fake.claude.insert(
        "brewbox".into(),
        Ok("Claude Code is managed by Homebrew: run `brew upgrade claude-code` to update it (it runs 2.1.310)"),
    );
    fake.claude.insert(
        "mac".into(),
        Err("`claude install 2.1.314` failed (Could not download: 404), so 2.1.310 stays"),
    );
    fake.claude
        .insert("pi".into(), Ok("already runs Claude Code 2.1.314"));
    let fake = Arc::new(fake);
    let updates = area(home.path(), &fake);
    let started = updates.start(None, false).unwrap();
    assert_eq!(
        started.parts.len(),
        1 + 2 * 6,
        "the hub, then a node and Claude Code per machine"
    );
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert!(
        fake.claude_asked.lock().unwrap().is_empty(),
        "nothing before the hub runs the new build"
    );
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let after = Updates::new(home.path(), Arc::new(SystemClock), fast());
    after.set_ports(fake.clone());
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| r.finished_at.is_some()).await;

    let builder = claude(&run, "builder");
    assert_eq!(builder.state, UpdateState::Done);
    assert_eq!(builder.from.as_str(), "2.1.310");
    assert_eq!(builder.to.as_ref().map(|t| t.as_str()), Some("2.1.314"));
    let mac = claude(&run, "mac");
    assert_eq!(
        (mac.state, mac.stage),
        (UpdateState::Failed, Some(UpdateStage::Install))
    );
    assert!(
        mac.message
            .as_ref()
            .unwrap()
            .as_str()
            .ends_with("so 2.1.310 stays")
    );
    assert_eq!(
        state(&run, Some("mac")).0,
        UpdateState::Done,
        "its fleetd updated all the same"
    );
    assert_eq!(claude(&run, "pi").state, UpdateState::Current);
    let laptop = claude(&run, "laptop");
    assert_eq!(laptop.state, UpdateState::Skipped);
    assert_eq!(
        laptop.message.as_ref().unwrap().as_str(),
        "not asked: its fleetd didn't update"
    );
    assert_eq!(claude(&run, "nas").state, UpdateState::Skipped);
    // Claude Code that Homebrew manages is left as it is, calmly: a skip with its command, not a failure.
    let brew = claude(&run, "brewbox");
    assert_eq!((brew.state, brew.stage), (UpdateState::Skipped, None));
    assert!(
        brew.message
            .as_ref()
            .unwrap()
            .as_str()
            .contains("`brew upgrade claude-code`")
    );
    let mut asked = fake.claude_asked.lock().unwrap().clone();
    asked.sort();
    assert_eq!(asked, ["brewbox", "builder", "mac", "pi"]);
}

/// Ahead of any update the hub downloads the newest build, checks it and keeps it, and asks its nodes to fetch it; the
/// update then installs what it kept without downloading it again. A download that doesn't match the sums isn't kept.
#[tokio::test]
async fn the_newest_build_is_downloaded_ahead_and_update_only_swaps_it_in() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(
        Fake::new(home.path(), b"new")
            .node("builder", OLD, true, true, Some(Answer::BackOn(NEW)))
            .node("nas", OLD, false, true, None)
            .node("pi", NEW, true, true, None),
    );
    let updates = area(home.path(), &fake);
    assert_eq!(updates.ready(), None);
    updates.prefetch().await;
    assert_eq!(updates.ready().as_deref(), Some(NEW));
    assert_eq!(
        fs::read(home.path().join("update/fleetd.next")).unwrap(),
        b"new"
    );
    assert_eq!(
        *fake.fetched.lock().unwrap(),
        ["builder"],
        "online, able, and not on it yet"
    );
    assert_eq!(fs::read(&fake.exe).unwrap(), b"old", "nothing installed");

    // The feed goes away: Update installs the build it kept, checked against the sums again.
    fake.feed.files.lock().unwrap().remove(ASSET);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert_eq!(fs::read(&fake.exe).unwrap(), b"new");
    assert_eq!(updates.ready(), None);

    let home = tempfile::tempdir().unwrap();
    let tampered = Fake::new(home.path(), b"new").node("builder", OLD, true, true, None);
    tampered
        .feed
        .files
        .lock()
        .unwrap()
        .insert(ASSET.into(), b"evil".to_vec());
    let tampered = Arc::new(tampered);
    let updates = area(home.path(), &tampered);
    updates.prefetch().await;
    assert_eq!(updates.ready(), None);
    assert!(!home.path().join("update/fleetd.next").exists());
    assert!(tampered.fetched.lock().unwrap().is_empty());
}

/// A machine running what a restart would end (a live session, a preview) is updated once that ends, and says so
/// meanwhile.
#[tokio::test]
async fn a_busy_machine_waits_for_what_runs_on_it_and_says_so() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    fake.nodes.lock().unwrap()[0].busy = Some("1 live session".into());
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let after = area(home.path(), &fake);
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| {
        by_machine(r)[&Some(MachineId::unchecked("builder"))]
            .message
            .is_some()
    })
    .await;
    let part = &by_machine(&run)[&Some(MachineId::unchecked("builder"))];
    assert_eq!(part.state, UpdateState::Waiting);
    let message = part.message.as_ref().unwrap().as_str();
    assert!(
        message.starts_with("waits for 1 live session; installs by ")
            && message.ends_with(" UTC whatever runs"),
        "{message}"
    );
    assert_eq!(part.agents, Some(0));
    assert!(part.installs_by.is_some());
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(fake.asked.lock().unwrap().is_empty(), "not while it's busy");

    fake.nodes.lock().unwrap()[0].busy = None;
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Done);
}

/// The hub of a run restarted onto `NEW`: its verdict written, a new hub process taking the run on from there.
async fn hub_restarted(home: &Path, updates: &Updates, fake: &Arc<Fake>) -> Arc<Updates> {
    until(updates, |r| hub_state(r) == UpdateState::Restarting).await;
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let after = area(home, fake);
    tokio::spawn(after.clone().resume());
    after
}

fn node_part(run: &UpdateRun, machine: &str) -> UpdatePart {
    by_machine(run)[&Some(MachineId::unchecked(machine))].clone()
}

/// A node with agents mid-step holds the rest and waits for those, saying how many and by when it installs; once none
/// is mid-step, it installs, well before the deadline.
#[tokio::test]
async fn a_node_waits_for_its_agents_to_finish_their_step_then_installs() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    fake.steps.lock().unwrap().insert("builder".into(), 2);
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    let after = hub_restarted(home.path(), &updates, &fake).await;
    let run = until(&after, |r| node_part(r, "builder").agents == Some(2)).await;
    let part = node_part(&run, "builder");
    assert_eq!(part.state, UpdateState::Waiting);
    let message = part.message.unwrap().to_string();
    assert!(
        message.starts_with("waits for 2 agents to finish their step; installs by "),
        "{message}"
    );
    let by = part.installs_by.unwrap();
    let started = chrono::DateTime::parse_from_rfc3339(run.started_at.as_str()).unwrap();
    let by = chrono::DateTime::parse_from_rfc3339(by.as_str()).unwrap();
    assert!(
        by > started && by <= started + chrono::Duration::seconds(65),
        "{by}"
    );
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        fake.asked.lock().unwrap().is_empty(),
        "not while agents are mid-step"
    );
    assert!(
        fake.held.lock().unwrap().len() > 1,
        "the hold is renewed while it waits"
    );

    fake.steps.lock().unwrap().insert("builder".into(), 0);
    let run = until(&after, |r| r.finished_at.is_some()).await;
    let part = node_part(&run, "builder");
    assert_eq!(part.state, UpdateState::Done);
    assert_eq!((part.agents, part.installs_by), (None, None));
}

/// Agents that never reach a step's end (24/7 work) don't hold an update off: at the deadline the node installs
/// whatever runs.
#[tokio::test]
async fn a_node_with_busy_agents_installs_by_the_deadline() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    fake.steps.lock().unwrap().insert("builder".into(), 5);
    fake.nodes.lock().unwrap()[0].busy = Some("1 preview".into());
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let after = Updates::new(
        home.path(),
        Arc::new(SystemClock),
        Timing {
            drain: Duration::from_millis(200),
            ..fast()
        },
    );
    after.set_ports(fake.clone());
    let waited = std::time::Instant::now();
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| node_part(r, "builder").agents == Some(5)).await;
    assert!(
        node_part(&run, "builder").message.unwrap().starts_with(
            "waits for 5 agents to finish their step, and for 1 preview; installs by "
        )
    );
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert!(waited.elapsed() >= Duration::from_millis(200), "it waited");
    assert_eq!(node_part(&run, "builder").state, UpdateState::Done);
    assert_eq!(fake.asked.lock().unwrap().as_slice(), ["builder"]);
}

/// The deadline is the hub's update setting when it has one: 0 doesn't wait.
#[tokio::test]
async fn the_deadline_comes_from_the_hubs_update_settings() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = area(home.path(), &fake);
    assert_eq!(updates.drain(), Duration::from_secs(60));
    fs::create_dir_all(home.path().join("update")).unwrap();
    fs::write(
        home.path().join("update/settings.json"),
        r#"{"drainMinutes":25}"#,
    )
    .unwrap();
    assert_eq!(updates.drain(), Duration::from_secs(25 * 60));
    fs::write(
        home.path().join("update/settings.json"),
        r#"{"drainMinutes":0}"#,
    )
    .unwrap();
    assert_eq!(updates.drain(), Duration::ZERO);
    assert_eq!(super::Timing::default().drain, Duration::from_secs(600));
}

/// The settings `hub_update_settings` writes: a field left out stays, and the drain is capped.
#[tokio::test]
async fn update_settings_change_one_field_at_a_time() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = area(home.path(), &fake);
    let off = updates.settings();
    assert!(!off.auto, "automatic updates are off by default");
    assert_eq!(off.drain_minutes, 1, "the timing's own minute");
    let on = updates.set_settings(Some(true), None).unwrap();
    assert!(on.auto);
    let longer = updates.set_settings(None, Some(25)).unwrap();
    assert!(longer.auto, "auto stays");
    assert_eq!(longer.drain_minutes, 25);
    assert_eq!(updates.drain(), Duration::from_secs(25 * 60));
    assert_eq!(
        updates
            .set_settings(None, Some(10_000))
            .unwrap()
            .drain_minutes,
        240
    );
}

/// The channel now offers `version`, a build of these bytes.
fn publish(fake: &Fake, version: &str, binary: &[u8]) {
    let mut files = fake.feed.files.lock().unwrap();
    files.insert(ASSET.into(), binary.to_vec());
    files.insert(
        "SHA256SUMS".into(),
        format!("{}  {ASSET}\n", crate::update::sha256_hex(binary)).into_bytes(),
    );
    files.insert(
        "release.json".into(),
        format!(r#"{{"cliVersion":"{version}"}}"#).into_bytes(),
    );
}

/// An update area whose automatic updates are on, `gap` apart, with a finished update that started `ago` before now.
fn auto_area(home: &Path, fake: &Arc<Fake>, gap: Duration, ago: Duration) -> Arc<Updates> {
    auto_area_after(home, fake, gap, ago, (OLD, UpdateState::Current))
}

/// [`auto_area`] whose last update went to `to`, the hub's part ending `hub`.
fn auto_area_after(
    home: &Path,
    fake: &Arc<Fake>,
    gap: Duration,
    ago: Duration,
    (to, hub): (&str, UpdateState),
) -> Arc<Updates> {
    let started = chrono::Utc::now() - chrono::Duration::from_std(ago).unwrap();
    let at = started.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let hub = super::part(UpdatePartKind::Hub, None, "the hub", OLD, hub);
    let run = json!({
        "id": "U0", "channel": "edge", "to": to, "startedAt": at, "finishedAt": at, "parts": [hub],
    });
    fs::create_dir_all(home.join("update")).unwrap();
    fs::write(home.join("update/run.json"), run.to_string()).unwrap();
    let updates = Updates::new(
        home,
        Arc::new(SystemClock),
        Timing {
            auto_gap: gap,
            ..fast()
        },
    );
    updates.set_ports(fake.clone());
    updates.set_settings(Some(true), None).unwrap();
    updates
}

/// A build the hub didn't come up healthy on, put back, isn't tried again by itself, hour after hour: automatic updates
/// skip it, and say so, until a newer one is out, which installs as usual.
#[tokio::test]
async fn a_build_that_was_put_back_is_skipped_until_a_newer_one() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = auto_area_after(
        home.path(),
        &fake,
        Duration::from_secs(3600),
        Duration::from_secs(2 * 3600),
        (NEW, UpdateState::RolledBack),
    );
    assert!(updates.auto_tick().await.is_none(), "not again");
    assert_eq!(
        updates.ready().as_deref(),
        Some(NEW),
        "still offered to a person"
    );
    assert_eq!(updates.auto_skips().as_deref(), Some(NEW));
    assert_eq!(updates.auto_at(), None);
    assert!(fake.plans.lock().unwrap().is_empty());

    publish(&fake, NEWER, b"newer");
    let run = updates.auto_tick().await.expect("a newer build goes in");
    assert_eq!(run.auto, Some(true));
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert_eq!(fake.plans.lock().unwrap()[0].to, NEWER);
    assert_eq!(updates.auto_skips(), None);

    // A build that failed another way (a download, say) is tried again at the next hour.
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = auto_area_after(
        home.path(),
        &fake,
        Duration::from_secs(3600),
        Duration::from_secs(2 * 3600),
        (NEW, UpdateState::Failed),
    );
    assert_eq!(updates.auto_skips(), None);
    assert!(updates.auto_tick().await.is_some());
}

/// Off by default: a build ready is only offered. On: it installs by itself, an update like the button's that says it
/// started by itself.
#[tokio::test]
async fn automatic_updates_are_off_until_turned_on() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = area(home.path(), &fake);
    assert!(updates.auto_tick().await.is_none());
    assert_eq!(
        updates.ready().as_deref(),
        Some(NEW),
        "ready, not installed"
    );
    assert_eq!(updates.auto_at(), None);
    assert!(fake.plans.lock().unwrap().is_empty());

    updates.set_settings(Some(true), None).unwrap();
    let before = super::now_ms(&SystemClock);
    assert!(
        updates.auto_at().unwrap() >= before,
        "due now: no update before"
    );
    let run = updates.auto_tick().await.expect("it starts by itself");
    assert_eq!(run.auto, Some(true));
    assert_eq!(run.now, None, "it waits for agents as Update does");
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert_eq!(fake.plans.lock().unwrap()[0].to, NEW);
    assert!(
        updates.auto_tick().await.is_none(),
        "not again while it runs"
    );
}

/// Two builds that come out within the hour after an update install once, an hour after it, as the newer one; and a
/// person's update counts toward the hour as an automatic one does.
#[tokio::test]
async fn two_builds_within_an_hour_install_once() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let gap = Duration::from_millis(400);
    let updates = auto_area(home.path(), &fake, gap, Duration::ZERO);
    // The first build, minutes after a person's update.
    assert!(updates.auto_tick().await.is_none(), "within the hour");
    assert_eq!(updates.ready().as_deref(), Some(NEW));
    let due = updates.auto_at().unwrap();
    assert!(due > super::now_ms(&SystemClock), "due at the hour's end");
    // The second build replaces it.
    publish(&fake, NEWER, b"newer");
    assert!(updates.auto_tick().await.is_none(), "still within the hour");
    assert_eq!(updates.ready().as_deref(), Some(NEWER));
    assert_eq!(updates.auto_at(), Some(due), "the same hour");
    assert!(
        fake.plans.lock().unwrap().is_empty(),
        "nothing installed yet"
    );

    tokio::time::sleep(gap).await;
    let run = updates.auto_tick().await.expect("the hour is over");
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert!(updates.auto_tick().await.is_none());
    let plans = fake.plans.lock().unwrap();
    assert_eq!(plans.len(), 1, "one install");
    assert_eq!(plans[0].to, NEWER, "the newest build");
    assert_eq!(updates.status().unwrap().id, run.id);
}

/// An update that started more than an hour ago holds nothing up: a build ready installs at the next look.
#[tokio::test]
async fn a_build_after_a_quiet_hour_installs_at_once() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = auto_area(
        home.path(),
        &fake,
        Duration::from_secs(3600),
        Duration::from_secs(3700),
    );
    assert!(updates.auto_tick().await.is_some());
}

/// Update now doesn't wait for agents: not when it starts the run, and not for a run already waiting, whose nodes
/// install at once.
#[tokio::test]
async fn update_now_skips_the_wait_and_cuts_one_short() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    fake.steps.lock().unwrap().insert("builder".into(), 3);
    let updates = area(home.path(), &fake);
    assert_eq!(updates.start(None, true).unwrap().now, Some(true));
    let after = hub_restarted(home.path(), &updates, &fake).await;
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(node_part(&run, "builder").state, UpdateState::Done);
    assert!(fake.held.lock().unwrap().is_empty(), "nothing held");

    // Pressed while a run waits.
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    fake.steps.lock().unwrap().insert("builder".into(), 3);
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    let after = hub_restarted(home.path(), &updates, &fake).await;
    let waiting = until(&after, |r| node_part(r, "builder").agents == Some(3)).await;
    let now = after.start(None, true).unwrap();
    assert_eq!(
        (now.id, now.now),
        (waiting.id, Some(true)),
        "the same run, now"
    );
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(node_part(&run, "builder").state, UpdateState::Done);
}

/// The hub's own part never waits for agents: they don't need it mid-step. With agents mid-step on every node, the hub
/// restarts at once, nothing held first.
#[tokio::test]
async fn a_hub_update_doesnt_wait_for_agents() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    fake.steps.lock().unwrap().insert("builder".into(), 4);
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert_eq!(
        fake.plans.lock().unwrap().len(),
        1,
        "the hub's restart is handed over"
    );
    assert!(
        fake.held.lock().unwrap().is_empty(),
        "no node was asked to hold first"
    );

    // A hub on its own (no node behind) updates and finishes without waiting on anything.
    let home = tempfile::tempdir().unwrap();
    let alone = Arc::new(Fake::new(home.path(), b"new"));
    let updates = area(home.path(), &alone);
    updates.start(None, false).unwrap();
    let after = hub_restarted(home.path(), &updates, &alone).await;
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(hub_state(&run), UpdateState::Done);
}

/// Retry updates one machine of the last run again (here one that didn't come back in time); the rest stays as it was.
/// Nothing to retry for a machine the run didn't have.
#[tokio::test]
async fn retry_updates_one_machine_again() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(
        Fake::new(home.path(), b"new")
            .node("builder", OLD, true, true, Some(Answer::BackOn(NEW)))
            .node("mac", OLD, true, true, Some(Answer::BackOn(NEW))),
    );
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    // mac stays away after the hub's restart.
    fake.nodes.lock().unwrap()[1].live_since = None;
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let after = area(home.path(), &fake);
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Done);
    assert_eq!(state(&run, Some("mac")).0, UpdateState::Skipped);
    assert_eq!(
        after.retry(&MachineId::unchecked("nowhere"), false),
        Err(super::Refused::NothingToRetry)
    );

    fake.nodes.lock().unwrap()[1].live_since = Some(1);
    let again = after.retry(&MachineId::unchecked("mac"), false).unwrap();
    assert!(again.finished_at.is_none());
    assert_eq!(state(&again, Some("mac")).0, UpdateState::Waiting);
    assert_eq!(
        state(&again, Some("builder")).0,
        UpdateState::Done,
        "the rest stays"
    );
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("mac")).0, UpdateState::Done);
    assert_eq!(claude(&run, "mac").state, UpdateState::Done);

    // The hub moved on since (`fleetd update` on its machine): Retry would put mac behind it, so it is refused and
    // nothing changes.
    *fake.running.lock().unwrap() = "0.9.0".into();
    let before = after.status();
    assert_eq!(
        after.retry(&MachineId::unchecked("mac"), false),
        Err(super::Refused::HubMovedOn("0.9.0".into()))
    );
    assert_eq!(after.status(), before);
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
    updates.start(None, false).unwrap();
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

/// The watcher's restart of the hub's service was refused: the hub, still running its build, says that plainly, not
/// that it was rolled back or didn't come up.
#[tokio::test]
async fn a_refused_restart_of_the_hubs_service_says_so() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    let plan = fake.plans.lock().unwrap()[0].clone();
    let verdict = crate::update::finish::finish(&plan, &FakeRunner::refusing()).await;
    fs::write(&plan.verdict, serde_json::to_vec(&verdict).unwrap()).unwrap();

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
    assert!(
        said.starts_with(
            "restarting fleetd-hub.service exited with exit status: 1, so it never restarted onto"
        ),
        "{said}"
    );
    assert!(said.ends_with("its previous binary was put back"), "{said}");
    assert_eq!(fs::read(&fake.exe).unwrap(), b"old");
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Skipped);
    assert!(fake.asked.lock().unwrap().is_empty());
}

/// A node's service manager refused its restart: the node, still running its build, says so at once, and the run shows
/// that rather than a node that "didn't come back".
#[tokio::test]
async fn a_refused_restart_of_a_nodes_service_says_so() {
    let home = tempfile::tempdir().unwrap();
    let refused = "restarting fleetd-node.service exited with exit status: 1, so it never restarted onto the new \
                   build and still runs the old one; its previous binary was put back";
    let fake = Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::RestartRefused(refused)),
    );
    *fake.running.lock().unwrap() = NEW.into();
    let fake = Arc::new(fake);
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    let run = until(&updates, |r| r.finished_at.is_some()).await;
    assert_eq!(
        state(&run, Some("builder")),
        (UpdateState::Failed, Some(UpdateStage::Restart))
    );
    let said = by_machine(&run)[&Some(MachineId::unchecked("builder"))]
        .message
        .as_ref()
        .unwrap()
        .to_string();
    assert_eq!(said, refused);
}

#[tokio::test]
async fn a_second_update_while_one_runs_is_the_same_one() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new"));
    let updates = area(home.path(), &fake);
    let first = updates.start(None, false).unwrap();
    let again = updates.start(None, false).unwrap();
    assert_eq!(first.id, again.id);
}

/// An Edge build newer than [`NEW`], a nightly (the same series): what a machine runs after `fleetd update` on it.
const NEWER: &str = "0.0.0-edge.202610271703+bd87c55";

/// A run another hub process left in `<home>/update/run.json`, unfinished, toward `to`: the hub's part done, then each
/// machine's node part and Claude Code part in the state given.
fn left_run(home: &Path, to: &str, machines: &[(&str, UpdateState, Option<&str>)]) {
    let mut parts = vec![super::part(
        UpdatePartKind::Hub,
        None,
        "the hub",
        OLD,
        UpdateState::Done,
    )];
    for (name, st, message) in machines {
        for kind in [UpdatePartKind::Node, UpdatePartKind::Claude] {
            let mut p = super::part(kind, Some(MachineId::unchecked(*name)), name, OLD, *st);
            p.message = message.map(super::text);
            parts.push(p);
        }
    }
    let run = UpdateRun {
        id: Text::unchecked("U1793117222609".to_owned()),
        channel: HubChannel::Edge,
        to: Some(Text::unchecked(to.to_owned())),
        started_at: "2026-10-27T16:07:02.609Z".into(),
        finished_at: None,
        parts: fleetd_contracts::prim::List::new(parts).unwrap(),
        now: None,
        auto: None,
    };
    fs::create_dir_all(home.join("update")).unwrap();
    fs::write(
        home.join("update/run.json"),
        serde_json::to_vec(&run).unwrap(),
    )
    .unwrap();
}

fn said(run: &UpdateRun, machine: &str) -> String {
    by_machine(run)[&Some(MachineId::unchecked(machine))]
        .message
        .as_ref()
        .map_or_else(String::new, ToString::to_string)
}

/// The devbox's story: a run to build A, the hub restarted since on a newer build B (`fleetd update` on its machine),
/// the devbox's node on B too, with a session left behind that still counts as busy. The hub that comes up ends the
/// run: no machine is moved back to A, nothing waits, and each part left says why.
#[tokio::test]
async fn a_run_the_hub_moved_past_ends_at_its_start_and_moves_no_machine_back() {
    let home = tempfile::tempdir().unwrap();
    left_run(
        home.path(),
        NEW,
        &[
            (
                "devbox",
                UpdateState::Waiting,
                Some("waits for 1 live session; installs by 10:30 UTC whatever runs"),
            ),
            ("mac", UpdateState::Done, None),
        ],
    );
    let fake = Fake::new(home.path(), b"new")
        .node("devbox", NEWER, true, true, Some(Answer::BackOn(NEW)))
        .node("mac", NEW, true, true, None);
    fake.nodes.lock().unwrap()[0].busy = Some("1 live session".into());
    *fake.running.lock().unwrap() = NEWER.into();
    let fake = Arc::new(fake);
    let after = area(home.path(), &fake);
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| r.finished_at.is_some()).await;

    assert_eq!(hub_state(&run), UpdateState::Done);
    assert_eq!(
        state(&run, Some("mac")).0,
        UpdateState::Done,
        "what was done stays"
    );
    assert_eq!(state(&run, Some("devbox")).0, UpdateState::Skipped);
    let moved_on =
        "the hub moved on to Edge · Oct 27, 17:03 UTC · bd87c55: press Update for the newest";
    assert_eq!(said(&run, "devbox"), moved_on);
    // Its Claude Code doesn't wait behind a run that ended either.
    assert_eq!(claude(&run, "devbox").state, UpdateState::Skipped);
    assert_eq!(claude(&run, "devbox").message.unwrap().as_str(), moved_on);
    assert!(
        fake.asked.lock().unwrap().is_empty(),
        "no machine moved back to A"
    );
    assert!(fake.claude_asked.lock().unwrap().is_empty());

    // And the next Update starts at once, a new run, rather than showing that one.
    let next = after.start(None, false).unwrap();
    assert_ne!(next.id, run.id);
}

/// A node already on the run's build or newer is never moved back, wherever it is looked at: when the run starts, when
/// a hub that restarted takes the run on, while it waits for a busy machine, and on Retry. Its Claude Code stays too.
#[tokio::test]
async fn a_node_already_past_the_target_is_never_moved_back() {
    // A fresh run: the hub goes to NEW; builder already runs NEWER, and mac's download fails.
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(
        Fake::new(home.path(), b"new")
            .node("builder", NEWER, true, true, Some(Answer::BackOn(NEW)))
            .node(
                "mac",
                OLD,
                true,
                true,
                Some(Answer::Refuses(
                    UpdateStage::Download,
                    "the download failed",
                )),
            ),
    );
    let updates = area(home.path(), &fake);
    updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert_eq!(
        *fake.fetched.lock().unwrap(),
        ["mac"],
        "nothing to fetch for builder"
    );
    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let after = area(home.path(), &fake);
    tokio::spawn(after.clone().resume());
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Current);
    assert_eq!(
        said(&run, "builder"),
        "already runs Edge · Oct 27, 17:03 UTC · bd87c55"
    );
    assert_eq!(claude(&run, "builder").state, UpdateState::Skipped);
    assert!(
        claude(&run, "builder")
            .message
            .unwrap()
            .as_str()
            .starts_with("left as it is: its fleetd runs Edge"),
    );
    assert_eq!(state(&run, Some("mac")).0, UpdateState::Failed);
    assert_eq!(*fake.asked.lock().unwrap(), ["mac"]);
    assert!(fake.claude_asked.lock().unwrap().is_empty());

    // Retry of mac, updated another way since: it is settled as it is, not moved back.
    fake.nodes.lock().unwrap()[1].version = NEWER.into();
    after.retry(&MachineId::unchecked("mac"), false).unwrap();
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("mac")).0, UpdateState::Current);
    assert_eq!(*fake.asked.lock().unwrap(), ["mac"], "not asked again");

    // A hub that restarted takes on a run whose machine moved past it while it waited, busy: settled, not moved back.
    let home = tempfile::tempdir().unwrap();
    left_run(home.path(), NEW, &[("devbox", UpdateState::Waiting, None)]);
    let fake =
        Fake::new(home.path(), b"new").node("devbox", NEW, true, true, Some(Answer::BackOn(NEW)));
    fake.nodes.lock().unwrap()[0].version = OLD.into();
    fake.nodes.lock().unwrap()[0].busy = Some("1 live session".into());
    *fake.running.lock().unwrap() = NEW.into();
    let fake = Arc::new(fake);
    let after = area(home.path(), &fake);
    tokio::spawn(after.clone().resume());
    until(&after, |r| {
        said(r, "devbox").starts_with("waits for 1 live session")
    })
    .await;
    // `fleetd update` on the devbox, with the session still there.
    fake.nodes.lock().unwrap()[0].version = NEWER.into();
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(state(&run, Some("devbox")).0, UpdateState::Current);
    assert!(fake.asked.lock().unwrap().is_empty());
}

/// A run left unfinished with nothing driving it (no task of this process) never holds up the next Update, and a hub
/// that can't take a run on ends it rather than leave it showing for ever.
#[tokio::test]
async fn update_always_starts_and_a_run_left_over_ends() {
    let home = tempfile::tempdir().unwrap();
    left_run(home.path(), NEW, &[("builder", UpdateState::Waiting, None)]);
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "builder",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    let updates = area(home.path(), &fake);
    let left = updates.status().unwrap();
    assert!(left.finished_at.is_none());
    assert!(updates.left_over());
    let started = updates.start(None, false).unwrap();
    assert_ne!(started.id, left.id, "a new run, not the one left over");
    assert_eq!(
        updates.start(None, false).unwrap().id,
        started.id,
        "which is then the one going"
    );
    // A resume that comes late leaves the new run alone.
    updates.clone().resume().await;
    assert_eq!(updates.status().unwrap().id, started.id);
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;

    // A run whose hub part is done but that never learned its build: ended at the hub's start.
    let home = tempfile::tempdir().unwrap();
    left_run(home.path(), NEW, &[("builder", UpdateState::Waiting, None)]);
    let mut run: UpdateRun =
        serde_json::from_slice(&fs::read(home.path().join("update/run.json")).unwrap()).unwrap();
    run.to = None;
    fs::write(
        home.path().join("update/run.json"),
        serde_json::to_vec(&run).unwrap(),
    )
    .unwrap();
    let after = area(home.path(), &fake);
    after.clone().resume().await;
    let run = after.status().unwrap();
    assert!(run.finished_at.is_some());
    assert_eq!(state(&run, Some("builder")).0, UpdateState::Skipped);
}

/// Start over ends the run going on, once the hub has its result, and starts a new one: the run's own tasks stop, so a
/// machine it waited on is asked once, by the new run. While the hub restarts, the run is returned as it is.
#[tokio::test]
async fn start_over_ends_the_run_going_on_and_starts_a_new_one() {
    let home = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::new(home.path(), b"new").node(
        "devbox",
        OLD,
        true,
        true,
        Some(Answer::BackOn(NEW)),
    ));
    fake.nodes.lock().unwrap()[0].busy = Some("1 live session".into());
    let updates = area(home.path(), &fake);
    let first = updates.start(None, false).unwrap();
    until(&updates, |r| hub_state(r) == UpdateState::Restarting).await;
    assert_eq!(
        updates.start_over(None, false).unwrap().id,
        first.id,
        "not while the hub restarts"
    );

    *fake.running.lock().unwrap() = NEW.into();
    let verdict = fake.plans.lock().unwrap()[0].verdict.clone();
    fs::write(
        &verdict,
        json!({ "state": "done", "message": "runs it" }).to_string(),
    )
    .unwrap();
    let after = area(home.path(), &fake);
    assert!(
        after.left_over(),
        "nothing drives it until the hub takes it on"
    );
    tokio::spawn(after.clone().resume());
    until(&after, |r| {
        said(r, "devbox").starts_with("waits for 1 live session")
    })
    .await;
    assert!(!after.left_over());

    let again = after.start_over(None, false).unwrap();
    assert_ne!(again.id, first.id);
    assert!(again.finished_at.is_none());
    until(&after, |r| {
        r.id == again.id && said(r, "devbox").starts_with("waits for 1 live session")
    })
    .await;
    fake.nodes.lock().unwrap()[0].busy = None;
    let run = until(&after, |r| r.finished_at.is_some()).await;
    assert_eq!(run.id, again.id);
    assert_eq!(state(&run, Some("devbox")).0, UpdateState::Done);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        *fake.asked.lock().unwrap(),
        ["devbox"],
        "asked once: the old run's task stopped"
    );
    assert_eq!(after.status().unwrap().id, again.id);
    assert!(!after.left_over());
}

mod on_a_real_hub {
    use super::*;
    use crate::hub::api::{Caller, Hub, HubConfig};
    use crate::hub::leads::records::StoredLead;
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

/// A hub from before D203 saved its run on the nightly channel: the hub that comes up reads it as edge, and writes edge
/// from then on.
#[test]
fn a_run_saved_on_nightly_reads_as_edge() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("update");
    fs::create_dir_all(&dir).unwrap();
    let saved = json!({
        "id": "u1", "channel": "nightly", "to": NEW, "startedAt": "2026-10-26T10:56:00.000Z",
        "parts": [{ "part": "hub", "name": "the hub", "from": OLD, "state": "restarting" }],
    });
    fs::write(dir.join("run.json"), saved.to_string()).unwrap();
    let updates = Updates::new(home.path(), Arc::new(SystemClock), fast());
    let run = updates.status().expect("the saved run");
    assert_eq!(run.channel, HubChannel::Edge);
    updates.save(&run);
    let written: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("run.json")).unwrap()).unwrap();
    assert_eq!(written["channel"], "edge");
}
