//! Cloud machines on boat.dev (D306 cloud.boat-v1): the hub keeps a small fixed pool of named boat machines
//! (`boat-1`…`boat-N`), each an ordinary fleetd machine once it joins, stopped when idle and resumed when work needs it.
//! Each hub uses its owner's own boat key, sealed to the hub's box key; nothing is provided as a service.
//!
//! The fences against a surprise bill, all here:
//! - **The ledger** ([`ledger`]): every row is written before the boat call it stands for. A create carries an
//!   Idempotency-Key and its attempt label, and a crash is settled by looking the attempt up before any retry.
//! - **The lease** ([`lease`]): boat's own auto-stop deadline, renewed every 10 minutes through one clamping function
//!   to at most 30 minutes and never past the budget at the pool's burn rate; never `null`. If the hub dies, boat stops
//!   every machine within 30 minutes.
//! - **The life loop** ([`life`]): idle stop after 15 minutes, budget stop, node-vanished stop, wake timeout leading
//!   to `broken`, and a spend meter checked against boat's own cost.
//! - **The sweep** ([`sweep`]): at hub start before any placement, then every 10 minutes, boat's own list of this hub's
//!   machines against the ledger. Machines labelled with another hub's id are never touched.
//! - **The start budget** ([`starts`]): half of boat's included starts per window, a pre-flight `GET /limits`, never
//!   an extra start, and a backoff on every boat code with a plain line.
//! - **The kill switch** ([`Pool::kill`], `cloud_stop`, `fleetd cloud stop`): lists boat by label, not the ledger.
//! - **The keepalive**: a slot asleep 12 days is woken briefly, so boat never expires its disk (14 days).
//!
//! The hub never needs a public address (D307): it dials each machine it wakes over SSH and holds a reverse tunnel
//! that the machine's node reaches it through ([`tunnel`]), from the wake until the machine sleeps.
//!
//! The pool is off until the admin turns it on; placement ([`place`]) asks [`Pool::ready`] and [`Pool::start_held`]
//! first.
pub mod boat;
pub mod lease;
pub mod ledger;
pub mod life;
pub mod place;
pub mod starts;
pub mod sweep;
pub mod tools;
pub mod tunnel;
pub mod view;

#[cfg(test)]
mod boat_tests;
#[cfg(test)]
mod place_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tunnel_tests;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use chrono::{Datelike, TimeZone};
use chrono_tz::Tz;
use zeroize::Zeroizing;

use boat::{Boat, BoatError, CreateBody, File, Phase, RestBoat};
use lease::{LEASE_S, Lease, SETUP_S};
use ledger::{Ledger, Settings, Slot, State, Window, price_per_hour};
use tunnel::{SshTunnels, Tunnel, Tunnels};

use crate::clock::Clock;
use crate::hub::store::{HubDb, StoreError, now_ms};

pub const LABEL_HUB: &str = "fleetd.hub";
pub const LABEL_SLOT: &str = "fleetd.slot";
pub const LABEL_ATTEMPT: &str = "fleetd.attempt";

const MINUTE: i64 = 60_000;
/// An awake machine nothing needs stops after this.
pub const IDLE_GRACE_MS: i64 = 15 * MINUTE;
/// A keepalive wake stops sooner: it only had to keep the disk.
pub const KEEPALIVE_GRACE_MS: i64 = 5 * MINUTE;
/// A resumed machine whose node hasn't said hello by then is stopped and counts a wake failure; two make it broken. The
/// spike's node said hello 3 to 6 s after a resume: 2 minutes leaves 20 times that for a node starved by the disk's
/// hydration, and catches a failed wake soon.
pub const HELLO_MS: i64 = 2 * MINUTE;
pub const BROKEN_AFTER: u32 = 2;
/// A created machine's setup and first hello: the enroll token's life.
pub const CREATE_HELLO_MS: i64 = 15 * MINUTE;
/// An awake machine whose node is silent this long is stopped (the hub marks it offline at 45 s).
pub const SILENT_MS: i64 = 10 * MINUTE;
/// How often an awake machine's lease is renewed.
pub const RENEW_MS: i64 = 10 * MINUTE;
/// A slot asleep this long is woken, so boat's 14-day disk expiry never comes.
pub const KEEPALIVE_AFTER_MS: i64 = 12 * 24 * 60 * MINUTE;
/// A placement's claim on an awake machine holds off its idle stop this long (a heartbeat's busy flag can be 15 s
/// old).
pub const CLAIM_MS: i64 = 2 * MINUTE;
/// A machine boat still runs this long past its deadline: boat's auto-stop didn't fire, so the hub stops it.
pub const OVERDUE_MS: i64 = 2 * MINUTE;

/// What the pool reads about the machines it made, from the node link.
pub trait Fleet: Send + Sync + 'static {
    /// When the machine's node was last heard from (ms).
    fn last_seen(&self, machine: &str) -> Option<i64>;
    /// Whether anything keeps the machine busy, from its node's latest heartbeat (`NodeBusy`); None from a node that
    /// doesn't say, or offline.
    fn busy(&self, machine: &str) -> Option<bool>;
    /// Whether its node has caught up since it linked (hub/cloud's `Cloud::ready`): its fleetd and Claude Code are the
    /// hub's and it holds the hub's Claude configuration. Until then it isn't awake for work.
    fn ready(&self, machine: &str) -> bool;
    /// Whether the hub hears its other machines normally: a stalled hub sees every node silent, and must not stop
    /// cloud machines for it. `besides` are the pool's own.
    fn others_heard(&self, besides: &[String], now: i64) -> bool;
    /// The machine is awake for work now: placement runs the tasks queue again.
    fn woke(&self, _machine: &str) {}
}

/// Why a machine is woken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// Work needs it.
    Need,
    /// It slept 12 days: wake it so boat keeps its disk.
    Keepalive,
    /// The admin's Test of the whole way to the hub.
    Test,
}

impl Why {
    fn as_str(self) -> &'static str {
        match self {
            Why::Need => "need",
            Why::Keepalive => "keepalive",
            Why::Test => "test",
        }
    }
}

/// What a create sends besides what the pool always does (W6's setup).
#[derive(Clone, Debug, Default)]
pub struct CreateSpec {
    pub setup_script: Option<String>,
    /// Under /tmp, which boat never snapshots, for the enroll token.
    pub files: Vec<File>,
    /// When the files' secrets (the enroll token) end: no retry of this body after it.
    pub body_until: i64,
}

/// The money budget now.
#[derive(Clone, Debug, PartialEq)]
pub struct Budget {
    pub day_spent: f64,
    pub month_spent: f64,
    pub day_budget: f64,
    pub month_budget: f64,
    /// The less of what's left today and this month.
    pub left: f64,
}

impl Budget {
    pub fn line(&self) -> Option<String> {
        if self.day_spent >= self.day_budget {
            Some(format!(
                "cloud paused: today's boat.dev budget (${:.2}) is spent; work runs on your own machines when there's room",
                self.day_budget
            ))
        } else if self.month_spent >= self.month_budget {
            Some(format!(
                "cloud paused: this month's boat.dev budget (${:.2}) is spent; work runs on your own machines when there's room",
                self.month_budget
            ))
        } else {
            None
        }
    }
}

/// What the kill switch did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Kill {
    /// The slots (or, for a machine the ledger doesn't know, boat's ids) a stop went to.
    pub stopped: Vec<String>,
    /// Those boat refused, with why.
    pub failed: Vec<(String, String)>,
    /// Why boat's list couldn't be read: the ledger's machines were stopped instead.
    pub unlisted: Option<String>,
}

/// The admin's Test of the whole way, from a wake or create through the tunnel to the node's hello, as far as it got.
#[derive(Clone, Debug, PartialEq)]
struct PathTest {
    slot: String,
    since: i64,
    /// Passed with its line, or failed with the step and why; None while it runs.
    result: Option<Result<String, String>>,
}

pub struct Pool {
    ledger: Ledger,
    boat: Arc<dyn Boat>,
    tunnels: Arc<dyn Tunnels>,
    fleet: Arc<dyn Fleet>,
    clock: Arc<dyn Clock>,
    zone: Tz,
    home: PathBuf,
    /// One at a time per slot: a wake, a create, the life loop's step for it.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Placement's claims on awake machines (S6): when each was last claimed. Read and written under this lock with
    /// the idle stop's `stopping` write.
    claims: Mutex<HashMap<String, i64>>,
    /// The sweep has run since the hub started: placement may use the pool.
    ready: AtomicBool,
    /// Warnings given once per hub process (a machine past its deadline).
    warned: Mutex<HashSet<String>>,
    /// Slots placement asked to wake whose wake hasn't returned yet ([`Pool::wake_for_work`]).
    waking: Mutex<HashSet<String>>,
    /// What boat last said to the hub's key: the admin's Test, or a sweep. The doctor's `hub/cloud_key` reads it.
    key_test: Mutex<Option<fleetd_contracts::cloud::CloudKeyTest>>,
    /// The admin's last Test of the whole way ([`Pool::path_test`]).
    path: Mutex<Option<PathTest>>,
    /// Awake slots whose disk boat says is hydrated since they woke: placement prefers them, since builds run about 5
    /// times slower until it is (W407's spike).
    hydrated: Mutex<HashSet<String>>,
    /// When this hub process began watching its machines (ms): a hello deadline counts only time since then, never the
    /// time the hub was down or restarting, when no hello could reach it.
    watching_since: i64,
}

impl Pool {
    pub fn new(
        db: Arc<HubDb>,
        home: PathBuf,
        boat: Arc<dyn Boat>,
        tunnels: Arc<dyn Tunnels>,
        fleet: Arc<dyn Fleet>,
        clock: Arc<dyn Clock>,
        zone: Tz,
    ) -> Arc<Pool> {
        let watching_since = now_ms(clock.as_ref());
        Arc::new(Pool {
            watching_since,
            ledger: Ledger::new(db),
            boat,
            tunnels,
            fleet,
            clock,
            zone,
            home,
            locks: Mutex::default(),
            claims: Mutex::default(),
            ready: AtomicBool::new(false),
            warned: Mutex::default(),
            waking: Mutex::default(),
            key_test: Mutex::default(),
            path: Mutex::default(),
            hydrated: Mutex::default(),
        })
    }

    /// The hub's pool: boat itself at `api`, with the key the ledger holds sealed to the hub's box key, and the hub's
    /// tunnels to its machines, which carry their nodes to `hub` (its listen address).
    pub fn over_boat(
        db: Arc<HubDb>,
        home: PathBuf,
        api: &str,
        hub: (String, u16),
        fleet: Arc<dyn Fleet>,
        clock: Arc<dyn Clock>,
        zone: Tz,
    ) -> Arc<Pool> {
        let ledger = Ledger::new(db.clone());
        let key_home = home.clone();
        let key: boat::KeySource = Arc::new(move || open_key(&ledger, &key_home));
        let boat: Arc<dyn Boat> = Arc::new(RestBoat::new(api, key));
        let ledger = Ledger::new(db.clone());
        let ssh_home = home.clone();
        let ssh_key: tunnel::KeySource =
            Arc::new(move || tunnel::hub_key(&ledger, &ssh_home).map(Arc::new));
        let tunnels = Arc::new(SshTunnels::new(boat.clone(), ssh_key, hub));
        Pool::new(db, home, boat, tunnels, fleet, clock, zone)
    }

    /// The public half of the hub's SSH key, made now if it isn't yet: what boat puts on each machine.
    pub fn ssh_public_key(&self) -> Result<String, String> {
        tunnel::public_line(&tunnel::hub_key(&self.ledger, &self.home)?)
    }

    /// The slot's tunnel: held while its machine should be up (creating, waking, awake, and stopping, so the node's
    /// pre-stop flush still reaches the hub), closed otherwise.
    fn sync_tunnel(&self, row: &Slot) {
        match (&row.sandbox_id, row.state) {
            (Some(id), State::Creating | State::Waking | State::Awake | State::Stopping) => {
                self.tunnels.open(&row.slot, id)
            }
            _ => self.tunnels.close(&row.slot),
        }
    }

    /// Whether the slot's disk is hydrated since it woke, as boat last said.
    pub fn hydrated(&self, slot: &str) -> bool {
        self.hydrated.lock().unwrap().contains(slot)
    }

    /// Why the slot's tunnel isn't up, when one is held and isn't.
    fn tunnel_down(&self, slot: &str) -> Option<String> {
        match self.tunnels.status(slot)? {
            Tunnel::Up => None,
            Tunnel::Down(why) => Some(why),
        }
    }

    /// The ms of a hello deadline that began at `at`, counted from when this hub could first see the machine.
    pub(super) fn waited(&self, at: i64, now: i64) -> i64 {
        now - at.max(self.watching_since)
    }

    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    pub fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    /// Whether placement may use the pool: the sweep has reconciled boat with the ledger since the hub started. Until
    /// then (boat down at start, say) only cloud placement waits; local work never does.
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    fn lock(&self, slot: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks
            .lock()
            .unwrap()
            .entry(slot.to_owned())
            .or_default()
            .clone()
    }

    fn box_key(&self) -> Result<crate::node::identity::NodeBoxKey, String> {
        crate::node::identity::load_or_create_box_key(&self.home).map_err(|e| {
            tracing::error!(error = %e, "pool: hub box key");
            "the hub can't read its box key: check the hub's home directory".to_owned()
        })
    }

    /// Keeps the admin's boat key sealed to the hub's box key; the plaintext is never stored or returned. Clears a
    /// pause the old key caused.
    pub fn set_key(&self, key: &str) -> Result<(), String> {
        let key = key.trim();
        if key.is_empty() {
            return Err("an empty boat.dev key".into());
        }
        let sealed = self
            .box_key()?
            .seal(key.as_bytes())
            .ok_or("sealing the key failed")?;
        self.ledger
            .set_sealed_key(Some(&sealed))
            .map_err(|e| e.to_string())?;
        // A new key is untested, and what boat said to the old one about a create no longer holds.
        self.heard(None);
        self.forget_refused_creates();
        Ok(())
    }

    /// Drops the notes of the creates boat refused: once the key or the environment changes, the next Create asks
    /// boat again, and a refusal it gives then is noted anew.
    pub(super) fn forget_refused_creates(&self) {
        let Ok(rows) = self.ledger.slots() else {
            return;
        };
        for mut row in rows {
            if row.state == State::Failed && row.sandbox_id.is_none() && row.note.is_some() {
                row.note = None;
                if let Err(e) = self.ledger.put(&row) {
                    tracing::warn!(slot = row.slot, error = %e, "pool: a refused create's note not cleared");
                }
            }
        }
    }

    /// Day and month spend against their budgets, the day and the month in the hub's time zone.
    pub fn budget(&self, s: &Settings, now: i64) -> Result<Budget, StoreError> {
        let day_spent = self.ledger.spent(day_start(now, self.zone), now)?;
        let month_spent = self.ledger.spent(month_start(now, self.zone), now)?;
        let month_budget = s.month_budget();
        Ok(Budget {
            day_spent,
            month_spent,
            day_budget: s.day_budget,
            month_budget,
            left: (s.day_budget - day_spent).min(month_budget - month_spent),
        })
    }

    /// The pool's burn rate: every machine the hub wants running, at the pool's price, plus `extra` about to start.
    fn burn(&self, s: &Settings, slots: &[Slot], extra: usize) -> f64 {
        let running = slots.iter().filter(|r| r.state.wanted()).count() + extra;
        running as f64 * price_per_hour(&s.machine_type)
    }

    /// The lease for a machine now, through [`lease::clamp`].
    fn lease(&self, s: &Settings, longest_s: u32, extra: usize) -> Result<Lease, StoreError> {
        let now = self.now();
        let slots = self.ledger.slots()?;
        let budget = self.budget(s, now)?;
        Ok(lease::clamp(
            longest_s,
            budget.left,
            self.burn(s, &slots, extra),
        ))
    }

    /// Why no start may go now, in one plain line, or None: the pool off, no key, a billing or key pause, boat's
    /// backoff, its machines-at-once limit, the money budget, fleetd's start budget. Placement shows it on a waiting
    /// task.
    pub fn start_held(&self) -> Option<String> {
        let now = self.now();
        let s = match self.ledger.settings() {
            Ok(s) => s,
            Err(e) => return Some(format!("the pool's ledger can't be read: {e}")),
        };
        if let Some(line) = starts::held(&s, now) {
            return Some(line);
        }
        match self.budget(&s, now) {
            Ok(b) => {
                if let Some(line) = b.line() {
                    return Some(line);
                }
            }
            Err(e) => return Some(format!("the pool's ledger can't be read: {e}")),
        }
        let mut counts = Vec::new();
        for w in Window::ALL {
            match self.ledger.starts_in(w, now) {
                Ok((n, oldest)) => counts.push((w, n, oldest)),
                Err(e) => return Some(format!("the pool's ledger can't be read: {e}")),
            }
        }
        starts::budget_line(
            s.starts.unwrap_or(starts::INCLUDED_UNKNOWN),
            &counts,
            self.zone,
        )
    }

    /// Placement's claim on an awake machine, before it launches there: false unless the machine is awake and caught up
    /// since its node last linked (`Cloud::ready`: a node that restarted catches up again first). A claim
    /// holds off the idle stop for [`CLAIM_MS`], and the idle stop's `stopping` write takes the same lock, so a
    /// machine is never stopped under a launch.
    pub fn claim(&self, slot: &str) -> bool {
        let mut claims = self.claims.lock().unwrap();
        let awake = matches!(self.ledger.slot(slot), Ok(Some(r)) if r.state == State::Awake)
            && self.fleet.ready(slot);
        if awake {
            claims.insert(slot.to_owned(), self.now());
        }
        awake
    }

    /// Writes the slot as `to` (stopping, or broken / failed for a machine never to be woken), then asks boat to stop
    /// it. Repeating it is harmless: boat answers a stop under way with the same stop, and the life loop sends it
    /// again until boat says archived.
    pub async fn stop(&self, slot: &str, to: State, why: &str) -> Result<(), String> {
        let Some(mut row) = self.ledger.slot(slot).map_err(|e| e.to_string())? else {
            return Ok(());
        };
        row.state = to;
        row.idle_since = None;
        row.note = Some(why.to_owned());
        self.ledger.put(&row).map_err(|e| e.to_string())?;
        self.sync_tunnel(&row);
        tracing::info!(slot, why, "pool: stopping");
        let Some(id) = row.sandbox_id.clone() else {
            return Ok(());
        };
        self.send_stop(&id, Some(slot)).await
    }

    /// One stop to boat; a machine boat no longer has is written gone.
    async fn send_stop(&self, id: &str, slot: Option<&str>) -> Result<(), String> {
        match self.boat.stop(id).await {
            Ok(()) | Err(BoatError::Conflict { .. }) => Ok(()),
            Err(BoatError::NotFound) => {
                if let Some(slot) = slot {
                    self.gone(slot, "boat.dev no longer has it")
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            }
            Err(e) => {
                tracing::warn!(sandbox = id, error = ?e, "pool: stop refused");
                Err(e.line())
            }
        }
    }

    /// The slot's machine is gone at boat: its meter closes and it needs a new create.
    fn gone(&self, slot: &str, why: &str) -> Result<(), StoreError> {
        let now = self.now();
        self.ledger.close_spend(slot, now)?;
        if let Some(mut row) = self.ledger.slot(slot)? {
            row.state = State::Gone;
            row.sandbox_id = None;
            row.create_body = None;
            row.note = Some(why.to_owned());
            self.ledger.put(&row)?;
        }
        self.tunnels.close(slot);
        self.hydrated.lock().unwrap().remove(slot);
        Ok(())
    }

    /// boat saw the machine stopped: asleep, its meter closed, and boat's machines-at-once limit has room again.
    fn asleep(&self, mut row: Slot) -> Result<(), StoreError> {
        let now = self.now();
        self.ledger.close_spend(&row.slot, now)?;
        if row.state.wanted() || row.state == State::Stopping {
            row.state = State::Asleep;
        }
        row.asleep_since = Some(now);
        row.awake_since = None;
        row.lease_until = None;
        row.renewed_at = None;
        row.idle_since = None;
        self.ledger.put(&row)?;
        self.sync_tunnel(&row);
        self.hydrated.lock().unwrap().remove(&row.slot);
        self.ledger.set_full(false)
    }

    /// A refusal's backoff, kept in the ledger.
    fn back_off(&self, error: &BoatError) {
        let now = self.now();
        let step = self.ledger.settings().map(|s| s.backoff_step).unwrap_or(0);
        let result = match starts::backoff(error, step, now, rand::random::<f64>(), self.zone) {
            starts::Backoff::Hold {
                until,
                step,
                reason,
            } => self.ledger.set_hold(Some(until), Some(&reason), step),
            starts::Backoff::Full => self.ledger.set_full(true),
            starts::Backoff::Pause { kind, reason } => {
                tracing::warn!(kind, reason, "pool: bursting paused");
                self.ledger.set_paused(Some((kind, &reason)))
            }
        };
        if let Err(e) = result {
            tracing::error!(error = %e, "pool: backoff not written");
        }
    }

    /// A start boat took: its backoff ends, and a Test that failed before it is no longer what holds.
    fn started(&self) {
        if let Err(e) = self.ledger.set_hold(None, None, 0) {
            tracing::error!(error = %e, "pool: backoff not cleared");
        }
        self.path_forget_failure();
    }

    /// The checks before any start: nothing holds starts, the budget allows one more machine, and boat's pre-flight
    /// says it can start at no cost. Returns the settings and the lease.
    async fn may_start(&self, longest_s: u32) -> Result<(Settings, lease::Ttl), String> {
        if let Some(line) = self.start_held() {
            return Err(line);
        }
        let s = self.ledger.settings().map_err(|e| e.to_string())?;
        let Lease::Renew(ttl) = self.lease(&s, longest_s, 1).map_err(|e| e.to_string())? else {
            return Err(self
                .budget(&s, self.now())
                .ok()
                .and_then(|b| b.line())
                .unwrap_or_else(|| {
                    "cloud paused: too little budget left to start a machine".into()
                }));
        };
        let limits = match self.boat.limits().await {
            Ok(l) => l,
            Err(e) => {
                self.back_off(&e);
                return Err(e.line());
            }
        };
        if let Err(e) = self
            .ledger
            .set_plan(limits.start_limits, limits.sandbox_plan_dollars)
        {
            tracing::warn!(error = %e, "pool: plan not kept");
        }
        if let Some(why) = starts::preflight(&limits) {
            return Err(why);
        }
        Ok((s, ttl))
    }

    /// Wakes `slot`: only a machine boat says is stopped is resumed (boat has no Idempotency-Key for resume), one wake
    /// at a time per slot, after every start check. Its row says `waking` and its meter runs before the call. Ok once
    /// boat took the resume, or found it already running; the node's hello makes it `awake`.
    pub async fn wake(&self, slot: &str, why: Why) -> Result<(), String> {
        let lock = self.lock(slot);
        let _held = lock.lock().await;
        let Some(mut row) = self.ledger.slot(slot).map_err(|e| e.to_string())? else {
            return Err(format!("no cloud machine {slot}"));
        };
        match row.state {
            State::Awake | State::Waking | State::Creating => return Ok(()),
            State::Broken => {
                return Err(format!(
                    "{slot} doesn't come back: Reset it in Settings › Hub › Machines"
                ));
            }
            State::Asleep | State::Stopping => {}
            State::Failed | State::Gone => return Err(format!("{slot} has no machine: Reset it")),
        }
        let Some(id) = row.sandbox_id.clone() else {
            return Err(format!("{slot} has no machine: Reset it"));
        };
        let (s, ttl) = self.may_start(LEASE_S).await?;
        // GET first: resume only what boat says is stopped (or stopping, which a resume takes back).
        let seen = match self.boat.get(&id).await {
            Ok(seen) => seen,
            Err(BoatError::NotFound) => {
                self.gone(slot, "boat.dev no longer has it")
                    .map_err(|e| e.to_string())?;
                return Err(format!("{slot} is gone at boat.dev: Reset it"));
            }
            Err(e) => return Err(e.line()),
        };
        let now = self.now();
        if seen.phase() == Phase::Dead {
            self.gone(slot, "boat.dev lost it")
                .map_err(|e| e.to_string())?;
            return Err(format!("{slot} is gone at boat.dev: Reset it"));
        }
        let already_up = seen.phase() == Phase::Up;
        // Kept for a refused resume: the machine never ran, so its 12 days to the keepalive still count from here.
        let asleep_since = row.asleep_since;
        row.state = State::Waking;
        row.wake_at = Some(now);
        row.wake_why = Some(why.as_str().to_owned());
        row.idle_since = None;
        row.asleep_since = None;
        row.note = None;
        if already_up {
            // Running already (a wake raced a stop that never came): no start, but the lease is renewed now.
            row.lease_until = seen.archive_after_ms();
            row.renewed_at = None;
            self.ledger.put(&row).map_err(|e| e.to_string())?;
            if !self
                .ledger
                .has_open_spend(slot)
                .map_err(|e| e.to_string())?
            {
                self.ledger
                    .open_spend(slot, Some(&id), now, price_per_hour(&s.machine_type))
                    .map_err(|e| e.to_string())?;
            }
            self.sync_tunnel(&row);
            return Ok(());
        }
        row.lease_until = Some(now + ttl.ms());
        row.renewed_at = Some(now);
        self.ledger.put(&row).map_err(|e| e.to_string())?;
        let start = self
            .ledger
            .count_start(slot, "resume", now)
            .map_err(|e| e.to_string())?;
        let spend = self
            .ledger
            .open_spend(slot, Some(&id), now, price_per_hour(&s.machine_type))
            .map_err(|e| e.to_string())?;
        match self.boat.resume(&id, ttl).await {
            Ok(sb) if sb.already_running => {
                // It ran already (a stop raced this wake): boat counted no start and kept its old deadline, which only
                // a PATCH moves. The same machine, so its tunnel stays as it is.
                let _ = self.ledger.uncount_start(start);
                self.started();
                match self.boat.set_ttl(&id, ttl).await {
                    Ok(()) => row.renewed_at = Some(self.now()),
                    Err(e) => {
                        tracing::warn!(slot, error = %e.line(), "pool: lease of a running machine not renewed");
                        row.lease_until = sb.archive_after_ms();
                        row.renewed_at = None;
                    }
                }
                self.ledger.put(&row).map_err(|e| e.to_string())?;
                self.sync_tunnel(&row);
                Ok(())
            }
            Ok(_) => {
                self.started();
                // A resume is a new machine, its disk attached lazily, with a new host key: a fresh tunnel, opened
                // before its node needs it.
                self.hydrated.lock().unwrap().remove(slot);
                self.tunnels.close(slot);
                self.sync_tunnel(&row);
                Ok(())
            }
            Err(e) => {
                if matches!(e, BoatError::NoReadyMachine | BoatError::RateLimited { .. }) {
                    let _ = self.ledger.uncount_start(start);
                }
                self.back_off(&e);
                // Whether a machine runs now: refused outright, none does; no answer, ask boat.
                let up = match e {
                    BoatError::Network(_) | BoatError::Server { .. } => {
                        match self.boat.get(&id).await {
                            Ok(sb) => sb.phase() == Phase::Up,
                            Err(_) => true,
                        }
                    }
                    _ => false,
                };
                if up {
                    // It may be waking: the wake timeout or the sweep settles it.
                    return Err(e.line());
                }
                self.ledger.drop_spend(spend).map_err(|e| e.to_string())?;
                row.state = if e == BoatError::DataExpired {
                    State::Gone
                } else {
                    State::Asleep
                };
                row.lease_until = None;
                row.renewed_at = None;
                row.asleep_since = asleep_since;
                row.note = Some(e.line());
                if e == BoatError::DataExpired {
                    row.sandbox_id = None;
                }
                self.ledger.put(&row).map_err(|e| e.to_string())?;
                Err(e.line())
            }
        }
    }

    /// Creates `slot`'s machine (W6 renders `spec`): the row, the attempt's key and sealed body, the start and the
    /// meter are written first. A create boat refused leaves the slot `failed`; one with no answer stays `creating`,
    /// and the sweep looks its attempt up by label before it ever sends that body again.
    pub async fn create(&self, slot: &str, spec: CreateSpec) -> Result<(), String> {
        let lock = self.lock(slot);
        let _held = lock.lock().await;
        let now = self.now();
        let mut row = match self.ledger.slot(slot).map_err(|e| e.to_string())? {
            Some(r) if r.sandbox_id.is_some() || r.state == State::Creating => {
                return Err(format!("{slot} already has a machine"));
            }
            Some(r) => r,
            None => Slot::new(slot, now),
        };
        let (s, ttl) = self.may_start(SETUP_S).await?;
        let idem_key = hex(&rand::random::<[u8; 16]>());
        let labels = BTreeMap::from([
            (LABEL_HUB.to_owned(), s.hub_id.clone()),
            (LABEL_SLOT.to_owned(), slot.to_owned()),
            (LABEL_ATTEMPT.to_owned(), idem_key.clone()),
        ]);
        let short: String = s.hub_id.chars().take(8).collect();
        let mut body = CreateBody::new(
            &s.machine_type,
            format!("fleetd-{short}-{slot}"),
            labels,
            ttl,
        );
        body.environment = s.environment.clone();
        body.setup_script = spec.setup_script;
        body.files = spec.files;
        let bytes = Zeroizing::new(serde_json::to_vec(&body).map_err(|e| e.to_string())?);
        let sealed = self
            .box_key()?
            .seal(&bytes)
            .ok_or("sealing the create failed")?;
        row.state = State::Creating;
        row.idem_key = Some(idem_key.clone());
        row.create_body = Some(sealed);
        row.body_until = Some(spec.body_until);
        row.created_at = now;
        row.wake_at = Some(now);
        row.wake_why = Some(Why::Need.as_str().to_owned());
        row.lease_until = Some(now + ttl.ms());
        row.renewed_at = Some(now);
        row.wake_failures = 0;
        row.note = None;
        self.ledger.put(&row).map_err(|e| e.to_string())?;
        let start = self
            .ledger
            .count_start(slot, "create", now)
            .map_err(|e| e.to_string())?;
        let spend = self
            .ledger
            .open_spend(slot, None, now, price_per_hour(&s.machine_type))
            .map_err(|e| e.to_string())?;
        let answer = self
            .boat
            .create(&idem_key, &bytes)
            .await
            .map_err(|e| match e {
                BoatError::UnknownEnvironment { .. } => BoatError::UnknownEnvironment {
                    name: s.environment.clone().unwrap_or_else(|| "base".into()),
                },
                e => e,
            });
        self.created(slot, answer, Some((start, spend)))
    }

    /// Settles a create's answer: the id kept and the body dropped, or the slot failed.
    fn created(
        &self,
        slot: &str,
        answer: Result<boat::Sandbox, BoatError>,
        rows: Option<(i64, i64)>,
    ) -> Result<(), String> {
        let mut row = self
            .ledger
            .slot(slot)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no cloud machine {slot}"))?;
        match answer {
            Ok(sb) => {
                self.started();
                row.sandbox_id = Some(sb.id.clone());
                row.create_body = None;
                self.ledger.put(&row).map_err(|e| e.to_string())?;
                self.ledger
                    .name_spend(slot, &sb.id)
                    .map_err(|e| e.to_string())?;
                // Its setup waits for the tunnel before it joins.
                self.sync_tunnel(&row);
                Ok(())
            }
            // No answer, or boat still at it: leave it creating for the sweep.
            Err(
                e @ (BoatError::Network(_)
                | BoatError::Server { .. }
                | BoatError::IdempotencyInProgress),
            ) => {
                self.back_off(&e);
                Err(e.line())
            }
            Err(e) => {
                tracing::warn!(slot, error = %e.line(), "pool: boat.dev refused the create");
                if let Some((start, spend)) = rows {
                    // boat checks the environment before it counts anything.
                    if matches!(
                        e,
                        BoatError::NoReadyMachine
                            | BoatError::RateLimited { .. }
                            | BoatError::UnknownEnvironment { .. }
                    ) {
                        let _ = self.ledger.uncount_start(start);
                    }
                    let _ = self.ledger.drop_spend(spend);
                } else {
                    let _ = self.ledger.close_spend(slot, self.now());
                }
                // A refusal of this create's own ask fails only its machine: no other start waits on it, and the
                // person's next Create, once they fixed it, goes straight to boat.
                if !e.about_the_request() {
                    self.back_off(&e);
                }
                row.state = State::Failed;
                row.create_body = None;
                row.lease_until = None;
                row.note = Some(e.line());
                self.ledger.put(&row).map_err(|e| e.to_string())?;
                Err(e.line())
            }
        }
    }

    /// The kill switch: turns the pool off, then lists every machine labelled with this hub's id **from boat** (not
    /// the ledger) and stops each one still up. Each sweep repeats it while the pool is off, so a machine a racing
    /// call woke is stopped again. If boat's list can't be read, the ledger's machines are stopped instead; their
    /// leases stop anything else within 30 minutes.
    pub async fn kill(&self) -> Result<Kill, String> {
        self.ledger.set_enabled(false).map_err(|e| e.to_string())?;
        let s = self.ledger.settings().map_err(|e| e.to_string())?;
        let mut kill = Kill::default();
        if !s.has_key {
            return Ok(kill);
        }
        let rows = self.ledger.slots().map_err(|e| e.to_string())?;
        let labels = [(LABEL_HUB.to_owned(), s.hub_id.clone())];
        let targets: Vec<(String, Option<String>)> = match self.boat.list(&labels).await {
            Ok(list) => list
                .into_iter()
                .filter(|sb| sb.label(LABEL_HUB) == Some(s.hub_id.as_str()))
                .filter(|sb| sb.phase() == Phase::Up)
                .map(|sb| {
                    let slot = rows
                        .iter()
                        .find(|r| r.sandbox_id.as_deref() == Some(sb.id.as_str()))
                        .map(|r| r.slot.clone());
                    (sb.id, slot)
                })
                .collect(),
            Err(e) => {
                kill.unlisted = Some(e.line());
                rows.iter()
                    .filter(|r| r.state != State::Asleep && r.state != State::Gone)
                    .filter_map(|r| Some((r.sandbox_id.clone()?, Some(r.slot.clone()))))
                    .collect()
            }
        };
        for (id, slot) in targets {
            let name = slot.clone().unwrap_or_else(|| id.clone());
            let sent = match &slot {
                Some(slot) => {
                    let to = match self.ledger.slot(slot) {
                        Ok(Some(r)) if matches!(r.state, State::Broken | State::Failed) => r.state,
                        _ => State::Stopping,
                    };
                    self.stop(slot, to, "cloud machines are off").await
                }
                None => self.send_stop(&id, None).await,
            };
            match sent {
                Ok(()) => kill.stopped.push(name),
                Err(why) => kill.failed.push((name, why)),
            }
        }
        Ok(kill)
    }

    /// Lifts a billing or key pause by hand (the admin's Resume): the next start's pre-flight asks boat again.
    pub fn resume_bursting(&self) -> Result<(), StoreError> {
        self.ledger.set_paused(None)?;
        self.ledger.set_hold(None, None, 0)?;
        self.ledger.set_full(false)
    }

    /// Warns once per hub process about `what`.
    fn warn_once(&self, what: String, line: &str) {
        if self.warned.lock().unwrap().insert(what.clone()) {
            tracing::warn!(what, "pool: {line}");
        }
    }
}

/// The admin's boat key, opened with the hub's box key.
fn open_key(ledger: &Ledger, home: &std::path::Path) -> Result<Zeroizing<String>, BoatError> {
    let sealed = ledger
        .sealed_key()
        .map_err(|e| BoatError::NoKey(format!("the pool's ledger can't be read: {e}")))?
        .ok_or_else(|| BoatError::NoKey("no boat.dev key: Settings › Hub › Machines".into()))?;
    let key = crate::node::identity::load_or_create_box_key(home)
        .map_err(|_| BoatError::NoKey("the hub can't read its box key".into()))?;
    let plain = key.open(&sealed).ok_or_else(|| {
        BoatError::NoKey(
            "the boat.dev key was sealed to another box key: paste it again in Settings › Hub › Machines"
                .into(),
        )
    })?;
    String::from_utf8(plain.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| BoatError::NoKey("the boat.dev key isn't text: paste it again".into()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Midnight today in `zone`, ms.
pub fn day_start(now: i64, zone: Tz) -> i64 {
    let local = chrono::DateTime::from_timestamp_millis(now)
        .unwrap_or_default()
        .with_timezone(&zone);
    zone.with_ymd_and_hms(local.year(), local.month(), local.day(), 0, 0, 0)
        .earliest()
        .map_or(now - now.rem_euclid(86_400_000), |t| t.timestamp_millis())
}

/// The 1st of this month at midnight in `zone`, ms.
pub fn month_start(now: i64, zone: Tz) -> i64 {
    let local = chrono::DateTime::from_timestamp_millis(now)
        .unwrap_or_default()
        .with_timezone(&zone);
    zone.with_ymd_and_hms(local.year(), local.month(), 1, 0, 0, 0)
        .earliest()
        .map_or_else(|| day_start(now, zone), |t| t.timestamp_millis())
}

/// The hub's [`Fleet`]: machines' last sightings from the store, what keeps them busy from the node link, and whether
/// they caught up from hub/cloud. Bound to the hub once it is built; until then it knows nothing.
#[derive(Default)]
pub struct HubFleet {
    hub: std::sync::OnceLock<Weak<crate::hub::api::Hub>>,
}

impl HubFleet {
    pub fn bind(&self, hub: &Arc<crate::hub::api::Hub>) {
        let _ = self.hub.set(Arc::downgrade(hub));
    }

    fn hub(&self) -> Option<Arc<crate::hub::api::Hub>> {
        self.hub.get()?.upgrade()
    }
}

impl Fleet for HubFleet {
    fn last_seen(&self, machine: &str) -> Option<i64> {
        let id = fleetd_contracts::ids::MachineId::new(machine).ok()?;
        let m = self.hub()?.store.machine_get(&id).ok()??;
        crate::hub::store::parse_ms(m.last_seen_at.as_str())
    }

    fn busy(&self, machine: &str) -> Option<bool> {
        let id = fleetd_contracts::ids::MachineId::new(machine).ok()?;
        self.hub()?.link.busy(&id).map(|b| !b.idle())
    }

    fn ready(&self, machine: &str) -> bool {
        let (Ok(id), Some(hub)) = (fleetd_contracts::ids::MachineId::new(machine), self.hub())
        else {
            return false;
        };
        hub.cloud.ready(&hub, &id)
    }

    fn woke(&self, _machine: &str) {
        if let Some(hub) = self.hub() {
            hub.tasks.retry_soon();
        }
    }

    fn others_heard(&self, besides: &[String], now: i64) -> bool {
        use fleetd_contracts::model::MachineStatus;
        let Some(Ok(machines)) = self.hub().map(|h| h.store.machines_list()) else {
            return false;
        };
        let others: Vec<_> = machines
            .iter()
            .filter(|m| !besides.iter().any(|b| b == m.machine_id.as_str()))
            .collect();
        others.is_empty()
            || others.iter().any(|m| {
                m.status != MachineStatus::Offline
                    && crate::hub::store::parse_ms(m.last_seen_at.as_str())
                        .is_some_and(|at| now - at < 2 * MINUTE)
            })
    }
}

/// The pool's loops: the sweep at hub start (again every tick until it once gets through), then every 10 minutes;
/// the life loop every 30 s. Nothing calls boat while the hub holds no boat key.
pub async fn run(pool: Arc<Pool>, shutdown: crate::hub::api::Shutdown) {
    let mut next_sweep = 0_i64;
    loop {
        let has_key = pool.ledger.settings().is_ok_and(|s| s.has_key);
        if has_key {
            let now = pool.now();
            if now >= next_sweep {
                match sweep::sweep(&pool).await {
                    Ok(()) => next_sweep = now + sweep::SWEEP_MS,
                    Err(e) => {
                        tracing::warn!(error = %e, "pool: sweep failed; cloud placement waits")
                    }
                }
            }
            life::tick(&pool).await;
        } else {
            // No key: nothing at boat to reconcile, so the pool has nothing to wait for.
            pool.ready.store(true, Ordering::SeqCst);
        }
        tokio::select! {
            _ = pool.clock.sleep(life::TICK) => {}
            _ = shutdown.wait() => return,
        }
    }
}
