//! The pool against a fake boat that keeps its machines in memory and stops them at their lease, on a test clock:
//! every stop path (idle, lease expiry, budget, kill switch, node vanished, wake timeout, hub restart, orphan sweep),
//! the start budget and its backoff, the keepalive, the ledger written before every call, and the hub's tunnel to each
//! machine held exactly while it should be up (a fake here; tunnel_tests holds the real one to an SSH server).
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::boat::{Boat, BoatError, Limits, Sandbox, SshAccess, StartLimits};
use super::lease::Ttl;
use super::ledger::{SettingsChange, State};
use super::tunnel::{Tunnel, Tunnels};
use super::{CreateSpec, Fleet, LABEL_ATTEMPT, LABEL_HUB, LABEL_SLOT, Pool, Why, life, sweep};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::train::host::BoxFut;

const T0: u64 = 1_793_786_400_000; // 2026-11-04T10:00:00Z
const MIN: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Boatish {
    machines: BTreeMap<String, Sandbox>,
    /// Every call, in order: "create boat-1", "get bx_1", "ttl bx_1 1800", "stop bx_1", …
    calls: Vec<String>,
    /// The next call whose line starts with the first refused with the second.
    refuse: VecDeque<(&'static str, BoatError)>,
    limits: Limits,
    /// Idempotency-Key → (body, id).
    idem: HashMap<String, (Vec<u8>, String)>,
    next: u32,
    /// boat's list can't be read.
    list_down: bool,
    usage: HashMap<String, f64>,
    /// Machines that start running between the wake's GET and its resume: the resume finds them running.
    races: std::collections::HashSet<String>,
    /// What the ledger said at each call that starts or stops a machine.
    probes: Vec<String>,
}

struct FakeBoat {
    s: Mutex<Boatish>,
    clock: Arc<ManualClock>,
    /// Reads the ledger at each create, resume and stop.
    probe: Mutex<Option<Box<dyn Fn() -> String + Send + Sync>>>,
}

impl FakeBoat {
    fn new(clock: Arc<ManualClock>) -> Arc<FakeBoat> {
        let limits = Limits {
            can_start: true,
            next_start_dollars: Some(0.0),
            max_active_sandboxes: 100,
            start_limits: Some(StartLimits {
                per_minute: 12,
                per_hour: 60,
                per_day: 200,
            }),
            sandbox_plan_dollars: Some(20.0),
            ..Default::default()
        };
        Arc::new(FakeBoat {
            s: Mutex::new(Boatish {
                limits,
                ..Default::default()
            }),
            clock,
            probe: Mutex::default(),
        })
    }

    fn now(&self) -> i64 {
        crate::hub::store::now_ms(self.clock.as_ref())
    }

    fn call(&self, line: String) -> Result<(), BoatError> {
        let starts_or_stops = ["create", "resume", "stop"]
            .iter()
            .any(|k| line.starts_with(k));
        if starts_or_stops && let Some(probe) = self.probe.lock().unwrap().as_ref() {
            let seen = probe();
            self.s
                .lock()
                .unwrap()
                .probes
                .push(format!("{line}: {seen}"));
        }
        let mut s = self.s.lock().unwrap();
        s.calls.push(line.clone());
        if let Some(i) = s.refuse.iter().position(|(kind, _)| line.starts_with(kind)) {
            return Err(s.refuse.remove(i).unwrap().1);
        }
        Ok(())
    }

    /// boat's auto-stop: every machine past its deadline stops.
    fn expire(&self) {
        let now = self.now();
        for sb in self.s.lock().unwrap().machines.values_mut() {
            if sb.state == "running" && sb.archive_after_ms().is_some_and(|at| at <= now) {
                sb.state = "archived".into();
            }
        }
    }

    /// A machine boat runs that the hub's ledger doesn't hold.
    fn plant(&self, id: &str, labels: &[(&str, &str)], state: &str) {
        let sb = Sandbox {
            id: id.into(),
            state: state.into(),
            labels: labels
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
            archive_after: Some(crate::hub::store::iso_ms(self.now() + 1_800_000)),
            ..Default::default()
        };
        self.s.lock().unwrap().machines.insert(id.into(), sb);
    }

    fn state(&self, id: &str) -> Option<String> {
        self.s
            .lock()
            .unwrap()
            .machines
            .get(id)
            .map(|s| s.state.clone())
    }

    fn calls(&self) -> Vec<String> {
        self.s.lock().unwrap().calls.clone()
    }

    fn calls_like(&self, prefix: &str) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|c| c.starts_with(prefix))
            .collect()
    }

    fn refuse(&self, kind: &'static str, e: BoatError) {
        self.s.lock().unwrap().refuse.push_back((kind, e));
    }

    fn running(&self) -> Vec<String> {
        let s = self.s.lock().unwrap();
        s.machines
            .values()
            .filter(|m| m.state == "running")
            .map(|m| m.id.clone())
            .collect()
    }
}

fn iso(ms: i64) -> String {
    crate::hub::store::iso_ms(ms)
}

impl Boat for FakeBoat {
    fn create<'a>(
        &'a self,
        idem_key: &'a str,
        body: &'a [u8],
    ) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        Box::pin(async move {
            let v: Value = serde_json::from_slice(body).unwrap();
            let slot = v["labels"][LABEL_SLOT].as_str().unwrap_or("?").to_owned();
            self.call(format!("create {slot}"))?;
            let now = self.now();
            let mut s = self.s.lock().unwrap();
            if let Some((known, id)) = s.idem.get(idem_key).cloned() {
                if known != body {
                    return Err(BoatError::IdempotencyKeyReused);
                }
                return Ok(s.machines[&id].clone());
            }
            s.next += 1;
            let id = format!("bx_{:08}", s.next);
            let sb = Sandbox {
                id: id.clone(),
                state: "running".into(),
                labels: serde_json::from_value(v["labels"].clone()).unwrap(),
                archive_after: Some(iso(now + v["ttlSeconds"].as_i64().unwrap() * 1000)),
                ttl_seconds: v["ttlSeconds"].as_i64(),
                ..Default::default()
            };
            s.machines.insert(id.clone(), sb.clone());
            s.idem.insert(idem_key.into(), (body.to_vec(), id));
            Ok(sb)
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        Box::pin(async move {
            self.call(format!("get {id}"))?;
            self.s
                .lock()
                .unwrap()
                .machines
                .get(id)
                .cloned()
                .ok_or(BoatError::NotFound)
        })
    }

    fn list<'a>(
        &'a self,
        labels: &'a [(String, String)],
    ) -> BoxFut<'a, Result<Vec<Sandbox>, BoatError>> {
        Box::pin(async move {
            self.call("list".into())?;
            let s = self.s.lock().unwrap();
            if s.list_down {
                return Err(BoatError::Network("reset".into()));
            }
            Ok(s.machines
                .values()
                .filter(|m| labels.iter().all(|(k, v)| m.labels.get(k) == Some(v)))
                .cloned()
                .collect())
        })
    }

    fn set_ttl<'a>(&'a self, id: &'a str, ttl: Ttl) -> BoxFut<'a, Result<(), BoatError>> {
        Box::pin(async move {
            self.call(format!("ttl {id} {}", ttl.seconds()))?;
            let now = self.now();
            let mut s = self.s.lock().unwrap();
            let m = s.machines.get_mut(id).ok_or(BoatError::NotFound)?;
            m.archive_after = Some(iso(now + ttl.ms()));
            Ok(())
        })
    }

    fn stop<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<(), BoatError>> {
        Box::pin(async move {
            self.call(format!("stop {id}"))?;
            let mut s = self.s.lock().unwrap();
            let m = s.machines.get_mut(id).ok_or(BoatError::NotFound)?;
            m.state = "archived".into();
            Ok(())
        })
    }

    fn resume<'a>(&'a self, id: &'a str, ttl: Ttl) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        Box::pin(async move {
            self.call(format!("resume {id} {}", ttl.seconds()))?;
            let now = self.now();
            let mut s = self.s.lock().unwrap();
            let raced = s.races.remove(id);
            let m = s.machines.get_mut(id).ok_or(BoatError::NotFound)?;
            if raced {
                // boat's 200 `status: "running"`: no start, and the deadline stays where it was.
                m.state = "running".into();
                let mut sb = m.clone();
                sb.already_running = true;
                return Ok(sb);
            }
            assert_ne!(
                m.state, "running",
                "a resume only after a GET saw it stopped"
            );
            m.state = "running".into();
            m.archive_after = Some(iso(now + ttl.ms()));
            Ok(m.clone())
        })
    }

    fn delete<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<(), BoatError>> {
        Box::pin(async move {
            self.call(format!("delete {id}"))?;
            self.s.lock().unwrap().machines.remove(id);
            Ok(())
        })
    }

    fn limits(&self) -> BoxFut<'_, Result<Limits, BoatError>> {
        Box::pin(async move {
            self.call("limits".into())?;
            let mut s = self.s.lock().unwrap();
            let running = s.machines.values().filter(|m| m.state == "running").count() as u32;
            s.limits.active_sandboxes = running;
            Ok(s.limits.clone())
        })
    }

    fn usage<'a>(&'a self, id: &'a str, _since_ms: i64) -> BoxFut<'a, Result<f64, BoatError>> {
        Box::pin(async move {
            self.call(format!("usage {id}"))?;
            Ok(self.s.lock().unwrap().usage.get(id).copied().unwrap_or(0.0))
        })
    }

    fn ssh_key<'a>(
        &'a self,
        id: &'a str,
        _public_key: &'a str,
    ) -> BoxFut<'a, Result<SshAccess, BoatError>> {
        Box::pin(async move {
            self.call(format!("sshkey {id}"))?;
            Ok(SshAccess::default())
        })
    }
}

/// The hub's tunnels, as the pool holds them: each comes up at once unless `down` names its slot.
#[derive(Default)]
struct FakeTunnels {
    held: Mutex<HashMap<String, (String, Tunnel)>>,
    /// Every open and close that changed something, in order: "open boat-1 bx_00000001", "close boat-1".
    log: Mutex<Vec<String>>,
    /// Tunnels to these slots don't come up, with why.
    down: Mutex<HashMap<String, String>>,
}

impl FakeTunnels {
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    /// The held tunnel drops (Some(why)) or comes back (None), as the real one's redial would.
    fn set(&self, slot: &str, down: Option<&str>) {
        if let Some((_, status)) = self.held.lock().unwrap().get_mut(slot) {
            *status = down.map_or(Tunnel::Up, |why| Tunnel::Down(why.into()));
        }
    }
}

impl Tunnels for FakeTunnels {
    fn open(&self, slot: &str, sandbox: &str) {
        let mut held = self.held.lock().unwrap();
        if held.get(slot).is_some_and(|(sb, _)| sb == sandbox) {
            return;
        }
        let status = match self.down.lock().unwrap().get(slot) {
            Some(why) => Tunnel::Down(why.clone()),
            None => Tunnel::Up,
        };
        held.insert(slot.into(), (sandbox.into(), status));
        self.log
            .lock()
            .unwrap()
            .push(format!("open {slot} {sandbox}"));
    }

    fn close(&self, slot: &str) {
        if self.held.lock().unwrap().remove(slot).is_some() {
            self.log.lock().unwrap().push(format!("close {slot}"));
        }
    }

    fn status(&self, slot: &str) -> Option<Tunnel> {
        self.held.lock().unwrap().get(slot).map(|(_, s)| s.clone())
    }
}

#[derive(Default)]
struct FakeFleet {
    seen: Mutex<HashMap<String, i64>>,
    busy: Mutex<HashMap<String, bool>>,
    /// Machines whose catch-up hasn't finished.
    behind: Mutex<std::collections::HashSet<String>>,
    /// The hub hears its other machines.
    others: Mutex<bool>,
}

impl Fleet for FakeFleet {
    fn last_seen(&self, machine: &str) -> Option<i64> {
        self.seen.lock().unwrap().get(machine).copied()
    }
    fn busy(&self, machine: &str) -> Option<bool> {
        self.busy.lock().unwrap().get(machine).copied()
    }
    fn ready(&self, machine: &str) -> bool {
        !self.behind.lock().unwrap().contains(machine)
    }
    fn others_heard(&self, _besides: &[String], _now: i64) -> bool {
        *self.others.lock().unwrap()
    }
}

struct World {
    pool: Arc<Pool>,
    boat: Arc<FakeBoat>,
    tunnels: Arc<FakeTunnels>,
    fleet: Arc<FakeFleet>,
    clock: Arc<ManualClock>,
    db: Arc<HubDb>,
    home: tempfile::TempDir,
}

impl World {
    async fn new() -> World {
        let clock = ManualClock::at(T0);
        let db = HubDb::open_memory().unwrap();
        let home = tempfile::tempdir().unwrap();
        let boat = FakeBoat::new(clock.clone());
        let fleet = Arc::new(FakeFleet::default());
        *fleet.others.lock().unwrap() = true;
        let tunnels = Arc::new(FakeTunnels::default());
        let pool = Pool::new(
            db.clone(),
            home.path().into(),
            boat.clone(),
            tunnels.clone(),
            fleet.clone(),
            clock.clone(),
            chrono_tz::UTC,
        );
        pool.set_key("boat_test_key").unwrap();
        pool.ledger
            .change_settings(&SettingsChange {
                enabled: true,
                pool_size: 3,
                machine_type: "large".into(),
                day_budget: 3.0,
                month_budget: None,
                projects: Vec::new(),
                environment: None,
            })
            .unwrap();
        World {
            pool,
            boat,
            tunnels,
            fleet,
            clock,
            db,
            home,
        }
    }

    /// The pool again over the same ledger and boat: a hub restart (its tunnels went with the old process).
    fn restart(&self) -> Arc<Pool> {
        self.restart_with(Arc::new(FakeTunnels::default()))
    }

    fn restart_with(&self, tunnels: Arc<FakeTunnels>) -> Arc<Pool> {
        Pool::new(
            self.db.clone(),
            self.home.path().into(),
            self.boat.clone(),
            tunnels,
            self.fleet.clone(),
            self.clock.clone(),
            chrono_tz::UTC,
        )
    }

    fn now(&self) -> i64 {
        self.pool.now()
    }

    fn advance(&self, by: Duration) {
        self.clock.advance(by);
    }

    fn hello(&self, slot: &str, busy: Option<bool>) {
        self.fleet
            .seen
            .lock()
            .unwrap()
            .insert(slot.into(), self.now());
        match busy {
            Some(b) => self.fleet.busy.lock().unwrap().insert(slot.into(), b),
            None => self.fleet.busy.lock().unwrap().remove(slot),
        };
    }

    fn state(&self, slot: &str) -> State {
        self.pool.ledger.slot(slot).unwrap().unwrap().state
    }

    fn sandbox(&self, slot: &str) -> String {
        self.pool
            .ledger
            .slot(slot)
            .unwrap()
            .unwrap()
            .sandbox_id
            .unwrap()
    }

    async fn tick(&self) {
        life::tick(&self.pool).await;
    }

    async fn create(&self, slot: &str) {
        let spec = CreateSpec {
            body_until: self.now() + 15 * 60_000,
            ..Default::default()
        };
        self.pool.create(slot, spec).await.unwrap();
    }

    /// A created machine that joined: awake.
    async fn awake(&self, slot: &str) {
        self.create(slot).await;
        self.advance(Duration::from_secs(20));
        self.hello(slot, Some(true));
        self.tick().await;
        assert_eq!(self.state(slot), State::Awake);
    }

    /// An awake machine stopped and seen archived: asleep.
    async fn asleep(&self, slot: &str) {
        self.awake(slot).await;
        self.pool.stop(slot, State::Stopping, "test").await.unwrap();
        self.tick().await;
        assert_eq!(self.state(slot), State::Asleep);
    }

    fn open_spend(&self, slot: &str) -> bool {
        self.pool.ledger.has_open_spend(slot).unwrap()
    }
}

/// Every create, resume and stop finds its row (and, for a start, its counted start and running meter) already in
/// the ledger.
#[tokio::test]
async fn the_ledger_is_written_before_every_call() {
    let w = World::new().await;
    let ledger = w.pool.ledger.clone();
    let clock = w.clock.clone();
    *w.boat.probe.lock().unwrap() = Some(Box::new(move || {
        let now = crate::hub::store::now_ms(clock.as_ref());
        let row = ledger.slot("boat-1").unwrap().unwrap();
        let starts = ledger.starts_in(super::ledger::Window::Day, now).unwrap().0;
        let spend = ledger.has_open_spend("boat-1").unwrap();
        format!("{} {starts} starts spend {spend}", row.state.as_str())
    }));
    w.asleep("boat-1").await;
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    let probes = w.boat.s.lock().unwrap().probes.clone();
    assert_eq!(
        probes,
        [
            "create boat-1: creating 1 starts spend true",
            format!("stop {}: stopping 1 starts spend true", w.sandbox("boat-1")).as_str(),
            format!(
                "resume {} 1800: waking 2 starts spend true",
                w.sandbox("boat-1")
            )
            .as_str(),
        ]
    );
    // The create went out labelled for this hub, its slot and its attempt, under the attempt's key.
    let s = w.pool.ledger.settings().unwrap();
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    let sb = &w.boat.s.lock().unwrap().machines[&w.sandbox("boat-1")];
    assert_eq!(sb.label(LABEL_HUB), Some(s.hub_id.as_str()));
    assert_eq!(sb.label(LABEL_SLOT), Some("boat-1"));
    assert_eq!(sb.label(LABEL_ATTEMPT), row.idem_key.as_deref());
    // Its body (it held the enroll token) is gone once boat answered.
    assert_eq!(row.create_body, None);
}

#[tokio::test]
async fn an_idle_machine_stops_after_15_minutes_and_sleeps() {
    let w = World::new().await;
    w.awake("boat-1").await;
    let id = w.sandbox("boat-1");
    w.hello("boat-1", Some(false));
    w.tick().await; // idle from now
    w.advance(14 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    // Busy again resets the grace.
    w.hello("boat-1", Some(true));
    w.tick().await;
    w.advance(14 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    w.advance(14 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    w.advance(MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    assert_eq!(w.boat.calls_like("stop"), [format!("stop {id}")]);
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Asleep);
    assert!(
        !w.open_spend("boat-1"),
        "the meter closes when boat says archived"
    );
}

/// A placement's claim holds off the idle stop, and the idle stop's write makes a later claim fail.
#[tokio::test]
async fn a_claim_holds_off_the_idle_stop() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.hello("boat-1", Some(false));
    w.tick().await;
    w.advance(16 * MIN);
    w.hello("boat-1", Some(false));
    assert!(w.pool.claim("boat-1"));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    w.advance(3 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await; // idle starts again after the claim
    w.advance(16 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    assert!(!w.pool.claim("boat-1"));
}

/// A node that sends no busy flag counts as busy: never stopped as idle (the lease and budget still bound it).
#[tokio::test]
async fn a_node_without_the_busy_flag_is_never_idle() {
    let w = World::new().await;
    w.awake("boat-1").await;
    for _ in 0..4 {
        w.hello("boat-1", None);
        w.advance(10 * MIN);
        w.tick().await;
    }
    assert_eq!(w.state("boat-1"), State::Awake);
}

/// While wanted, the lease is renewed every 10 minutes to 30 minutes ahead; boat's deadline is never more than 30
/// minutes out. A hub that stops renewing (dead, stalled) has boat stop the machine itself at that deadline.
#[tokio::test]
async fn the_lease_is_renewed_every_10_minutes_and_boat_stops_a_machine_whose_hub_went_quiet() {
    let w = World::new().await;
    w.awake("boat-1").await;
    let id = w.sandbox("boat-1");
    assert!(w.boat.calls_like("ttl").is_empty());
    let mut renewed = Vec::new();
    for _ in 0..6 {
        w.advance(5 * MIN);
        w.hello("boat-1", Some(true));
        w.tick().await;
        if w.boat.calls_like("ttl").len() > renewed.len() {
            renewed.push(w.now());
        }
    }
    // Every 10 minutes from the create, whose setup lease was 30 minutes too.
    let t = |m: u64| (T0 + 20_000 + m * 60_000) as i64;
    assert_eq!(renewed, [t(10), t(20), t(30)]);
    assert!(
        w.boat
            .calls_like("ttl")
            .iter()
            .all(|c| c.ends_with(" 1800"))
    );
    let deadline = w.boat.s.lock().unwrap().machines[&id]
        .archive_after_ms()
        .unwrap();
    assert_eq!(deadline, t(60));
    // The hub goes quiet: no more ticks. boat stops it at the deadline, by itself.
    w.advance(29 * MIN);
    w.boat.expire();
    assert_eq!(w.boat.state(&id).as_deref(), Some("running"));
    w.advance(MIN);
    w.boat.expire();
    assert_eq!(w.boat.state(&id).as_deref(), Some("archived"));
    // The hub back: its sweep sees boat stopped it.
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.state("boat-1"), State::Asleep);
    assert!(!w.open_spend("boat-1"));
}

/// The lease never outlasts the budget at the pool's burn rate: a second machine starting re-sends a shorter lease at
/// once, and when the lease would be a minute or less the machine is stopped and no start is allowed.
#[tokio::test]
async fn the_budget_shortens_the_lease_then_stops_the_machine() {
    let w = World::new().await;
    let mut change = SettingsChange {
        enabled: true,
        pool_size: 3,
        machine_type: "large".into(),
        day_budget: 0.024, // 20 minutes of one large machine
        month_budget: None,
        projects: Vec::new(),
        environment: None,
    };
    w.pool.ledger.change_settings(&change).unwrap();
    w.awake("boat-1").await;
    let id = w.sandbox("boat-1");
    // Created with the budget's 20 minutes, not the setup's 45.
    let created = w.boat.s.lock().unwrap().machines[&id].ttl_seconds;
    assert_eq!(created, Some(1200));
    // A second machine doubles the burn: boat-1's lease is cut at once.
    w.advance(Duration::from_secs(40));
    w.create("boat-2").await;
    w.advance(Duration::from_secs(40));
    w.hello("boat-1", Some(true));
    w.tick().await;
    let cut: u32 = w
        .boat
        .calls_like("ttl")
        .last()
        .unwrap()
        .rsplit(' ')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!((500..=560).contains(&cut), "{cut}");
    // About 570 s in, a minute or less is left at the burn rate: stopped.
    w.advance(Duration::from_secs(480));
    w.hello("boat-1", Some(true));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    assert_eq!(w.boat.calls_like("stop"), [format!("stop {id}")]);
    w.tick().await;
    assert_eq!(
        w.pool.wake("boat-1", Why::Need).await.unwrap_err(),
        "cloud paused: too little budget left to start a machine"
    );
    assert!(w.boat.calls_like("resume").is_empty());
    // Spent: the line says so.
    w.advance(10 * MIN);
    let held = w.pool.start_held().unwrap();
    assert!(
        held.starts_with("cloud paused: today's boat.dev budget ($0.02) is spent"),
        "{held}"
    );
    // A bigger budget lets it start again.
    change.day_budget = 3.0;
    w.pool.ledger.change_settings(&change).unwrap();
    w.pool.wake("boat-1", Why::Need).await.unwrap();
}

/// boat's own cost, when higher than the meter, is what the budget counts.
#[tokio::test]
async fn the_meter_takes_boats_cost_when_it_is_higher() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.advance(10 * MIN);
    let s = w.pool.ledger.settings().unwrap();
    let ours = w.pool.budget(&s, w.now()).unwrap().day_spent;
    assert!((0.012..0.0125).contains(&ours), "{ours}");
    w.boat
        .s
        .lock()
        .unwrap()
        .usage
        .insert(w.sandbox("boat-1"), 0.5);
    w.hello("boat-1", Some(true));
    sweep::sweep(&w.pool).await.unwrap();
    let b = w.pool.budget(&s, w.now()).unwrap();
    assert_eq!(b.day_spent, 0.5);
    assert_eq!(b.month_spent, 0.5);
    assert_eq!(
        b.month_budget, 20.0,
        "the month budget defaults to the plan's included dollars"
    );
}

#[tokio::test]
async fn a_machine_whose_node_vanished_is_stopped_unless_the_hub_hears_nobody() {
    let w = World::new().await;
    w.awake("boat-1").await;
    // The hub itself stalled: every node looks silent. Nothing is stopped for it.
    *w.fleet.others.lock().unwrap() = false;
    w.advance(11 * MIN);
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    // Others heard normally: the silent one is stopped.
    *w.fleet.others.lock().unwrap() = true;
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!(
        row.note.as_deref(),
        Some("its node went silent for 10 minutes")
    );
    assert_eq!(row.wake_failures, 0, "a vanished node is no wake failure");
}

/// A wake with no hello in 2 minutes is stopped and counted; two in a row make the slot broken, never woken again.
#[tokio::test]
async fn two_wakes_without_a_hello_make_the_slot_broken() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    for round in 1..=2 {
        w.pool.wake("boat-1", Why::Need).await.unwrap();
        assert_eq!(w.state("boat-1"), State::Waking);
        w.advance(MIN + MIN / 2);
        w.tick().await;
        assert_eq!(w.state("boat-1"), State::Waking);
        w.advance(MIN);
        w.tick().await;
        let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
        assert_eq!(row.wake_failures, round);
        w.tick().await;
        w.advance(MIN);
    }
    assert_eq!(w.state("boat-1"), State::Broken);
    assert!(w.boat.running().is_empty());
    assert!(!w.open_spend("boat-1"));
    let e = w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        e,
        "boat-1 doesn't come back: Reset it in Settings › Hub › Machines"
    );
    assert_eq!(w.boat.calls_like("resume").len(), 2);
}

/// A hello resets the count.
#[tokio::test]
async fn a_hello_clears_the_wake_failures() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    w.advance(3 * MIN);
    w.tick().await;
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Asleep);
    w.advance(MIN);
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    w.advance(MIN);
    w.hello("boat-1", Some(true));
    w.tick().await;
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!((row.state, row.wake_failures), (State::Awake, 0));
}

/// The kill switch lists boat itself: it stops this hub's machines the ledger knows, and one it doesn't, but never
/// another hub's. Each sweep stops them again while the pool is off.
#[tokio::test]
async fn the_kill_switch_stops_every_machine_boat_lists_with_this_hubs_label() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.awake("boat-2").await;
    let hub = w.pool.ledger.settings().unwrap().hub_id;
    w.boat.plant(
        "bx_orphan01",
        &[(LABEL_HUB, &hub), (LABEL_SLOT, "boat-9")],
        "running",
    );
    w.boat.plant(
        "bx_another1",
        &[(LABEL_HUB, "someoneelse"), (LABEL_SLOT, "boat-1")],
        "running",
    );
    let kill = w.pool.kill().await.unwrap();
    let mut stopped = kill.stopped.clone();
    stopped.sort();
    assert_eq!(stopped, ["boat-1", "boat-2", "bx_orphan01"]);
    assert!(kill.failed.is_empty() && kill.unlisted.is_none());
    assert_eq!(w.boat.running(), ["bx_another1"]);
    assert!(!w.pool.ledger.settings().unwrap().enabled);
    assert_eq!(
        w.pool.start_held().as_deref(),
        Some("cloud machines are off")
    );
    // A racing call woke boat-1 again: the next sweep stops it.
    w.boat
        .s
        .lock()
        .unwrap()
        .machines
        .get_mut(&w.sandbox("boat-1"))
        .unwrap()
        .state = "running".into();
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.boat.running(), ["bx_another1"]);
}

#[tokio::test]
async fn the_kill_switch_stops_the_ledgers_machines_when_boats_list_is_down() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.boat.s.lock().unwrap().list_down = true;
    let kill = w.pool.kill().await.unwrap();
    assert_eq!(kill.stopped, ["boat-1"]);
    assert_eq!(
        kill.unlisted.as_deref(),
        Some("boat.dev unreachable, retrying")
    );
    assert!(w.boat.running().is_empty());
}

/// A hub restart: the new process places nothing until its sweep has run; the sweep reconciles what boat runs with the
/// ledger, and renewal simply resumes.
#[tokio::test]
async fn after_a_hub_restart_the_sweep_runs_before_any_placement() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.asleep("boat-2").await;
    // boat-2 runs at boat though the ledger says asleep (a resume whose answer was lost before the crash).
    let id2 = w.sandbox("boat-2");
    w.boat
        .s
        .lock()
        .unwrap()
        .machines
        .get_mut(&id2)
        .unwrap()
        .state = "running".into();
    let pool = w.restart();
    assert!(!pool.ready());
    // boat down at start: still not ready; only cloud placement waits.
    w.boat.refuse("limits", BoatError::Network("reset".into()));
    assert!(sweep::sweep(&pool).await.is_err());
    assert!(!pool.ready());
    sweep::sweep(&pool).await.unwrap();
    assert!(pool.ready());
    assert_eq!(
        w.boat.state(&id2).as_deref(),
        Some("archived"),
        "running while asleep in the ledger: stopped"
    );
    assert_eq!(
        w.boat.state(&w.sandbox("boat-1")).as_deref(),
        Some("running"),
        "awake: kept"
    );
    let before = w.boat.calls_like("ttl").len();
    w.advance(11 * MIN);
    w.hello("boat-1", Some(true));
    life::tick(&pool).await;
    assert_eq!(
        w.boat.calls_like("ttl").len(),
        before + 1,
        "renewal resumes"
    );
}

/// The sweep, row by row (§4's table).
#[tokio::test]
async fn the_sweep_reconciles_boat_with_the_ledger() {
    let w = World::new().await;
    let hub = w.pool.ledger.settings().unwrap().hub_id;
    w.awake("boat-1").await;
    w.asleep("boat-2").await;
    // An orphan with this hub's label, a stopped orphan, and another hub's machine.
    w.boat.plant(
        "bx_orphan01",
        &[(LABEL_HUB, &hub), (LABEL_SLOT, "boat-7")],
        "running",
    );
    w.boat.plant(
        "bx_orphan02",
        &[(LABEL_HUB, &hub), (LABEL_SLOT, "boat-8")],
        "archived",
    );
    w.boat
        .plant("bx_another1", &[(LABEL_HUB, "someoneelse")], "running");
    // boat lost boat-2's machine.
    let id2 = w.sandbox("boat-2");
    w.boat.s.lock().unwrap().machines.remove(&id2);
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(
        w.boat.state("bx_orphan01").as_deref(),
        Some("archived"),
        "stopped first"
    );
    assert_eq!(
        w.boat.state("bx_orphan02"),
        None,
        "a stopped orphan is deleted"
    );
    assert_eq!(
        w.boat.state("bx_another1").as_deref(),
        Some("running"),
        "another hub's: untouched"
    );
    assert!(!w.boat.calls().iter().any(|c| c.contains("bx_another1")));
    assert_eq!(w.state("boat-2"), State::Gone);
    assert_eq!(w.state("boat-1"), State::Awake);
    // The next sweep deletes the now-stopped orphan.
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.boat.state("bx_orphan01"), None);
    // boat ran a machine 3 minutes past its deadline: stopped.
    let id1 = w.sandbox("boat-1");
    w.boat
        .s
        .lock()
        .unwrap()
        .machines
        .get_mut(&id1)
        .unwrap()
        .archive_after = Some(iso(w.now() - 3 * 60_000));
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.boat.state(&id1).as_deref(), Some("archived"));
}

/// A create whose answer was lost: found by its attempt label first; with no machine found, its sealed body goes again
/// under the same key while its token lives (boat makes no second machine); after, the slot fails.
#[tokio::test]
async fn a_lost_create_is_looked_up_by_its_attempt_before_any_retry() {
    let w = World::new().await;
    // boat made it, but the answer was lost.
    w.boat
        .s
        .lock()
        .unwrap()
        .refuse
        .push_back(("create", BoatError::Network("reset".into())));
    let spec = CreateSpec {
        body_until: w.now() + 15 * 60_000,
        ..Default::default()
    };
    assert!(w.pool.create("boat-1", spec.clone()).await.is_err());
    assert_eq!(w.state("boat-1"), State::Creating);
    assert!(
        w.pool
            .ledger
            .slot("boat-1")
            .unwrap()
            .unwrap()
            .create_body
            .is_some()
    );
    // The refusal came before boat made anything: nothing to find, so the sealed body goes again, same key.
    w.advance(MIN);
    sweep::sweep(&w.pool).await.unwrap();
    let creates = w.boat.calls_like("create");
    assert_eq!(creates.len(), 2);
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert!(row.sandbox_id.is_some() && row.create_body.is_none());
    assert_eq!(w.boat.s.lock().unwrap().machines.len(), 1);
    assert_eq!(w.boat.s.lock().unwrap().idem.len(), 1, "one key, one body");

    // boat-2: made at boat, answer lost after: the sweep adopts it by its attempt label and sends nothing again.
    let probe_boat = w.boat.clone();
    w.create("boat-2").await;
    let row2 = w.pool.ledger.slot("boat-2").unwrap().unwrap();
    let mut lost = row2.clone();
    lost.sandbox_id = None;
    w.pool.ledger.put(&lost).unwrap();
    let before = probe_boat.calls_like("create").len();
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(
        w.pool.ledger.slot("boat-2").unwrap().unwrap().sandbox_id,
        row2.sandbox_id
    );
    assert_eq!(probe_boat.calls_like("create").len(), before);

    // boat-3: no answer, nothing made, and its token ended: failed, never re-sent.
    w.boat
        .s
        .lock()
        .unwrap()
        .refuse
        .push_back(("create", BoatError::Network("reset".into())));
    let spec = CreateSpec {
        body_until: w.now() + 60_000,
        ..Default::default()
    };
    assert!(w.pool.create("boat-3", spec).await.is_err());
    w.advance(2 * MIN);
    let before = w.boat.calls_like("create").len();
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.boat.calls_like("create").len(), before);
    assert_eq!(w.state("boat-3"), State::Failed);
    assert!(!w.open_spend("boat-3"));
}

/// A create that never says hello within 15 minutes is deleted (billing ends at once) and failed, with boat's setup
/// error.
#[tokio::test]
async fn a_create_that_never_joins_is_deleted() {
    let w = World::new().await;
    w.create("boat-1").await;
    let id = w.sandbox("boat-1");
    w.boat
        .s
        .lock()
        .unwrap()
        .machines
        .get_mut(&id)
        .unwrap()
        .setup_error = Some("exit 1: fleetd join refused".into());
    w.advance(16 * MIN);
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Failed);
    assert_eq!(w.boat.state(&id), None);
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!(
        row.note.as_deref(),
        Some("its setup failed: exit 1: fleetd join refused")
    );
    assert!(!w.open_spend("boat-1"));
}

/// fleetd allows itself half of each included window; a full window holds starts with a plain line until it frees.
#[tokio::test]
async fn the_start_budget_holds_starts_at_half_of_boats_included() {
    let w = World::new().await;
    w.boat.s.lock().unwrap().limits.start_limits = Some(StartLimits {
        per_minute: 4,
        per_hour: 60,
        per_day: 200,
    });
    w.asleep("boat-1").await; // 1 start (create), and /limits read: 2 a minute allowed
    w.asleep("boat-2").await; // 2
    let held = w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        held,
        "fleetd's boat.dev start budget is used (2 of 2 this minute): next start at 10:01"
    );
    assert!(w.boat.calls_like("resume").is_empty());
    w.advance(MIN);
    w.pool.wake("boat-1", Why::Need).await.unwrap();
}

/// The pre-flight: no start unless boat says it can start at no cost; fleetd never buys an extra start.
#[tokio::test]
async fn the_preflight_never_buys_an_extra_start() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.boat.s.lock().unwrap().limits.next_start_dollars = Some(0.03);
    let e = w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        e,
        "boat.dev's included starts are used: fleetd never buys an extra start"
    );
    assert!(w.boat.calls_like("resume").is_empty());
}

/// Each refusal backs off its own way; a start boat clearly didn't count is uncounted; billing pauses bursting until a
/// sweep sees boat can start again.
#[tokio::test]
async fn starts_back_off_on_every_boat_code() {
    let w = World::new().await;
    w.awake("boat-2").await;
    w.asleep("boat-1").await;
    // no_ready_machine: uncounted, the machine left asleep, no start for 5 s.
    w.boat.refuse("resume", BoatError::NoReadyMachine);
    let e = w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(e, "boat.dev is short of machines, retrying");
    assert_eq!(w.state("boat-1"), State::Asleep);
    assert!(!w.open_spend("boat-1"));
    assert_eq!(
        w.pool
            .ledger
            .starts_in(super::ledger::Window::Day, w.now())
            .unwrap()
            .0,
        2,
        "only the creates count"
    );
    assert_eq!(
        w.pool.start_held().as_deref(),
        Some("boat.dev is short of machines, retrying")
    );
    w.advance(Duration::from_secs(6));
    assert_eq!(w.pool.start_held(), None);
    // rate_limited: not before boat's next start.
    let next = w.now() + 90_000;
    w.boat.refuse(
        "resume",
        BoatError::RateLimited {
            next_start_at: Some(next),
            retry_after_s: None,
        },
    );
    w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        w.pool.start_held().as_deref(),
        Some("boat.dev start limit: next start at 10:02")
    );
    w.advance(Duration::from_secs(91));
    // limit_reached: full until one of ours stops.
    w.boat.refuse("resume", BoatError::LimitReached);
    w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        w.pool.start_held().as_deref(),
        Some("boat.dev: machines-at-once limit reached")
    );
    // One of ours stops: room again.
    w.pool
        .stop("boat-2", State::Stopping, "test")
        .await
        .unwrap();
    w.tick().await;
    assert_eq!(w.pool.start_held(), None);
    // billing: paused until a sweep's /limits says it can start.
    w.boat.refuse(
        "resume",
        BoatError::Billing {
            code: "billing_required".into(),
            url: None,
        },
    );
    w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        w.pool.start_held().as_deref(),
        Some("boat.dev needs billing attention: Settings › Hub › Machines")
    );
    w.boat.s.lock().unwrap().limits.can_start = false;
    sweep::sweep(&w.pool).await.unwrap();
    assert!(w.pool.start_held().is_some());
    w.boat.s.lock().unwrap().limits.can_start = true;
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.pool.start_held(), None);
    // A key refused at boat pauses too.
    w.boat.refuse(
        "limits",
        BoatError::KeyRefused {
            code: "api_key_expired".into(),
        },
    );
    w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        w.pool.start_held().as_deref(),
        Some("boat.dev key refused: Settings › Hub › Machines")
    );
    w.pool.resume_bursting().unwrap();
    w.pool.wake("boat-1", Why::Need).await.unwrap();
}

/// A slot asleep 12 days is woken by the sweep (boat keeps a stopped disk 14), and stops 5 minutes after its node is
/// idle.
#[tokio::test]
async fn a_slot_asleep_12_days_gets_a_keepalive_wake() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.advance(Duration::from_secs(11 * 86_400));
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.state("boat-1"), State::Asleep);
    w.advance(Duration::from_secs(86_400));
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.state("boat-1"), State::Waking);
    w.advance(MIN);
    w.hello("boat-1", Some(false));
    w.tick().await; // awake
    w.tick().await; // idle from now
    w.advance(5 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    w.tick().await;
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!(row.state, State::Asleep);
    assert_eq!(
        row.asleep_since,
        Some(w.now()),
        "its 12 days count again from now"
    );
}

/// Turning the pool off stops an awake machine at the life loop's next step, too.
#[tokio::test]
async fn an_awake_machine_stops_when_the_pool_is_turned_off() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.pool.ledger.set_enabled(false).unwrap();
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    assert!(w.boat.running().is_empty());
}

/// Only the machine boat says is stopped is resumed: one already running is taken as waking, with no start.
#[tokio::test]
async fn a_resume_goes_only_after_a_get_saw_it_stopped() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    let id = w.sandbox("boat-1");
    w.boat
        .s
        .lock()
        .unwrap()
        .machines
        .get_mut(&id)
        .unwrap()
        .state = "running".into();
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    assert!(w.boat.calls_like("resume").is_empty());
    assert_eq!(w.state("boat-1"), State::Waking);
    // Two wakes at once: one resume.
    let w2 = World::new().await;
    w2.asleep("boat-1").await;
    let (a, b) = tokio::join!(
        w2.pool.wake("boat-1", Why::Need),
        w2.pool.wake("boat-1", Why::Need)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(w2.boat.calls_like("resume").len(), 1);
}

/// boat expired a long-stopped disk: the slot is gone, its machine needs a new create.
#[tokio::test]
async fn an_expired_disk_leaves_the_slot_gone() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.boat.refuse("resume", BoatError::DataExpired);
    let e = w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(e, "boat.dev deleted the stopped machine's disk");
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!((row.state, row.sandbox_id), (State::Gone, None));
}

/// The hub's boat key is kept sealed to the hub's box key, never in the clear.
#[tokio::test]
async fn the_boat_key_is_sealed_to_the_hub() {
    let w = World::new().await;
    let sealed = w.pool.ledger.sealed_key().unwrap().unwrap();
    assert!(!sealed.windows(13).any(|win| win == b"boat_test_key"));
    assert_eq!(
        super::open_key(&w.pool.ledger, w.home.path())
            .unwrap()
            .as_str(),
        "boat_test_key"
    );
    let other = tempfile::tempdir().unwrap();
    assert!(matches!(
        super::open_key(&w.pool.ledger, other.path()),
        Err(BoatError::NoKey(_))
    ));
}

/// A machine that said hello but hasn't caught up (an update or the hub's Claude configuration failed) isn't awake for
/// work: no claim, and its wake times out like one with no hello.
#[tokio::test]
async fn a_machine_is_awake_only_once_it_caught_up() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    w.fleet.behind.lock().unwrap().insert("boat-1".into());
    w.advance(MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Waking);
    assert!(!w.pool.claim("boat-1"));
    // Caught up: awake, and claimable.
    w.fleet.behind.lock().unwrap().clear();
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    assert!(w.pool.claim("boat-1"));
    // Its node restarted and catches up again: no claim meanwhile.
    w.fleet.behind.lock().unwrap().insert("boat-1".into());
    assert!(!w.pool.claim("boat-1"));
    // A wake that never catches up counts as a wake failure.
    w.pool
        .stop("boat-1", State::Stopping, "test")
        .await
        .unwrap();
    w.tick().await;
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    w.advance(MIN);
    w.hello("boat-1", Some(false));
    w.advance(5 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(
        w.pool.ledger.slot("boat-1").unwrap().unwrap().wake_failures,
        1
    );
}

/// A refused wake (routine with failFast) leaves the machine's 12 days counting from when it really went to sleep, so
/// the keepalive is tried again at the next sweep, not 12 days later after boat expired the disk.
#[tokio::test]
async fn a_refused_wake_keeps_the_keepalive_count() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    let slept = w.pool.ledger.slot("boat-1").unwrap().unwrap().asleep_since;
    w.advance(Duration::from_secs(12 * 86_400));
    w.boat.refuse("resume", BoatError::NoReadyMachine);
    sweep::sweep(&w.pool).await.unwrap();
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!((row.state, row.asleep_since), (State::Asleep, slept));
    // The next sweep, past the backoff, tries again.
    w.advance(10 * MIN);
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.state("boat-1"), State::Waking);
    assert_eq!(w.boat.calls_like("resume").len(), 2);
}

/// boat's machines-at-once limit, filled by machines outside the pool while none of ours runs: the sweep lifts the
/// hold once /limits shows room again, so bursting isn't held for good.
#[tokio::test]
async fn the_machines_at_once_hold_lifts_when_boat_has_room() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.boat.plant("bx_persons1", &[("mine", "yes")], "running");
    w.boat.s.lock().unwrap().limits.max_active_sandboxes = 1;
    w.boat.refuse("resume", BoatError::LimitReached);
    w.pool.wake("boat-1", Why::Need).await.unwrap_err();
    assert_eq!(
        w.pool.start_held().as_deref(),
        Some("boat.dev: machines-at-once limit reached")
    );
    // Still full at boat: held.
    sweep::sweep(&w.pool).await.unwrap();
    assert!(w.pool.start_held().is_some());
    // The person's own machine stops: room, and the hold lifts with no machine of ours stopping.
    w.boat
        .s
        .lock()
        .unwrap()
        .machines
        .get_mut("bx_persons1")
        .unwrap()
        .state = "archived".into();
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.pool.start_held(), None);
    w.pool.wake("boat-1", Why::Need).await.unwrap();
}

/// Waits for the wakes placement spawned to come back from boat.
async fn wakes_back(w: &World) {
    for _ in 0..200 {
        if w.pool.waking.lock().unwrap().is_empty() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("a wake for work never came back");
}

/// Placement's wakes (D306): one machine at a time, the first asleep in slot order, and another only once that one is
/// awake (and so, when placement asks, full); a follow-up wakes its own machine whatever else is waking.
#[tokio::test]
async fn placement_wakes_one_machine_at_a_time_and_a_follow_up_its_own() {
    let w = World::new().await;
    for slot in ["boat-1", "boat-2", "boat-3"] {
        w.asleep(slot).await;
    }
    w.advance(MIN);
    assert_eq!(
        w.pool.closed().as_deref(),
        Some("cloud machines wait for the hub's first check of boat.dev")
    );
    w.pool
        .ready
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(w.pool.closed(), None);
    assert!(w.pool.awake().is_empty());
    assert_eq!(w.pool.wake_for_work(None).unwrap(), "boat-1");
    assert_eq!(
        w.pool.wake_for_work(None).unwrap(),
        "boat-1",
        "one at a time"
    );
    wakes_back(&w).await;
    assert_eq!(w.state("boat-1"), State::Waking);
    assert_eq!(w.pool.wake_for_work(None).unwrap(), "boat-1");
    assert_eq!(w.boat.calls_like("resume").len(), 1);
    assert_eq!(w.pool.wake_for_work(Some("boat-3")).unwrap(), "boat-3");
    wakes_back(&w).await;
    assert_eq!(w.state("boat-3"), State::Waking);
    w.advance(MIN);
    w.hello("boat-1", Some(true));
    w.hello("boat-3", Some(true));
    w.tick().await;
    assert_eq!(w.pool.awake(), ["boat-1", "boat-3"]);
    assert_eq!(w.pool.wake_for_work(None).unwrap(), "boat-2");
    wakes_back(&w).await;
    assert_eq!(w.boat.calls_like("resume").len(), 3);
    // An awake machine is its follow-ups' at once; a broken one never wakes.
    assert_eq!(w.pool.wake_for_work(Some("boat-1")).unwrap(), "boat-1");
    assert_eq!(w.boat.calls_like("resume").len(), 3);
    let mut row = w.pool.ledger.slot("boat-2").unwrap().unwrap();
    row.state = State::Broken;
    w.pool.ledger.put(&row).unwrap();
    assert_eq!(
        w.pool.wake_for_work(Some("boat-2")).unwrap_err(),
        "boat-2 doesn't come back: Reset it in Settings › Hub › Machines"
    );
}

/// No machine wakes for work past fleetd's start budget or the money budget, each with its one line; a spent budget
/// also keeps new work off a machine that is awake.
#[tokio::test]
async fn no_machine_wakes_for_work_past_the_start_budget_or_the_money_budget() {
    let w = World::new().await;
    w.boat.s.lock().unwrap().limits.start_limits = Some(StartLimits {
        per_minute: 4,
        per_hour: 60,
        per_day: 200,
    });
    w.asleep("boat-1").await;
    w.awake("boat-2").await; // 2 starts: the minute's 2 are used
    w.pool
        .ready
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(w.pool.awake(), ["boat-2"]);
    let held = w.pool.wake_for_work(None).unwrap_err();
    assert!(
        held.starts_with("fleetd's boat.dev start budget is used (2 of 2 this minute)"),
        "{held}"
    );
    assert_eq!(w.pool.closed(), None, "an awake machine still takes work");
    w.pool
        .ledger
        .change_settings(&SettingsChange {
            enabled: true,
            pool_size: 3,
            machine_type: "large".into(),
            day_budget: 0.0,
            month_budget: None,
            projects: Vec::new(),
            environment: None,
        })
        .unwrap();
    w.advance(MIN);
    let spent = w.pool.wake_for_work(None).unwrap_err();
    assert!(
        spent.starts_with("cloud paused: today's boat.dev budget ($0.00) is spent"),
        "{spent}"
    );
    assert_eq!(w.pool.closed(), Some(spent));
    wakes_back(&w).await;
    assert!(w.boat.calls_like("resume").is_empty());
}

/// The admin's Test asks boat for its limits and this hub's machines, says it in one line, and starts nothing; a
/// refused key says why in plain words, and a new key is untested again.
#[tokio::test]
async fn test_reads_limits_and_the_list_and_starts_nothing() {
    use super::boat::MachineType;
    let w = World::new().await;
    w.boat.s.lock().unwrap().limits.machine_types = vec![MachineType {
        kind: "large".into(),
        available: true,
        reason: None,
    }];
    assert_eq!(w.pool.key_test(), None);
    let t = w.pool.test().await;
    assert!(t.ok, "{t:?}");
    assert_eq!(
        t.said,
        "Key works · $20 plan · 200 starts a day (12 a minute) · 0 of 100 machines running · large allowed"
    );
    assert_eq!(w.boat.calls(), ["limits", "list"]);
    assert_eq!(w.pool.key_test(), Some(t));

    w.boat.refuse(
        "list",
        BoatError::KeyRefused {
            code: "api_key_action_forbidden".into(),
        },
    );
    let t = w.pool.test().await;
    assert!(!t.ok);
    assert!(
        t.said.contains("account.read and sandbox.read"),
        "{}",
        t.said
    );
    assert_eq!(w.pool.key_test().map(|t| t.ok), Some(false));

    w.pool.set_key("boat_other").unwrap();
    assert_eq!(w.pool.key_test(), None);
    assert!(
        w.boat.calls_like("create").is_empty() && w.boat.calls_like("resume").is_empty(),
        "Test never starts a machine"
    );
}

/// The sweep's /limits keeps the key's line fresh; boat being down says nothing about the key.
#[tokio::test]
async fn the_sweep_keeps_what_boat_said_to_the_key() {
    let w = World::new().await;
    sweep::sweep(&w.pool).await.unwrap();
    assert_eq!(w.pool.key_test().map(|t| t.ok), Some(true));
    w.boat.refuse("limits", BoatError::Network("reset".into()));
    sweep::sweep(&w.pool).await.unwrap_err();
    assert_eq!(w.pool.key_test().map(|t| t.ok), Some(true));
    w.boat.refuse(
        "limits",
        BoatError::KeyRefused {
            code: "api_key_expired".into(),
        },
    );
    sweep::sweep(&w.pool).await.unwrap_err();
    let t = w.pool.key_test().unwrap();
    assert!(!t.ok);
    assert!(t.said.contains("expired"), "{}", t.said);
}

/// The settings an admin may save: a pool of 1 to 10 of a size boat sells, budgets above 0 within the guard, and an
/// environment name boat takes.
#[tokio::test]
async fn settings_are_checked_before_they_are_saved() {
    use fleetd_contracts::cloud::CloudSettings;
    use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
    let w = World::new().await;
    let ok = CloudSettings {
        enabled: true,
        pool_size: 2,
        machine_type: "large".into(),
        day_budget: 5.0,
        month_budget: None,
        projects: vec![ProjectRef {
            machine_id: MachineId::new("devbox").unwrap(),
            project_id: ProjectId::new("shop").unwrap(),
        }],
        environment: Some(" fleetd-devbox ".into()),
        writers: Some(true),
    };
    w.pool.apply(&ok).unwrap();
    let s = w.pool.ledger.settings().unwrap();
    assert_eq!((s.pool_size, s.day_budget), (2, 5.0));
    assert_eq!(s.environment.as_deref(), Some("fleetd-devbox"));
    assert_eq!(s.projects.len(), 1);
    assert!(s.writers);
    assert_eq!(
        s.month_budget(),
        20.0,
        "the plan's dollars when none is set"
    );

    let bad = |change: &dyn Fn(&mut CloudSettings)| {
        let mut c = ok.clone();
        change(&mut c);
        w.pool.apply(&c).unwrap_err()
    };
    assert_eq!(bad(&|c| c.pool_size = 0), "A pool holds 1 to 10 machines.");
    assert_eq!(bad(&|c| c.pool_size = 11), "A pool holds 1 to 10 machines.");
    assert!(bad(&|c| c.machine_type = "huge".into()).starts_with("boat.dev has no size huge"));
    assert!(bad(&|c| c.day_budget = 0.0).starts_with("The day budget"));
    assert!(bad(&|c| c.day_budget = f64::NAN).starts_with("The day budget"));
    assert!(bad(&|c| c.month_budget = Some(5000.0)).starts_with("The month budget"));
    assert!(bad(&|c| c.environment = Some("fleetd devbox".into())).contains("environment name"));
    // Nothing bad was saved.
    assert_eq!(w.pool.ledger.settings().unwrap().pool_size, 2);
}

/// Create makes the slots the pool's size wants that have no machine; Reset deletes a broken one at boat and leaves
/// it to be made again; the view shows each machine's state, what runs there and its spend today.
#[tokio::test]
async fn reset_deletes_a_broken_machine_and_the_view_shows_each_one() {
    use fleetd_contracts::cloud::CloudMachineState;
    use fleetd_contracts::node_link::NodeBusy;
    let w = World::new().await;
    assert_eq!(w.pool.missing().unwrap(), ["boat-1", "boat-2", "boat-3"]);
    w.awake("boat-1").await;
    w.asleep("boat-2").await;
    assert_eq!(w.pool.missing().unwrap(), ["boat-3"]);

    w.advance(10 * MIN);
    let machines = w
        .pool
        .machines(|slot| {
            (slot == "boat-1").then_some(NodeBusy {
                threads: 2,
                screens: 1,
                ..Default::default()
            })
        })
        .unwrap();
    let got: Vec<_> = machines
        .iter()
        .map(|m| {
            (
                m.machine_id.as_str().to_owned(),
                m.state,
                m.agents,
                m.screens,
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("boat-1".into(), CloudMachineState::Awake, 2, 1),
            ("boat-2".into(), CloudMachineState::Asleep, 0, 0),
        ]
    );
    // boat-1 has run about 10 minutes at $0.072 an hour.
    assert!(
        (machines[0].today - 0.072 / 6.0).abs() < 0.002,
        "{}",
        machines[0].today
    );

    // A broken machine: Reset deletes it at boat, and it needs a create again.
    w.pool
        .stop("boat-2", State::Broken, "no hello after two wakes")
        .await
        .unwrap();
    let id = w.sandbox("boat-2");
    w.pool.retire("boat-2").await.unwrap();
    assert_eq!(w.boat.state(&id), None, "deleted at boat");
    assert_eq!(w.state("boat-2"), State::Gone);
    assert_eq!(w.pool.missing().unwrap(), ["boat-2", "boat-3"]);
    assert!(!w.open_spend("boat-2"));
    // A slot the ledger doesn't know isn't reset.
    assert!(w.pool.retire("boat-9").await.is_err());
}

/// The hub's tunnel to a machine opens as soon as boat took its create or resume, before its node needs it (its setup
/// and its node wait for it), stays through the stop so the pre-stop flush reaches the hub, and closes once boat says
/// the machine sleeps. Every wake opens a fresh one: a resume is a new machine with a new host key.
#[tokio::test]
async fn the_tunnel_opens_at_the_wake_before_the_hello_and_closes_when_the_machine_sleeps() {
    let w = World::new().await;
    w.create("boat-1").await;
    let id = w.sandbox("boat-1");
    assert_eq!(w.tunnels.log(), [format!("open boat-1 {id}")]);
    assert_eq!(w.tunnels.status("boat-1"), Some(Tunnel::Up));
    w.advance(Duration::from_secs(20));
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    w.pool
        .stop("boat-1", State::Stopping, "idle")
        .await
        .unwrap();
    assert_eq!(
        w.tunnels.status("boat-1"),
        Some(Tunnel::Up),
        "held while it stops"
    );
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Asleep);
    assert_eq!(w.tunnels.status("boat-1"), None);
    // Each wake: a fresh tunnel at once, no tick needed.
    for _ in 0..2 {
        w.pool.wake("boat-1", Why::Need).await.unwrap();
        assert_eq!(w.tunnels.status("boat-1"), Some(Tunnel::Up));
        w.advance(Duration::from_secs(30));
        w.hello("boat-1", Some(false));
        w.tick().await;
        assert_eq!(w.state("boat-1"), State::Awake);
        w.pool
            .stop("boat-1", State::Stopping, "idle")
            .await
            .unwrap();
        w.tick().await;
        assert_eq!(w.tunnels.status("boat-1"), None);
    }
    assert_eq!(
        w.tunnels.log(),
        [
            format!("open boat-1 {id}"),
            "close boat-1".into(),
            format!("open boat-1 {id}"),
            "close boat-1".into(),
            format!("open boat-1 {id}"),
            "close boat-1".into(),
        ]
    );
    // Deleted (Reset): no tunnel either.
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    w.pool
        .stop("boat-1", State::Stopping, "test")
        .await
        .unwrap();
    w.tick().await;
    w.pool.retire("boat-1").await.unwrap();
    assert_eq!(w.tunnels.status("boat-1"), None);
}

/// A tunnel that never comes up leaves the node silent: the wake's own timeout stops the machine and counts a failed
/// wake, naming the tunnel's error, and two make the slot broken; a create's never-joined delete names it too. No
/// endless retry: nothing wakes a broken slot.
#[tokio::test]
async fn a_tunnel_that_never_comes_up_is_a_failed_wake() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.tunnels.down.lock().unwrap().insert(
        "boat-1".into(),
        "its SSH server at 203.0.113.10:22: connection refused".into(),
    );
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    w.advance(3 * MIN);
    w.tick().await;
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!(row.state, State::Stopping);
    assert_eq!(row.wake_failures, 1);
    assert_eq!(
        row.note.as_deref(),
        Some(
            "no hello within 2 minutes of its wake: the hub's tunnel to it didn't come up (its SSH server at \
             203.0.113.10:22: connection refused)"
        )
    );
    w.tick().await;
    assert_eq!(w.tunnels.status("boat-1"), None, "closed once asleep");
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    w.advance(3 * MIN);
    w.tick().await;
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!(row.state, State::Broken);
    assert!(row.note.unwrap().contains("connection refused"));
    w.tick().await;
    assert_eq!(w.tunnels.status("boat-1"), None);
    assert!(w.pool.wake("boat-1", Why::Need).await.is_err());
    assert_eq!(w.boat.calls_like("resume").len(), 2);

    // A create whose tunnel never came up is deleted, and says so.
    w.tunnels.down.lock().unwrap().insert(
        "boat-2".into(),
        "boat.dev names no address for its SSH server yet".into(),
    );
    w.create("boat-2").await;
    w.advance(16 * MIN);
    w.tick().await;
    let row = w.pool.ledger.slot("boat-2").unwrap().unwrap();
    assert_eq!(row.state, State::Failed);
    assert!(
        row.note
            .as_deref()
            .unwrap()
            .ends_with("didn't come up (boat.dev names no address for its SSH server yet)"),
        "{:?}",
        row.note
    );
    assert_eq!(w.tunnels.status("boat-2"), None);
}

/// A tunnel that drops while its machine is awake stays held (the real one redials with backoff); the node heard again
/// once it is back keeps the machine awake. One that stays down leaves the node silent, and the node-vanished stop
/// sends it to sleep, which closes it.
#[tokio::test]
async fn a_dropped_tunnel_is_held_until_it_is_back_or_the_machine_stops() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.tunnels.set(
        "boat-1",
        Some("its SSH server at 203.0.113.10:22: the connection dropped"),
    );
    w.advance(3 * MIN);
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    assert!(matches!(w.tunnels.status("boat-1"), Some(Tunnel::Down(_))));
    w.tunnels.set("boat-1", None);
    w.hello("boat-1", Some(true));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Awake);
    assert_eq!(
        w.tunnels.log().len(),
        1,
        "never closed or reopened for a drop"
    );
    // Down for good: silent 10 minutes, stopped, closed once asleep.
    w.tunnels.set("boat-1", Some("the connection dropped"));
    w.advance(11 * MIN);
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Asleep);
    assert_eq!(w.tunnels.status("boat-1"), None);
}

/// After a hub restart the first tick opens the tunnels of the machines boat still runs for it; asleep ones get none.
#[tokio::test]
async fn a_hub_restart_opens_the_awake_machines_tunnels_again() {
    let w = World::new().await;
    w.awake("boat-1").await;
    w.asleep("boat-2").await;
    let tunnels = Arc::new(FakeTunnels::default());
    let pool = w.restart_with(tunnels.clone());
    sweep::sweep(&pool).await.unwrap();
    w.hello("boat-1", Some(true));
    life::tick(&pool).await;
    assert_eq!(
        tunnels.log(),
        [format!("open boat-1 {}", w.sandbox("boat-1"))]
    );
    assert_eq!(tunnels.status("boat-2"), None);
}

/// The admin's Test of the whole way, on a private hub: it wakes a sleeping machine, and passes once the tunnel is up
/// and the node said hello through it; one whose tunnel doesn't come up fails with that step. A Test wake idles off
/// after 5 minutes.
#[tokio::test]
async fn the_test_follows_a_wake_through_the_tunnel_to_the_hello() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    w.pool.path_begin("boat-1");
    w.pool.wake("boat-1", Why::Test).await.unwrap();
    let running = w.pool.path_test().unwrap();
    assert_eq!(running.ok, None);
    assert_eq!(
        running.said,
        "boat-1: waking; the hub's tunnel to it is up, waiting for its node's hello."
    );
    w.advance(Duration::from_secs(40));
    w.hello("boat-1", Some(false));
    w.tick().await;
    let passed = w.pool.path_test().unwrap();
    assert_eq!(passed.ok, Some(true), "{}", passed.said);
    assert_eq!(
        passed.said,
        "boat-1: boat.dev ran it, the hub's tunnel to it came up and its node said hello through it."
    );
    // It stays passed as the Test's machine goes back to sleep, 5 minutes idle.
    w.hello("boat-1", Some(false));
    w.tick().await;
    w.advance(5 * MIN);
    w.hello("boat-1", Some(false));
    w.tick().await;
    assert_eq!(w.state("boat-1"), State::Stopping);
    assert_eq!(w.pool.path_test().unwrap().ok, Some(true));
    w.tick().await;

    w.tunnels.down.lock().unwrap().insert(
        "boat-1".into(),
        "its SSH server at 203.0.113.10:22: no answer within 20 s".into(),
    );
    w.pool.path_begin("boat-1");
    w.pool.wake("boat-1", Why::Test).await.unwrap();
    assert!(
        w.pool
            .path_test()
            .unwrap()
            .said
            .ends_with("isn't up yet (its SSH server at 203.0.113.10:22: no answer within 20 s).")
    );
    w.advance(3 * MIN);
    w.tick().await;
    let failed = w.pool.path_test().unwrap();
    assert_eq!(failed.ok, Some(false));
    assert_eq!(
        failed.said,
        "boat-1: no hello within 2 minutes of its wake: the hub's tunnel to it didn't come up (its SSH server at \
         203.0.113.10:22: no answer within 20 s)"
    );
}

/// A resume that finds the machine running already (it raced the wake's GET): boat counted no start and kept its old
/// deadline, so the hub uncounts its start and renews the lease at once with a PATCH.
#[tokio::test]
async fn a_resume_that_finds_the_machine_running_costs_no_start_and_renews_the_lease() {
    let w = World::new().await;
    w.asleep("boat-1").await;
    let id = w.sandbox("boat-1");
    let day = |w: &World| {
        w.pool
            .ledger
            .starts_in(super::ledger::Window::Day, w.now())
            .unwrap()
            .0
    };
    let before = day(&w);
    w.advance(MIN);
    w.boat.s.lock().unwrap().races.insert(id.clone());
    w.pool.wake("boat-1", Why::Need).await.unwrap();
    assert_eq!(day(&w), before, "no start counted");
    let calls = w.boat.calls();
    let resume = calls.iter().position(|c| c.starts_with("resume")).unwrap();
    assert_eq!(calls[resume + 1], format!("ttl {id} 1800"));
    let sb = w.boat.s.lock().unwrap().machines[&id].clone();
    assert_eq!(sb.archive_after_ms(), Some(w.now() + 1_800_000));
    let row = w.pool.ledger.slot("boat-1").unwrap().unwrap();
    assert_eq!(row.state, State::Waking);
    assert_eq!(row.renewed_at, Some(w.now()));
}
