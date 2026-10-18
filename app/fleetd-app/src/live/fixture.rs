//! Fixture board and scripted live feed, for `FLEETD_BENCH=live` and screenshots only: compiled in, reached
//! only through `open_bench`, which `main` calls for that bench mode. Never shown to a connected user.
//!
//! The board is the hub writer's coherent W14 fixture (crates/fleetd-contracts/tests/fixtures/live), its times
//! moved to now. `FLEETD_LIVE=demo` opens that board with the feed at a natural pace and stays open (for
//! screenshots); otherwise the bench scales it to 50 orders and 200 lanes, drives the feed at its maximum
//! rate and measures frames (see `measure`).

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::app::AppServerMessage;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::live::{Activity, ActivityNow, AgentLane, LaneStatus, LiveFrame, LiveLane, OrderPhase, SPARK_BUCKETS, Spark, Tokens};
use fleetd_contracts::mcp::{OrderGetOutput, OrdersBoardOutput};
use fleetd_contracts::prim::{List, Text};
use fleetd_contracts::train::ChangeState;
use gpui::{App, AppContext, Context, Entity, IntoElement, Render, SharedString, Window, WindowOptions, div, prelude::*, px};
use serde_json::Value;

use super::chips::{phase_chip, pr_chip};
use super::lanes::{Density, FleetLanes};
use super::motion::{self, MotionPref};
use super::state::{LiveState, fmt_iso, parse_ms};
use super::strips::{TrainStrip, machine_strip};
use crate::bench::Probe;
use crate::state::ProjectKey;
use crate::theme::{STRONG, metric, size, theme};

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../../../crates/fleetd-contracts/tests/fixtures/live/", $name))
    };
}

pub const FULL: &str = fixture!("app_server_live_full.json");
pub const DELTA: &str = fixture!("app_server_live_delta.json");
const BOARD: &str = fixture!("orders_board.output.json");
const ORDER: &str = fixture!("order_get.output.json");

/// The fixture's own "now".
const FIXTURE_AT: &str = "2026-10-18T10:07:12.000Z";

pub fn frame_fixture(json: &str) -> LiveFrame {
    match serde_json::from_str(json).expect("live frame fixture") {
        AppServerMessage::Live(frame) => frame,
        other => panic!("not a live frame: {other:?}"),
    }
}

pub fn board_fixture() -> OrdersBoardOutput {
    serde_json::from_str(BOARD).expect("board fixture")
}

pub fn order_fixture() -> OrderGetOutput {
    serde_json::from_str(ORDER).expect("order fixture")
}

/// Moves every timestamp in a fixture by `by_ms`, so the fixture's 10:07 reads as now.
fn shift_times(v: &mut Value, by_ms: i64) {
    match v {
        Value::String(s) => {
            if let Some(ms) = parse_ms(s) {
                *s = fmt_iso(ms + by_ms);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|i| shift_times(i, by_ms)),
        Value::Object(map) => map.values_mut().for_each(|i| shift_times(i, by_ms)),
        _ => {}
    }
}

fn shifted<T: serde::de::DeserializeOwned>(json: &str, by_ms: i64) -> T {
    let mut v: Value = serde_json::from_str(json).expect("fixture");
    shift_times(&mut v, by_ms);
    serde_json::from_value(v).expect("fixture")
}

const ACTIVITIES: &[(&str, &str)] = &[
    ("edit", "crates/fleetd/src/hub/leads/digest.rs"),
    ("command", "cargo test -p fleetd hub::leads"),
    ("search", "fn stalled"),
    ("writing", ""),
    ("read", "crates/fleetd/src/hub/leads/wakes.rs"),
    ("command", "cargo clippy -p fleetd -- -D warnings"),
    ("edit", "crates/fleetd/src/hub/leads/mod.rs"),
    ("thinking", ""),
    ("tool", "docs.rs"),
    ("command", "git diff --stat"),
];

fn activity(ix: usize) -> (Activity, u32) {
    let (kind, arg) = ACTIVITIES[ix % ACTIVITIES.len()];
    match kind {
        "edit" => (Activity::Edit { path: Text::unchecked(arg) }, 16),
        "command" => (Activity::Command { text: Text::unchecked(arg) }, 16),
        "search" => (Activity::Read { path: None, pattern: Some(Text::unchecked(arg)) }, 16),
        "read" => (Activity::Read { path: Some(Text::unchecked(arg)), pattern: None }, 16),
        "tool" => (Activity::Tool { name: Text::unchecked("WebFetch"), detail: Some(Text::unchecked(arg)) }, 16),
        "writing" => (Activity::Writing, 9),
        _ => (Activity::Thinking, 0),
    }
}

/// One simulated agent: what the scripted feed says it does.
struct Sim {
    act: usize,
    since: i64,
    input: u64,
    output: u64,
    bucket: u32,
    samples: VecDeque<u8>,
}

/// A deterministic stand-in for the hub's live pump: real shapes, scripted values.
pub struct Feed {
    rng: u64,
    tick: u64,
    /// Every lane's activity changes every tick (the bench); otherwise about a third do.
    max_rate: bool,
    pub boards: Vec<(ProjectKey, OrdersBoardOutput)>,
    sims: HashMap<String, Sim>,
    next_task: u64,
    next_pr: i64,
    /// Lanes that finished last tick; the next board refetch leaves them out, as the hub's board does.
    finished: Vec<String>,
    /// Lanes that finished, newest first, for the order view's done list.
    pub retired: Vec<AgentLane>,
    machines_json: Value,
}

pub struct Step {
    pub frame: LiveFrame,
    pub boards_changed: bool,
}

impl Feed {
    /// The fixture board as is (W14 and W12 of fleetd), at now.
    pub fn demo(now_ms: i64) -> Self {
        let by = now_ms - parse_ms(FIXTURE_AT).unwrap();
        let board: OrdersBoardOutput = shifted(BOARD, by);
        Self::from_boards(vec![(("forge".into(), "fleetd".into()), board)], false, now_ms)
    }

    /// `orders` copies of W14, `lanes` working lanes each, over five projects.
    pub fn bench(now_ms: i64, orders: usize, lanes: usize) -> Self {
        let by = now_ms - parse_ms(FIXTURE_AT).unwrap();
        let mut base: Value = serde_json::from_str(BOARD).unwrap();
        shift_times(&mut base, by);
        let card = base["orders"][0].clone();
        let template = card["lanes"][0].clone();
        let titles = [
            "Harden lead digest",
            "Test ask batching",
            "Login flow cleanup",
            "Retry overloaded runs",
            "Slot board per project",
            "Trim the thread tail",
        ];
        let mut boards: Vec<(ProjectKey, OrdersBoardOutput)> = Vec::new();
        let mut task = 1000;
        for p in 0..5 {
            let project = format!("project-{p}");
            let mut cards = Vec::new();
            for i in (p..orders).step_by(5) {
                let mut c = card.clone();
                c["workstreamId"] = Value::from(format!("W{}", 100 + i));
                c["projectRef"]["projectId"] = Value::from(project.clone());
                c["title"] = Value::from(titles[i % titles.len()]);
                c["phase"] = Value::from("working");
                c["phaseDetail"] = Value::from(format!("{lanes} working"));
                c["needsYou"] = Value::from(0);
                let roles = ["implementer", "implementer", "reviewer", "verifier"];
                c["lanes"] = Value::Array(
                    (0..lanes)
                        .map(|k| {
                            task += 1;
                            let mut l = template.clone();
                            l["laneId"] = Value::from(format!("T{task}"));
                            l["taskId"] = Value::from(format!("T{task}"));
                            l["role"] = Value::from(roles[k % roles.len()]);
                            l["startedAt"] = Value::from(fmt_iso(now_ms - 1000 * (30 + 37 * k as i64 + 11 * i as i64)));
                            l.as_object_mut().unwrap().remove("live");
                            l
                        })
                        .collect(),
                );
                cards.push(c);
            }
            let out = serde_json::json!({"orders": cards, "trains": if p == 0 { base["trains"].clone() } else { Value::Array(vec![]) }, "at": fmt_iso(now_ms)});
            boards.push((("forge".into(), project), serde_json::from_value(out).unwrap()));
        }
        let mut feed = Self::from_boards(boards, true, now_ms);
        feed.next_task = task + 1;
        feed
    }

    fn from_boards(boards: Vec<(ProjectKey, OrdersBoardOutput)>, max_rate: bool, now_ms: i64) -> Self {
        let full = frame_fixture(FULL);
        let machines_json = serde_json::to_value(full.machines.as_ref().unwrap()).unwrap();
        let mut feed = Self {
            rng: 0x9e37_79b9_7f4a_7c15,
            tick: 0,
            max_rate,
            boards,
            sims: HashMap::new(),
            next_task: 100,
            next_pr: 216,
            finished: Vec::new(),
            retired: Vec::new(),
            machines_json,
        };
        for lane in feed.working().into_iter().map(|(_, _, l)| l) {
            let seed = feed.rand(1000);
            feed.sims.insert(lane, Sim::new(seed as usize, now_ms));
        }
        feed
    }

    fn rand(&mut self, n: u64) -> u64 {
        // xorshift64*: deterministic, so every bench run sees the same script.
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        (self.rng.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 33) % n.max(1)
    }

    /// (board, order, lane id) of every lane that is working.
    fn working(&self) -> Vec<(usize, usize, String)> {
        let mut out = Vec::new();
        for (b, (_, board)) in self.boards.iter().enumerate() {
            for (o, card) in board.orders.iter().enumerate() {
                for l in card.lanes.iter().filter(|l| matches!(l.status, LaneStatus::Working | LaneStatus::Starting)) {
                    out.push((b, o, l.lane_id.to_string()));
                }
            }
        }
        out
    }

    pub fn full_frame(&mut self, now_ms: i64) -> LiveFrame {
        let mut frame = frame_fixture(FULL);
        let lanes = self.working().into_iter().map(|(_, _, id)| self.live_lane(&id, now_ms, true)).collect();
        frame.at = Timestamp::from(fmt_iso(now_ms));
        frame.lanes = List::unchecked(lanes);
        frame.text = List::default();
        frame.machines = Some(self.machines(now_ms));
        frame
    }

    fn live_lane(&self, id: &str, now_ms: i64, with_spark: bool) -> LiveLane {
        let sim = &self.sims[id];
        LiveLane {
            lane_id: Text::unchecked(id),
            status: LaneStatus::Working,
            activity: Some(ActivityNow { activity: activity(sim.act).0, since: Timestamp::from(fmt_iso(sim.since)) }),
            tokens: Some(Tokens { input: sim.input, output: sim.output, cache_read: 0, live: true }),
            spark: with_spark
                .then(|| Spark { end_at: Timestamp::from(fmt_iso(now_ms)), samples: List::unchecked(sim.samples.iter().copied().collect()) }),
        }
    }

    fn machines(&mut self, now_ms: i64) -> List<fleetd_contracts::live::MachineLive, 0, 20> {
        let mut m = self.machines_json.clone();
        let running = self.working().len().min(40);
        m[0]["running"] = Value::from(running);
        m[0]["load"]["load1"] = Value::from(2.0 + self.rand(30) as f64 / 10.);
        m[0]["asOf"] = Value::from(fmt_iso(now_ms));
        m[1]["asOf"] = Value::from(fmt_iso(now_ms - 12 * 60_000));
        serde_json::from_value(m).unwrap()
    }

    /// One 250 ms tick of the scripted hub: activities move on, a sparkline bucket closes every 2 s, every 3 s a
    /// lane finishes and another starts in its order, every 4 s the train moves.
    pub fn step(&mut self, now_ms: i64) -> Step {
        self.tick += 1;
        let mut boards_changed = false;
        for id in std::mem::take(&mut self.finished) {
            for (_, board) in &mut self.boards {
                edit(&mut board.orders, |orders| {
                    for card in orders {
                        edit(&mut card.lanes, |lanes| {
                            if let Some(l) = lanes.iter().find(|l| l.lane_id.as_str() == id) {
                                self.retired.insert(0, l.clone());
                            }
                            lanes.retain(|l| l.lane_id.as_str() != id)
                        });
                    }
                });
            }
            boards_changed = true;
        }
        let roll = self.tick.is_multiple_of(SPARK_BUCKET_TICKS);
        let working = self.working();
        let mut changed = Vec::new();
        for (_, _, id) in &working {
            let move_on = self.max_rate || self.rand(3) == 0;
            let (inc_in, inc_out) = (self.rand(600), 20 + self.rand(90));
            let sim = self.sims.get_mut(id).unwrap();
            if move_on {
                sim.act += 1;
                sim.since = now_ms;
                sim.bucket += activity(sim.act).1;
                sim.input += inc_in;
                sim.output += inc_out;
            }
            if roll {
                sim.samples.push_back(sim.bucket.min(255) as u8);
                while sim.samples.len() > SPARK_BUCKETS {
                    sim.samples.pop_front();
                }
                sim.bucket = 0;
            }
            if move_on || roll {
                changed.push(id.clone());
            }
        }
        let mut lanes: Vec<LiveLane> = changed.iter().map(|id| self.live_lane(id, now_ms, roll)).collect();
        if self.tick.is_multiple_of(12)
            && let Some(done) = self.finish_one(now_ms, &working)
        {
            lanes.push(LiveLane { status: LaneStatus::Done, activity: None, spark: None, ..self.live_lane(&done, now_ms, false) });
            self.finished.push(done);
            boards_changed = true;
        }
        if self.tick.is_multiple_of(16) {
            self.move_train();
            boards_changed = true;
        }
        let machines = (self.tick % 20 == 1).then(|| self.machines(now_ms));
        let frame = LiveFrame {
            at: Timestamp::from(fmt_iso(now_ms)),
            full: false,
            lanes: List::unchecked(lanes),
            text: List::default(),
            machines,
            slots: None,
        };
        if boards_changed {
            for (_, b) in &mut self.boards {
                b.at = Timestamp::from(fmt_iso(now_ms));
            }
        }
        Step { frame, boards_changed }
    }

    /// Marks one working lane done on its board and starts a new lane in the same order.
    fn finish_one(&mut self, now_ms: i64, working: &[(usize, usize, String)]) -> Option<String> {
        if working.is_empty() {
            return None;
        }
        let (b, o, id) = working[self.rand(working.len() as u64) as usize].clone();
        let task = self.next_task;
        self.next_task += 1;
        let found = edit(&mut self.boards[b].1.orders, |orders| {
            edit(&mut orders[o].lanes, |lanes| {
                let ix = lanes.iter().position(|l| l.lane_id.as_str() == id)?;
                lanes[ix].status = LaneStatus::Done;
                lanes[ix].ended_at = Some(Timestamp::from(fmt_iso(now_ms)));
                let mut fresh: AgentLane = lanes[ix].clone();
                fresh.lane_id = Text::unchecked(format!("T{task}"));
                fresh.task_id = Some(fleetd_contracts::tasks::TaskId::unchecked(format!("T{task}")));
                fresh.status = LaneStatus::Starting;
                fresh.started_at = Some(Timestamp::from(fmt_iso(now_ms)));
                fresh.ended_at = None;
                fresh.live = None;
                lanes.push(fresh);
                Some(())
            })
        });
        found?;
        let seed = self.rand(1000) as usize;
        self.sims.insert(format!("T{task}"), Sim::new(seed, now_ms));
        Some(id)
    }

    /// The head merges, the next PR goes to CI, a new one joins the queue.
    fn move_train(&mut self) {
        let next_pr = self.next_pr;
        let Some((_, board)) = self.boards.iter_mut().find(|(_, b)| !b.trains.is_empty()) else { return };
        self.next_pr += 1;
        let chips = edit(&mut board.trains, |trains| {
            move_train(&mut trains[0], next_pr);
            trains[0].chips.clone()
        });
        // The orders' PR rows follow their chips, and an order with no agents left takes its phase from its PRs,
        // as the hub's next orders_board would.
        edit(&mut board.orders, |orders| {
            for card in orders {
                edit(&mut card.prs, |prs| {
                    for pr in prs {
                        if let Some(c) = chips.iter().find(|c| c.change_id == pr.change_id) {
                            pr.state = c.state;
                            pr.position = c.position;
                        }
                    }
                });
                if card.lanes.is_empty() && !card.prs.is_empty() {
                    let open = card.prs.iter().find(|p| p.state != ChangeState::Merged);
                    let (phase, detail) = match open {
                        Some(p) => (OrderPhase::Merging, format!("#{} {}", p.number, if p.state == ChangeState::Ci { "in CI" } else { "merging" })),
                        None => (OrderPhase::Done, format!("done · {} PR{}", card.prs.len(), if card.prs.len() == 1 { "" } else { "s" })),
                    };
                    card.phase = phase;
                    card.phase_detail = Some(Text::unchecked(detail));
                }
            }
        });
    }
}

fn move_train(train: &mut fleetd_contracts::live::TrainLive, number: i64) {
    {
        let mut chips = std::mem::take(&mut train.chips).into_inner();
        let mut merged: Vec<_> = chips.iter().filter(|c| c.state == ChangeState::Merged).cloned().collect();
        chips.retain(|c| c.state != ChangeState::Merged);
        if let Some(head) = chips.first_mut() {
            let mut done = head.clone();
            done.state = ChangeState::Merged;
            done.position = None;
            merged.insert(0, done);
            chips.remove(0);
            train.merged_today = fleetd_contracts::prim::Count::unchecked(train.merged_today.get() + 1);
        }
        if let Some(next) = chips.first_mut() {
            next.state = ChangeState::Ci;
            next.position = None;
        }
        let mut new = merged[0].clone();
        new.number = fleetd_contracts::prim::Positive::unchecked(number);
        new.change_id = fleetd_contracts::train::ChangeId::unchecked(format!("X{number}"));
        new.url = fleetd_contracts::train::GitHubPrUrl::unchecked(format!("https://github.com/wynn-dev/fleetd/pull/{number}"));
        new.state = ChangeState::Reviewing;
        chips.push(new);
        for (i, c) in chips.iter_mut().enumerate().skip(1) {
            c.position = Some(fleetd_contracts::prim::Count::unchecked(i as i64 - 1));
        }
        merged.truncate(3);
        chips.extend(merged);
        train.chips = List::unchecked(chips);
    }
}

/// Ticks of 250 ms per sparkline bucket.
const SPARK_BUCKET_TICKS: u64 = 8;

impl Sim {
    fn new(seed: usize, now_ms: i64) -> Self {
        // A minute of history in the shape of the fixture's T31, started at a different bucket per lane.
        let t31 = frame_fixture(FULL).lanes.iter().find(|l| l.lane_id.as_str() == "T31").and_then(|l| l.spark.clone()).expect("T31 spark");
        let samples = (0..SPARK_BUCKETS).map(|i| t31.samples[(seed + i) % t31.samples.len()]).collect();
        Self { act: seed, since: now_ms, input: 800 + seed as u64 * 3, output: 120 + seed as u64, bucket: 0, samples }
    }
}

/// `List` has no `&mut` access: take the Vec out, edit it, put it back. Fixture-only.
fn edit<T, const MIN: usize, const MAX: usize, const U: bool, R>(list: &mut List<T, MIN, MAX, U>, f: impl FnOnce(&mut Vec<T>) -> R) -> R {
    let mut items = std::mem::take(list).into_inner();
    let out = f(&mut items);
    *list = List::unchecked(items);
    out
}

fn local_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The bench board: the fixture's orders, grouped by project, each with its lanes, then the two strips.
struct BenchBoard {
    feed: Feed,
    state: LiveState,
    lanes: Vec<(fleetd_contracts::ledger::WorkstreamId, Entity<FleetLanes>)>,
    train: Entity<TrainStrip>,
    feeding: bool,
    probe: Option<Probe>,
    /// `FLEETD_LIVE=order`: W14's lanes at order-view density instead of the board, from its `order_get`.
    order: Option<(OrderGetOutput, Entity<FleetLanes>)>,
}

impl BenchBoard {
    fn new(feed: Feed, cx: &mut Context<Self>) -> Self {
        let train = cx.new(|_| TrainStrip::new());
        let mut this = Self { feed, state: LiveState::default(), lanes: Vec::new(), train, feeding: false, probe: None, order: None };
        let now = local_ms();
        for (key, board) in this.feed.boards.clone() {
            this.state.set_board(&key, board);
        }
        let full = this.feed.full_frame(now);
        this.state.apply(full, now);
        this.sync(cx);
        this
    }

    /// Hands every lane list and the train strip what the state now says.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let now = local_ms();
        let hub_now = self.state.hub_now_ms(now);
        let stale = self.state.stale();
        let orders: Vec<_> = self.feed.boards.iter().flat_map(|(k, _)| self.state.orders(k).iter().map(|o| o.workstream_id.clone())).collect();
        for w in orders {
            let lanes = self.state.lanes(&w);
            let entity = match self.lanes.iter().find(|(id, _)| id == &w) {
                Some((_, e)) => e.clone(),
                None => {
                    let e = cx.new(|cx| FleetLanes::new(w.clone(), Density::Card, cx));
                    self.lanes.push((w.clone(), e.clone()));
                    e
                }
            };
            entity.update(cx, |l, cx| l.set(lanes, hub_now, stale, cx));
        }
        if let Some((base, entity)) = &self.order {
            let w = base.order.workstream_id.clone();
            let mut detail = base.clone();
            if let Some(card) = self.feed.boards.iter().flat_map(|(_, b)| b.orders.iter()).find(|o| o.workstream_id == w) {
                detail.order = card.clone();
            }
            detail.done_lanes = List::unchecked(self.feed.retired.iter().chain(base.done_lanes.iter()).take(30).cloned().collect());
            self.state.set_order(detail);
            let lanes = self.state.lanes(&w);
            entity.update(cx, |l, cx| l.set(lanes, hub_now, stale, cx));
        }
        let trains = self.state.trains().to_vec();
        self.train.update(cx, |t, cx| t.set(trains, cx));
        cx.notify();
    }

    fn show_order(&mut self, cx: &mut Context<Self>) {
        let detail: OrderGetOutput = shifted(ORDER, local_ms() - parse_ms(FIXTURE_AT).unwrap());
        let entity = cx.new(|cx| FleetLanes::new(detail.order.workstream_id.clone(), Density::Full, cx));
        self.order = Some((detail, entity));
        self.sync(cx);
    }

    fn step(&mut self, cx: &mut Context<Self>) {
        let now = local_ms();
        let step = self.feed.step(now);
        if step.boards_changed {
            for (key, board) in self.feed.boards.clone() {
                self.state.set_board(&key, board);
            }
        }
        self.state.apply(step.frame, now);
        self.sync(cx);
    }
}

impl Render for BenchBoard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme(cx).clone();
        let now = self.state.hub_now_ms(local_ms());
        if let Some((detail, lanes)) = &self.order {
            let o = &detail.order;
            return div()
                .size_full()
                .flex()
                .flex_col()
                .bg(t.bg)
                .text_color(t.text)
                .font_family(t.ui_font.clone())
                .text_size(px(size::MD))
                .child(
                    div()
                        .h(px(metric::BAR))
                        .px_4()
                        .flex()
                        .items_center()
                        .gap_3()
                        .border_b_1()
                        .border_color(t.hairline)
                        .child(div().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(o.workstream_id.to_string()))
                        .child(div().font_weight(STRONG).child(o.title.to_string()))
                        .child(phase_chip(&t, o.phase, o.phase_detail.as_deref())),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .child(div().w(gpui::relative(0.56)).px_2().py_2().border_r_1().border_color(t.hairline).child(lanes.clone())),
                )
                .child(machine_strip(&t, self.state.machines(), self.state.slots()))
                .child(self.train.clone())
                .into_any_element();
        }
        let groups = self.feed.boards.iter().map(|(key, _)| {
            let orders = self.state.orders(key);
            let cards = orders.iter().map(|o| {
                let lanes = self.lanes.iter().find(|(w, _)| w == &o.workstream_id).map(|(_, e)| e.clone());
                let age = parse_ms(o.created_at.as_str()).map(|c| format!("{}m", ((now - c) / 60_000).max(0))).unwrap_or_default();
                let loud = o.needs_you.get() > 0;
                div()
                    .flex()
                    .flex_col()
                    .pb_2()
                    .child(
                        div()
                            .h(px(metric::ROW))
                            .px_2()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(
                                div()
                                    .w(px(40.))
                                    .flex_none()
                                    .font_family(t.mono_font.clone())
                                    .text_size(px(size::SM))
                                    .text_color(t.quiet)
                                    .child(o.workstream_id.to_string()),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .when(loud, |d| d.font_weight(STRONG))
                                    .child(o.title.to_string()),
                            )
                            .child(phase_chip(&t, o.phase, o.phase_detail.as_deref()))
                            .child(div().flex_1())
                            .child(div().text_size(px(size::XS)).text_color(t.quiet).child(age)),
                    )
                    .child(div().pl(px(48.)).children(lanes))
                    .when(!o.prs.is_empty() || o.next.is_some(), |d| {
                        d.child(
                            div()
                                .pl(px(56.))
                                .h(px(LINE_H))
                                .flex()
                                .items_center()
                                .gap_3()
                                .text_size(px(size::XS))
                                .text_color(t.quiet)
                                .children(o.prs.iter().map(|p| pr_chip(&t, p)))
                                .when_some(o.next.as_ref(), |d, n| d.child(SharedString::from(format!("next: {n}")))),
                        )
                    })
            });
            let settled: i64 = orders.iter().map(|o| o.settled.get()).sum();
            let total: i64 = orders.iter().map(|o| o.total.get()).sum();
            div()
                .flex()
                .flex_col()
                .pt_3()
                .child(div().h(px(metric::ROW)).px_2().flex().items_center().gap_3().child(div().font_weight(STRONG).child(key.1.clone())).child(
                    div().text_size(px(size::XS)).text_color(t.quiet).child(format!("{} orders · {settled}/{total} agents settled", orders.len())),
                ))
                .children(cards)
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .text_color(t.text)
            .font_family(t.ui_font.clone())
            .text_size(px(size::MD))
            .child(div().id("board").flex_1().min_h_0().overflow_y_scroll().px_4().pb_4().child(div().max_w(px(1040.)).children(groups)))
            .child(machine_strip(&t, self.state.machines(), self.state.slots()))
            .child(self.train.clone())
            .into_any_element()
    }
}

const LINE_H: f32 = 22.;

/// Opens the live bench window. `main` calls this for `FLEETD_BENCH=live` instead of opening the shell.
pub fn open_bench(options: WindowOptions, cx: &mut App) {
    motion::init(cx);
    let reduced = std::env::var("FLEETD_MOTION").as_deref() == Ok("reduced");
    // The bench measures motion, so it doesn't follow the host's setting unless asked.
    motion::set_pref(if reduced { MotionPref::Reduced } else { MotionPref::Full }, cx);
    let view = std::env::var("FLEETD_LIVE").unwrap_or_default();
    let demo = matches!(view.as_str(), "demo" | "order");
    cx.open_window(options, move |window, cx| {
        crate::theme::init(window, cx);
        let now = local_ms();
        let feed = if demo { Feed::demo(now) } else { Feed::bench(now, 50, 4) };
        let board = cx.new(|cx| BenchBoard::new(feed, cx));
        board.update(cx, |b, cx| {
            if view == "order" {
                b.show_order(cx);
            }
            if demo {
                b.feeding = true;
            } else {
                b.probe = Some(Probe::new());
                measure(window, cx);
            }
            pump(cx);
        });
        board
    })
    .expect("open window");
}

/// The feed's 4 Hz tick, while `feeding`.
fn pump(cx: &mut Context<BenchBoard>) {
    cx.spawn(async move |this, cx| {
        loop {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let alive = this.update(cx, |b, cx| {
                if b.feeding {
                    b.step(cx);
                }
            });
            if alive.is_err() {
                return;
            }
        }
    })
    .detach();
}

/// First present; then 3 s idle (feed off: only the elapsed tick), 5 s with the feed at its maximum rate, and 5 s
/// paused after every hold and exit the feed started has run out. Reports presented frames/s, the worst frame
/// interval and frame draw times (layout + paint) while live.
fn measure(window: &mut Window, cx: &mut Context<BenchBoard>) {
    let x11 = x11_window_id(window).unwrap_or(0);
    cx.spawn_in(window, async move |this, cx| {
        let wait = async |cx: &mut gpui::AsyncWindowContext, d: Duration| cx.background_executor().timer(d).await;
        let probe = |cx: &mut gpui::AsyncWindowContext, f: &mut dyn FnMut(&mut Probe)| {
            this.update(cx, |b, _| {
                let p = b.probe.as_mut().unwrap();
                p.poll();
                f(p)
            })
            .ok();
        };
        loop {
            wait(cx, Duration::from_millis(10)).await;
            let mut first = None;
            probe(cx, &mut |p| first = p.first_present.map(|at| (p.unix_ns(at), p.first_draw.map_or(0, |d| p.unix_ns(d)), p.draws_to_first_present)));
            if let Some((present, draw, draws)) = first {
                probe(cx, &mut |p| p.emit(&format!("event=first_present unix_ns={present} first_draw_unix_ns={draw} draws={draws} x11_window={x11}")));
                break;
            }
        }
        wait(cx, Duration::from_secs(1)).await;
        let window_fps = async |cx: &mut gpui::AsyncWindowContext, d: Duration| {
            let start = Instant::now();
            probe(cx, &mut |p| p.draw_times.clear());
            wait(cx, d).await;
            let end = Instant::now();
            let mut out = (0., Duration::ZERO, Vec::new());
            probe(cx, &mut |p| {
                let (fps, worst) = crate::bench::scroll_stats(&p.presents, start, end);
                out = (fps, worst, std::mem::take(&mut p.draw_times));
            });
            out
        };
        let (idle_fps, _, _) = window_fps(cx, Duration::from_secs(3)).await;
        this.update(cx, |b, _| b.feeding = true).ok();
        let (live_fps, worst, mut draws) = window_fps(cx, Duration::from_secs(5)).await;
        this.update(cx, |b, _| b.feeding = false).ok();
        wait(cx, super::motion::dur::DONE_HOLD + Duration::from_millis(1500)).await;
        let (paused_fps, _, _) = window_fps(cx, Duration::from_secs(5)).await;
        draws.sort();
        let pick = |q: f64| draws.get(((draws.len().max(1) - 1) as f64 * q).round() as usize).map_or(0, |d| d.as_micros());
        let (lanes, orders) = this.update(cx, |b, _| (b.feed.working().len(), b.lanes.len())).unwrap_or_default();
        let reduced = cx.update(|_, cx| cx.reduce_motion()).unwrap_or(false);
        probe(cx, &mut |p| {
            p.emit(&format!(
                "event=live fps={live_fps:.1} worst_frame_us={} draw_p50_us={} draw_p99_us={} draw_max_us={} frames={} idle_fps={idle_fps:.2} paused_fps={paused_fps:.2} lanes={lanes} orders={orders} reduce_motion={reduced}",
                worst.as_micros(),
                pick(0.5),
                pick(0.99),
                draws.last().map_or(0, |d| d.as_micros()),
                draws.len(),
            ))
        });
        probe(cx, &mut |p| p.emit("event=done"));
        cx.update(|_, cx| cx.quit()).ok();
    })
    .detach();
}

fn x11_window_id(window: &Window) -> Option<u32> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(h) => Some(h.window.get()),
        RawWindowHandle::Xlib(h) => Some(h.window as u32),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bench_feed_keeps_its_shape_while_lanes_come_and_go() {
        let t0 = parse_ms(FIXTURE_AT).unwrap();
        let mut feed = Feed::bench(t0, 50, 4);
        assert_eq!(feed.working().len(), 200);
        let full = feed.full_frame(t0);
        assert_eq!(full.lanes.len(), 200);
        let mut rolled = 0;
        for i in 1..=48 {
            let step = feed.step(t0 + 250 * i);
            // The bench drives every lane every tick: the hub's worst case.
            assert!(step.frame.lanes.len() >= 200);
            rolled += step.frame.lanes.iter().filter(|l| l.spark.is_some()).count();
        }
        // One bucket per 2 s per lane over 12 s.
        assert_eq!(rolled, 6 * 200);
        assert_eq!(feed.working().len(), 200, "a finished lane is replaced in its order");
    }

    #[test]
    fn fixture_times_move_to_now() {
        let now = parse_ms("2026-11-01T12:00:00Z").unwrap();
        let feed = Feed::demo(now);
        assert_eq!(parse_ms(feed.boards[0].1.at.as_str()), Some(now));
        assert!(order_fixture().done_lanes.len() == 1);
    }
}
