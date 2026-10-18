//! One row per agent of an order: role, model, what it is doing now, elapsed, a sparkline of its work and its
//! tokens, with the role's tint on the row's edge, its tag and its sparkline. Every agent gets a row: lists
//! tighten when they are long (once, for good: see [`latch_compact`]) and scroll past [`MAX_ROWS`]. `Density::Card`
//! is a board card (one line per lane, finished lanes hold 8 s with a check, then leave); `Density::Stage` is the
//! one active order given the whole board, as structure (`fleet`): the writers still writing, then a group per PR
//! with its checkers indented under it, a finished agent folding into its group's summary, and the order's finish;
//! `Density::Full` is the order view (two or three lines per lane, a status header, finished lanes folded into
//! "done (n)" as short reports).
//!
//! Rows enter with `motion::enter_sized` and leave with `motion::exit_fade` then `exit_collapse`, driven by a
//! [`Presence`] diff of what the hub sent, so a row moves only when a lane arrived or went. The elapsed labels are the only thing that
//! changes without an event: one app-wide 1 Hz ticker re-renders the lane lists that have a running clock and
//! were drawn since the last tick, and stops when none has.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::live::{AgentLane, LaneId, LaneStatus, OrderPhase, PrRef};
use fleetd_contracts::train::GitHubPrUrl;
use gpui::{
    Animation, AnimationExt, AnyElement, App, Context, Div, EventEmitter, Global, Hsla, IntoElement, Render, SharedString, Task, WeakEntity, Window,
    div, ease_out_quint, prelude::*, px,
};

use super::activity::{self, describe};
use super::chips::{check, pr_chip, pr_track, role_tag, role_tint, stage_tone, tone_color};
use super::fleet::{Group, finished, fleet, latch_compact};
use super::motion::{self, Presence, dur};
use super::spark::sparkline;
use super::state::{fleet_activity, fleet_summary, fmt_elapsed, fmt_tokens, is_final, is_running, parse_ms};
use crate::theme::{STRONG, Theme, metric, radius, size, theme};
use crate::ui;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Density {
    Card,
    Stage,
    Full,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LaneEvent {
    Open(LaneId),
    OpenPr(GitHubPrUrl),
    /// "Show full prompt": what this lane's session was told, and who it is ("the lead", "T31").
    Told(ThreadRef, String),
}

/// Rows shown before the list scrolls.
pub const MAX_ROWS: usize = 12;
/// Past this many rows a list takes its compact row height.
const COMPACT_AFTER: usize = 6;
pub const LANE_ROW_H: f32 = 24.;
/// The stage's header line: what the fleet is doing, and for how long.
const STAGE_HEAD_H: f32 = 32.;
const MODEL_W: f32 = 56.;
/// The status mark's column: a check, a dot, or nothing while the agent works.
const MARK_W: f32 = 9.;
/// A stage row taller than this has two lines.
const TWO_LINE_H: f32 = 40.;
/// The task title's column on a one-line stage row.
const STAGE_TITLE_W: f32 = 150.;
/// How far a PR's checkers sit in from the writers, under their PR.
const GROUP_INDENT: f32 = 24.;
/// A PR group's header row.
const GROUP_H: f32 = 30.;
const CLOCK_W: f32 = 44.;
const TOKENS_W: f32 = 40.;

/// Row geometry per density, with `rows` rows listed.
struct Geom {
    row_h: f32,
    spark_w: f32,
    spark_h: f32,
    /// The activity line's word size.
    words: f32,
    edge: f32,
}

fn geom(density: Density, compact: bool) -> Geom {
    match density {
        Density::Stage => Geom { row_h: if compact { 32. } else { 54. }, spark_w: 120., spark_h: 26., words: size::MD, edge: 3. },
        Density::Card => Geom { row_h: if compact { 22. } else { LANE_ROW_H }, spark_w: 72., spark_h: 14., words: size::XS, edge: 2. },
        Density::Full => Geom { row_h: LANE_ROW_H, spark_w: 72., spark_h: 14., words: size::XS, edge: 2. },
    }
}

struct Gone {
    lane: AgentLane,
    index: usize,
    exit_at: Instant,
}

pub struct FleetLanes {
    workstream: WorkstreamId,
    density: Density,
    lanes: Vec<AgentLane>,
    gone: Vec<Gone>,
    presence: Presence<String>,
    /// Lanes that arrived after the list first loaded: they animate in.
    arrived: HashSet<String>,
    /// The status each lane had before its latest change, for the dot's crossfade.
    was: HashMap<String, LaneStatus>,
    /// When each lane was first seen finished: the board holds it this long before it leaves.
    ended: HashMap<String, Instant>,
    /// hub clock - local clock, ms.
    skew_ms: i64,
    stale: bool,
    done_open: bool,
    /// The stage's order: when it started, for the header's clock.
    started_ms: Option<i64>,
    /// The list went compact once and stays so (see [`latch_compact`]).
    compact: bool,
    /// Every lane this order has shown, at its latest: the stage's groups count finished agents from it.
    seen: Vec<AgentLane>,
    /// The order's PRs and phase, for the stage's groups and finish.
    prs: Vec<PrRef>,
    phase: Option<OrderPhase>,
    /// When the stage first saw every PR merged (hub ms): the finish's clock stops there.
    finished_at: Option<i64>,
    drawn_at: Instant,
    wake: Option<Task<()>>,
}

impl EventEmitter<LaneEvent> for FleetLanes {}

impl FleetLanes {
    pub fn new(workstream: WorkstreamId, density: Density, _cx: &mut Context<Self>) -> Self {
        Self {
            workstream,
            density,
            lanes: Vec::new(),
            gone: Vec::new(),
            presence: Presence::default(),
            arrived: HashSet::new(),
            was: HashMap::new(),
            ended: HashMap::new(),
            skew_ms: 0,
            stale: false,
            done_open: false,
            started_ms: None,
            compact: false,
            seen: Vec::new(),
            prs: Vec::new(),
            phase: None,
            finished_at: None,
            drawn_at: Instant::now(),
            wake: None,
        }
    }

    pub fn workstream(&self) -> &WorkstreamId {
        &self.workstream
    }

    /// The stage's density follows the board: a lone active order takes the stage, then gives it back.
    pub fn set_density(&mut self, density: Density, started_ms: Option<i64>, cx: &mut Context<Self>) {
        if self.density == density && self.started_ms == started_ms {
            return;
        }
        self.density = density;
        self.started_ms = started_ms;
        if self.has_clock() {
            Ticker::join(cx.entity().downgrade(), cx);
        }
        cx.notify();
    }

    /// The order's PRs and phase, which the stage groups its agents under.
    pub fn set_order(&mut self, prs: Vec<PrRef>, phase: OrderPhase, cx: &mut Context<Self>) {
        if self.prs == prs && self.phase == Some(phase) {
            return;
        }
        self.prs = prs;
        self.phase = Some(phase);
        self.note_finish();
        cx.notify();
    }

    fn note_finish(&mut self) {
        if finished(&self.lanes, &self.prs) {
            self.finished_at.get_or_insert(self.hub_now());
        } else {
            self.finished_at = None;
        }
    }

    pub fn set(&mut self, lanes: Vec<AgentLane>, hub_now_ms: i64, stale: bool, cx: &mut Context<Self>) {
        self.skew_ms = hub_now_ms - local_ms();
        if lanes == self.lanes && stale == self.stale {
            return;
        }
        let now = Instant::now();
        let ids: Vec<String> = lanes.iter().filter(|l| self.listed(l)).map(|l| l.lane_id.to_string()).collect();
        let diff = self.presence.diff(ids);
        self.arrived.extend(diff.entered);
        for id in diff.left {
            self.arrived.remove(&id);
            let Some(index) = self.lanes.iter().position(|l| l.lane_id.as_str() == id) else { continue };
            let lane = self.lanes[index].clone();
            if let Some(exit_at) = leave_at(self.ended.get(&id).copied(), self.holds_done(), now) {
                self.gone.push(Gone { lane, index, exit_at });
            }
        }
        for lane in &lanes {
            let id = lane.lane_id.to_string();
            if let Some(old) = self.lanes.iter().find(|l| l.lane_id == lane.lane_id)
                && old.status != lane.status
            {
                self.was.insert(id.clone(), old.status);
            }
            if is_final(lane.status) {
                self.ended.entry(id).or_insert(now);
            }
        }
        // A lane that came back (e.g. retried) is no longer leaving.
        self.gone.retain(|g| !lanes.iter().any(|l| l.lane_id == g.lane.lane_id));
        // Forget lanes that are neither listed nor leaving, so a long session doesn't accumulate them.
        let shown: HashSet<String> =
            lanes.iter().map(|l| &l.lane_id).chain(self.gone.iter().map(|g| &g.lane.lane_id)).map(|id| id.to_string()).collect();
        self.was.retain(|id, _| shown.contains(id));
        self.ended.retain(|id, _| shown.contains(id));
        self.arrived.retain(|id| shown.contains(id));
        for lane in &lanes {
            match self.seen.iter_mut().find(|l| l.lane_id == lane.lane_id) {
                Some(old) => *old = lane.clone(),
                None => self.seen.push(lane.clone()),
            }
        }
        let listed = lanes.iter().filter(|l| self.listed(l)).count();
        self.compact = latch_compact(self.compact, listed, COMPACT_AFTER);
        self.lanes = lanes;
        self.stale = stale;
        self.note_finish();
        self.schedule(cx);
        if self.has_clock() {
            Ticker::join(cx.entity().downgrade(), cx);
        }
        cx.notify();
    }

    /// A card and the stage show a finished lane with its check for a while, then let it go.
    fn holds_done(&self) -> bool {
        self.density != Density::Full
    }

    /// The order view lists active lanes and folds finished ones; a card lists everything it was given.
    fn listed(&self, lane: &AgentLane) -> bool {
        self.holds_done() || !is_final(lane.status)
    }

    fn has_clock(&self) -> bool {
        let stage = self.density == Density::Stage && self.started_ms.is_some() && !self.lanes.is_empty();
        stage || self.lanes.iter().any(|l| is_running(l.status) && l.started_at.is_some() && l.ended_at.is_none())
    }

    fn exit_start(&self, lane: &AgentLane) -> Option<Instant> {
        if !self.holds_done() {
            return None;
        }
        self.ended.get(lane.lane_id.as_str()).map(|&at| at + dur::DONE_HOLD)
    }

    /// One timer, for the next row to start or finish leaving.
    fn schedule(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let starts = self.lanes.iter().filter_map(|l| self.exit_start(l)).chain(self.gone.iter().map(|g| g.exit_at));
        let next = starts.flat_map(|s| [s, s + motion::EXIT_FADE, s + dur::EXIT]).filter(|&due| due > now).min();
        self.wake = next.map(|due| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(due.saturating_duration_since(Instant::now()) + Duration::from_millis(5)).await;
                this.update(cx, |this, cx| {
                    let now = Instant::now();
                    this.gone.retain(|g| g.exit_at + dur::EXIT > now);
                    this.schedule(cx);
                    cx.notify();
                })
                .ok();
            })
        });
    }

    fn hub_now(&self) -> i64 {
        local_ms() + self.skew_ms
    }

    /// The rows in list order, leaving ones back at their old place; `Some(start)` once a row is leaving.
    fn rows(&self, now: Instant) -> Vec<(AgentLane, Option<Instant>)> {
        let mut rows: Vec<(AgentLane, Option<Instant>)> = self
            .lanes
            .iter()
            .filter(|l| self.listed(l))
            .filter_map(|l| match self.exit_start(l) {
                Some(s) if now >= s + dur::EXIT => None,
                Some(s) if now >= s => Some((l.clone(), Some(s))),
                _ => Some((l.clone(), None)),
            })
            .collect();
        for g in &self.gone {
            if now < g.exit_at + dur::EXIT {
                let leaving = (now >= g.exit_at).then_some(g.exit_at);
                rows.insert(g.index.min(rows.len()), (g.lane.clone(), leaving));
            }
        }
        rows
    }

    /// The height `render` draws now, rows still leaving included. A parent that mounts this as a cached view
    /// must give it this height: a cached view is laid out at the size its parent says, not its content's.
    pub fn height(&self) -> f32 {
        let rows = self.rows(Instant::now());
        let mut h = 0.;
        match self.density {
            Density::Full => {
                h += metric::ROW;
                if self.lanes.is_empty() {
                    return h + metric::LINE;
                }
            }
            Density::Stage if !rows.is_empty() => h += STAGE_HEAD_H,
            Density::Stage => {}
            Density::Card => {}
        }
        let g = geom(self.density, self.compact);
        h += rows.iter().take(MAX_ROWS).map(|(l, _)| self.row_height(l, &g)).sum::<f32>();
        if self.density == Density::Full {
            let done = self.lanes.iter().filter(|l| is_final(l.status)).count();
            if done > 0 {
                h += LANE_ROW_H * if self.done_open { 1 + done } else { 1 } as f32;
            }
        }
        h
    }

    fn row_height(&self, lane: &AgentLane, g: &Geom) -> f32 {
        match self.density {
            Density::Card | Density::Stage => g.row_h,
            Density::Full => {
                let third = lane.branch.is_some() || lane.pr.is_some();
                LANE_ROW_H + metric::LINE + if third { metric::LINE } else { 0. } + 6.
            }
        }
    }

    fn row(&self, t: &Theme, lane: &AgentLane, g: &Geom, indent: f32, cx: &mut Context<Self>) -> Div {
        let id = lane.lane_id.to_string();
        let open = lane.lane_id.clone();
        let hover = t.hover;
        let said = describe(lane);
        let live = lane.live.as_ref();
        let running = !is_final(lane.status) && lane.status != LaneStatus::Queued;
        let working = matches!(lane.status, LaneStatus::Working | LaneStatus::Starting);
        let stage = self.density == Density::Stage;
        let line = || activity::render_at(t, &said, self.stale, g.words, working);
        let tint = role_tint(t, lane.role);
        let now = self.hub_now();
        let started = lane.started_at.as_ref().and_then(|s| parse_ms(s.as_str())).filter(|_| lane.status != LaneStatus::Queued);
        let clock = started.map(|start| {
            let end = lane.ended_at.as_ref().and_then(|e| parse_ms(e.as_str())).unwrap_or(now);
            fmt_elapsed(end - start)
        });
        // How long the current step has run: the line ticks while a command or the model takes its time.
        // Waiting on the model shows its time from the first second ("thinking 0:12"), the quiet state; a tool
        // step shows it once it has taken a while.
        let step = (stage && working)
            .then(|| live.and_then(|l| l.activity.as_ref()).and_then(|a| parse_ms(a.since.as_str())))
            .flatten()
            .map(|since| now - since)
            .filter(|ms| said.waiting || *ms >= 2000)
            .map(fmt_elapsed);
        let tokens = live.and_then(|l| l.tokens.as_ref()).map(|tk| fmt_tokens(tk.input + tk.output));
        let mono = |s: String, w: f32, color: Hsla| {
            div().w(px(w)).flex_none().flex().justify_end().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(color).child(s)
        };
        let figures = div()
            .flex()
            .flex_none()
            .items_center()
            .gap_3()
            .child(mono(clock.unwrap_or_default(), CLOCK_W, if working { t.text } else { t.quiet }))
            .child(if running {
                sparkline(live.and_then(|l| l.spark.as_ref()), started, tint, px(g.spark_w), px(g.spark_h))
            } else {
                div().w(px(g.spark_w)).flex_none().into_any_element()
            })
            .child(mono(tokens.unwrap_or_default(), TOKENS_W, t.quiet));
        let model = match (self.density, lane.model.as_deref().map(short_model), lane.effort) {
            (Density::Full, Some(m), Some(e)) => format!("{m} · {}", effort_word(e)),
            (_, Some(m), _) => m.to_string(),
            _ => String::new(),
        };
        let one_line = self.density != Density::Full;
        // The stage, while it has room, gives each agent two lines: what it is for, then what it is doing now.
        let two_line = stage && g.row_h > TWO_LINE_H;
        let doing = || {
            let step_el =
                step.clone().map(|s| div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(s));
            // The line takes the room and cuts with "…"; a cut needs a width to cut at.
            div().flex_1().min_w_0().flex().items_center().gap_2().child(line().flex_1()).children(step_el)
        };
        let title = |w: Option<f32>, text_size: f32, color: Hsla| {
            div()
                .when_some(w, |d, w| d.w(px(w)).flex_none())
                .when(w.is_none(), |d| d.flex_1())
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(text_size))
                .text_color(color)
                .child(lane.title.to_string())
        };
        let model_el = div()
            .w(px(if self.density == Density::Full { 72. } else { MODEL_W }))
            .flex_none()
            .overflow_hidden()
            .text_ellipsis()
            .whitespace_nowrap()
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .child(model);
        let head = div()
            .h(px(if two_line {
                28.
            } else if one_line {
                g.row_h
            } else {
                LANE_ROW_H
            }))
            .flex()
            .items_center()
            .gap_2()
            .child(self.status_mark(t, lane))
            .child(role_tag(t, lane.role, if stage { size::SM } else { size::XS }))
            .when(self.density == Density::Full, |d| {
                d.when_some(lane.task_id.as_ref(), |d, task| {
                    d.child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(task.to_string()))
                })
            })
            .map(|d| {
                if two_line {
                    d.child(title(None, size::MD, if working { t.text } else { t.quiet })).child(model_el)
                } else if stage {
                    d.child(title(Some(STAGE_TITLE_W), size::SM, t.quiet)).child(doing())
                } else if one_line {
                    d.child(model_el).child(doing())
                } else {
                    d.child(model_el).child(div().flex_1())
                }
            })
            .child(figures);
        let head = if two_line {
            // The second line starts under the title: past the mark, the role and their gaps.
            div().child(head).child(div().h(px(20.)).pl(px(MARK_W + 8. + super::chips::ROLE_W + 8.)).flex().items_center().child(doing()))
        } else {
            head
        };
        // The role's edge: solid while the agent works, faint once it is done or before it starts.
        let edge = div()
            .absolute()
            .left_0()
            .top(px(if one_line { g.row_h * 0.2 } else { 5. }))
            .bottom(px(if one_line { g.row_h * 0.2 } else { 5. }))
            .w(px(g.edge))
            .rounded(px(g.edge))
            .bg(if working || lane.status == LaneStatus::Waiting { tint } else { tint.opacity(0.35) });
        let body = div()
            .id(SharedString::from(format!("lane-{id}")))
            .relative()
            .w_full()
            .pl(px(g.edge + 8.))
            .pr_2()
            .rounded(px(radius::SM))
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(LaneEvent::Open(open.clone()))))
            .child(edge)
            .child(head);
        if one_line {
            // The indent is the wrapper's padding, so an indented row is narrower rather than pushed off the edge.
            return div().pl(px(indent)).child(body);
        }
        let branch = lane.branch.as_ref().map(|b| b.to_string());
        let third = (branch.is_some() || lane.pr.is_some()).then(|| {
            let mut d = div().h(px(metric::LINE)).pl(px(15.)).flex().items_center().gap_1().text_size(px(size::XS)).text_color(t.quiet);
            if let Some(b) = branch {
                d = d.child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .font_family(t.mono_font.clone())
                        .text_size(px(size::SM))
                        .child(b),
                );
            }
            if let Some(pr) = &lane.pr {
                let url = pr.url.clone();
                d = d.when(lane.branch.is_some(), |d| d.child("·")).child(
                    div()
                        .id(SharedString::from(format!("lane-pr-{id}")))
                        .cursor_pointer()
                        .child(pr_chip(t, pr))
                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(LaneEvent::OpenPr(url.clone())))),
                );
            }
            d
        });
        let told = lane.thread_ref.clone().map(|thread| {
            let who = lane.task_id.as_ref().map_or_else(|| "the lead".to_string(), |t| t.to_string());
            ui::clickable(t, div().id(SharedString::from(format!("lane-told-{id}"))))
                .flex_none()
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .hover(|s| s.underline())
                .child("Show full prompt")
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.stop_propagation();
                    cx.emit(LaneEvent::Told(thread.clone(), who.clone()));
                }))
        });
        let second = div().h(px(metric::LINE)).pl(px(15.)).flex().items_center().gap_3().child(line().flex_1().min_w_0()).children(told);
        div().pb(px(6.)).child(body.child(second).children(third))
    }

    /// The lane's status mark: a check once it is done; nothing while it works (its edge says so); else a dot in
    /// the status's colour. A status change crossfades the colour over 120 ms.
    fn status_mark(&self, t: &Theme, lane: &AgentLane) -> AnyElement {
        match lane.status {
            LaneStatus::Done => return check(t.success, MARK_W).into_any_element(),
            LaneStatus::Working | LaneStatus::Starting => return div().flex_none().w(px(MARK_W)).into_any_element(),
            _ => {}
        }
        let id = lane.lane_id.to_string();
        let to = status_color(t, lane.status);
        // Every mark takes the check's width, so the role column lines up whatever the status.
        let slot = || div().flex_none().w(px(MARK_W)).flex().justify_center();
        let Some(&before) = self.was.get(&id) else { return slot().child(ui::dot(to)).into_any_element() };
        let from = status_color(t, before);
        // The animator rebuilds the dot at the blended colour; a dot has no state to keep.
        slot()
            .child(ui::dot(to))
            .with_animation(
                SharedString::from(format!("st-{id}-{:?}", lane.status)),
                Animation::new(dur::MICRO).with_easing(ease_out_quint()),
                move |_, p| div().flex_none().w(px(MARK_W)).flex().justify_center().child(ui::dot(mix(from, to, p))),
            )
            .into_any_element()
    }

    fn full_header(&self, t: &Theme) -> Div {
        div()
            .h(px(metric::ROW))
            .px_2()
            .flex()
            .items_center()
            .gap_3()
            .text_size(px(size::XS))
            .child(div().font_weight(STRONG).text_color(t.quiet).child("Fleet"))
            .child(div().text_color(t.quiet).child(fleet_summary(&self.lanes)))
            .when(self.stale, |d| d.child(div().text_color(t.quiet).italic().child("live feed reconnecting")))
    }

    /// What the fleet is doing, counted from the rows drawn under it, and how long the order has run.
    fn stage_header(&self, t: &Theme, drawn: &[AgentLane]) -> Div {
        let doing = match fleet_activity(drawn) {
            d if !d.is_empty() => d,
            // Nobody at work but PRs on their way: say so rather than leave the line blank.
            _ => {
                let moving = self.prs.iter().filter(|p| p.state != fleetd_contracts::train::ChangeState::Merged).count();
                if moving == 0 {
                    "agents done".into()
                } else {
                    format!("agents done · {moving} PR{} in the train", if moving == 1 { "" } else { "s" })
                }
            }
        };
        let clock = self.started_ms.map(|s| fmt_elapsed(self.hub_now() - s));
        div()
            .h(px(STAGE_HEAD_H))
            .px_2()
            .flex()
            .items_center()
            .gap_3()
            .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().text_color(t.text).child(doing))
            .when(self.stale, |d| d.child(div().text_size(px(size::XS)).text_color(t.quiet).italic().child("live feed reconnecting")))
            .when_some(clock, |d, c| d.child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(c)))
    }

    fn done_fold(&self, t: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let done: Vec<&AgentLane> = self.lanes.iter().filter(|l| is_final(l.status)).collect();
        if done.is_empty() {
            return None;
        }
        let open = self.done_open;
        let hover = t.hover;
        let toggle = div()
            .id("done-fold")
            .h(px(LANE_ROW_H))
            .px_2()
            .flex()
            .items_center()
            .gap_1()
            .rounded(px(radius::SM))
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .child(if open { "▾" } else { "▸" })
            .child(format!("done ({})", done.len()))
            .on_click(cx.listener(|this, _, _, cx| {
                this.done_open = !this.done_open;
                cx.notify();
            }));
        let reports = done.into_iter().map(|l| {
            div()
                .h(px(LANE_ROW_H))
                .px_2()
                .flex()
                .items_center()
                .gap_2()
                .whitespace_nowrap()
                .text_size(px(size::XS))
                .text_color(if l.status == LaneStatus::Failed { t.danger } else { t.quiet })
                .child(if l.status == LaneStatus::Done { check(t.success, 9.) } else { ui::dot(status_color(t, l.status)) })
                .child(role_tag(t, l.role, size::XS))
                .when_some(l.task_id.as_ref(), |d, task| {
                    d.child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(task.to_string()))
                })
                .child(div().min_w_0().overflow_hidden().text_ellipsis().child(report(l)))
        });
        Some(div().flex().flex_col().child(toggle).when(open, |d| d.children(reports)))
    }
}

impl FleetLanes {
    /// A row at its place in the list: entering, steady, or leaving (fading, then its empty space closing).
    fn placed_row(&self, t: &Theme, lane: &AgentLane, leaving: Option<Instant>, g: &Geom, indent: f32, cx: &mut Context<Self>) -> AnyElement {
        let id = lane.lane_id.to_string();
        let h = px(self.row_height(lane, g));
        match leaving {
            Some(start) if Instant::now() >= start + motion::EXIT_FADE => motion::exit_collapse(SharedString::from(format!("gap-{id}-{start:?}")), h),
            Some(start) => motion::exit_fade(SharedString::from(format!("out-{id}-{start:?}")), self.row(t, lane, g, indent, cx), h),
            None if self.arrived.contains(&id) => motion::enter_sized(SharedString::from(format!("in-{id}")), self.row(t, lane, g, indent, cx), h),
            None => self.row(t, lane, g, indent, cx).into_any_element(),
        }
    }

    /// The stage: what the fleet is doing, the writers still writing, then each PR with its checkers; or, once
    /// every PR merged and nobody works, the finish.
    fn stage_body(&self, t: &Theme, rows: &[(AgentLane, Option<Instant>)], cx: &mut Context<Self>) -> Div {
        let drawn: Vec<AgentLane> = rows.iter().map(|(l, _)| l.clone()).collect();
        let leaving = |l: &AgentLane| rows.iter().find(|(r, _)| r.lane_id == l.lane_id).and_then(|(_, s)| *s);
        let mut body = div().flex().flex_col().w_full();
        if self.finished_at.is_some() {
            return body.child(self.finish(t));
        }
        let f = fleet(&drawn, &self.seen, &self.prs);
        if drawn.is_empty() && f.groups.is_empty() {
            return body;
        }
        body = body.child(self.stage_header(t, &drawn));
        let g = geom(Density::Stage, self.compact);
        for lane in &f.writers {
            body = body.child(self.placed_row(t, lane, leaving(lane), &g, 0., cx));
        }
        for group in &f.groups {
            body = body.child(self.group_header(t, group));
            for lane in &group.rows {
                body = body.child(self.placed_row(t, lane, leaving(lane), &g, GROUP_INDENT, cx));
            }
        }
        for lane in &f.others {
            body = body.child(self.placed_row(t, lane, leaving(lane), &g, 0., cx));
        }
        body
    }

    /// "#115  write alpha.md  ▰▱▱ review 1/3   ✓ written in 0:18"
    fn group_header(&self, t: &Theme, group: &Group) -> Div {
        let pr = &group.pr;
        let written = group.writer.as_ref().filter(|w| w.status == LaneStatus::Done).and_then(|w| {
            let (a, b) = (parse_ms(w.started_at.as_ref()?.as_str())?, parse_ms(w.ended_at.as_ref()?.as_str())?);
            Some(format!("written in {}", fmt_elapsed(b - a)))
        });
        let title = group.writer.as_ref().map_or_else(|| format!("PR #{}", pr.number), |w| w.title.to_string());
        let all_checked = group.checks_needed > 0 && group.checks_done >= group.checks_needed;
        div()
            .h(px(GROUP_H))
            .mt_1()
            .px_2()
            .flex()
            .items_center()
            .gap_3()
            .child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.text).child(format!("#{}", pr.number)))
            .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().text_color(t.text).child(title))
            .child(pr_track(t, pr.change_id.as_str(), pr.state, group.review_progress()))
            .child(div().flex_none().text_size(px(size::XS)).text_color(tone_color(t, stage_tone(pr.state))).child(group.label()))
            .child(div().flex_1())
            .when_some(written, |d, w| {
                d.child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap_1()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .child(check(t.success, MARK_W))
                        .child(w),
                )
            })
            .when(all_checked && group.rows.is_empty(), |d| {
                d.child(div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(format!(
                    "{} check{}",
                    group.checks_done,
                    if group.checks_done == 1 { "" } else { "s" }
                )))
            })
    }

    /// "✓ 3 PRs merged · 1:52 · 12 agents", or "merged 3/3 · lead closing" while the lead still has to close the
    /// order; then what landed, a line per PR.
    fn finish(&self, t: &Theme) -> Div {
        let n = self.prs.len();
        let agents = self.seen.len();
        let took = match (self.started_ms, self.finished_at) {
            (Some(a), Some(b)) => Some(fmt_elapsed(b - a)),
            _ => None,
        };
        let closed = self.phase == Some(OrderPhase::Done);
        let mut head: Vec<String> =
            vec![if closed { format!("{n} PR{} merged", if n == 1 { "" } else { "s" }) } else { format!("merged {n}/{n} · lead closing") }];
        head.extend(took);
        head.push(format!("{agents} agent{}", if agents == 1 { "" } else { "s" }));
        let f = fleet(&[], &self.seen, &self.prs);
        let lines = f.groups.into_iter().map(|g| {
            let title = g.writer.as_ref().map_or_else(|| format!("PR #{}", g.pr.number), |w| w.title.to_string());
            div()
                .h(px(26.))
                .pl(px(MARK_W + 8. + 8.))
                .flex()
                .items_center()
                .gap_3()
                .child(
                    div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.text).child(format!("#{}", g.pr.number)),
                )
                .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().text_color(t.text).child(title))
                .child(div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(format!("{} checks", g.checks_done)))
                .child(div().flex_none().text_size(px(size::XS)).text_color(t.success).child("merged"))
        });
        div()
            .pt_2()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(STAGE_HEAD_H))
                    .px_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(check(t.success, MARK_W + 2.))
                    .child(div().text_color(t.text).font_weight(STRONG).child(head.join(" · "))),
            )
            .children(lines)
    }
}

impl Render for FleetLanes {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.drawn_at = Instant::now();
        let t = theme(cx).clone();
        let rows = self.rows(Instant::now());
        let mut list = div().flex().flex_col().w_full();
        if self.density == Density::Full {
            list = list.child(self.full_header(&t));
            if self.lanes.is_empty() {
                return list.child(
                    div().px_2().text_size(px(size::XS)).text_color(t.quiet).child("No agents yet. The lead starts them after it freezes the brief."),
                );
            }
        }
        if self.density == Density::Stage {
            return list.child(self.stage_body(&t, &rows, cx));
        }
        let g = geom(self.density, self.compact);
        let mut body = div().flex().flex_col().w_full();
        for (lane, leaving) in &rows {
            body = body.child(self.placed_row(&t, lane, *leaving, &g, 0., cx));
        }
        list = if rows.len() > MAX_ROWS {
            let h: f32 = rows.iter().take(MAX_ROWS).map(|(l, _)| self.row_height(l, &g)).sum();
            list.child(div().id("lanes-scroll").h(px(h)).flex_none().overflow_y_scroll().child(body))
        } else {
            list.child(body)
        };
        if self.density == Density::Full {
            list = list.children(self.done_fold(&t, cx));
        }
        list
    }
}

/// When a lane that left the list starts its exit: a lane seen finishing stays for the rest of its hold, anything
/// else leaves now. `None` when its hold and exit already played (a settled lane kept on after it collapsed): it
/// is gone from view, and playing the exit again would bring the row back for a moment.
fn leave_at(ended: Option<Instant>, holds_done: bool, now: Instant) -> Option<Instant> {
    match ended {
        Some(at) if holds_done => {
            let start = at + dur::DONE_HOLD;
            (now < start + dur::EXIT).then(|| start.max(now))
        }
        _ => Some(now),
    }
}

/// What a finished lane did: "done in 3:02 · #211 · ran 14 commands (1 failed) · changed 4 files".
pub fn report(lane: &AgentLane) -> String {
    let mut parts = vec![describe(lane).words];
    // describe() already names a done lane's PR.
    if lane.status != LaneStatus::Done
        && let Some(pr) = &lane.pr
    {
        parts.push(format!("#{}", pr.number));
    }
    if let Some(r) = &lane.receipts {
        let failed = if r.commands_failed.get() > 0 { format!(" ({} failed)", r.commands_failed) } else { String::new() };
        if r.commands.get() > 0 {
            parts.push(format!("ran {} command{}{failed}", r.commands, if r.commands.get() == 1 { "" } else { "s" }));
        }
        if r.files_changed.get() > 0 {
            parts.push(format!("changed {} file{}", r.files_changed, if r.files_changed.get() == 1 { "" } else { "s" }));
        }
    }
    parts.join(" · ")
}

/// "claude-haiku-5-5" -> "haiku"; anything unfamiliar is shown whole.
pub fn short_model(model: &str) -> &str {
    ["haiku", "sonnet", "opus", "fable"].into_iter().find(|f| model.split(['-', '_', '.']).any(|p| p == *f)).unwrap_or(model)
}

fn effort_word(e: Effort) -> &'static str {
    match e {
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
        Effort::Max => "max",
    }
}

fn status_color(t: &Theme, s: LaneStatus) -> Hsla {
    match s {
        LaneStatus::Waiting => t.warning,
        LaneStatus::Failed => t.danger,
        LaneStatus::Done => t.success,
        LaneStatus::Starting | LaneStatus::Working | LaneStatus::Stalled => t.quiet,
        LaneStatus::Queued | LaneStatus::Idle | LaneStatus::Parked | LaneStatus::Cancelled => t.faint,
    }
}

fn mix(a: Hsla, b: Hsla, p: f32) -> Hsla {
    let (a, b) = (a.to_rgb(), b.to_rgb());
    gpui::Rgba { r: a.r + (b.r - a.r) * p, g: a.g + (b.g - a.g) * p, b: a.b + (b.b - a.b) * p, a: a.a + (b.a - a.a) * p }.into()
}

fn local_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The one 1 Hz clock for every lane list's elapsed labels: they all change on the same frame, once a second,
/// and only while some list with a running lane is on screen.
#[derive(Default)]
struct Ticker {
    lists: Vec<WeakEntity<FleetLanes>>,
    running: bool,
}

impl Global for Ticker {}

impl Ticker {
    fn join(list: WeakEntity<FleetLanes>, cx: &mut App) {
        let ticker = cx.default_global::<Ticker>();
        if !ticker.lists.iter().any(|l| l == &list) {
            ticker.lists.push(list);
        }
        if ticker.running {
            return;
        }
        ticker.running = true;
        cx.spawn(async move |cx| {
            loop {
                let to_next_second = 1000 - local_ms().rem_euclid(1000) as u64;
                cx.background_executor().timer(Duration::from_millis(to_next_second + 2)).await;
                let more = cx.update(|cx| {
                    let lists = std::mem::take(&mut cx.default_global::<Ticker>().lists);
                    let mut keep = Vec::new();
                    for weak in lists {
                        let ticking = weak.update(cx, |l, cx| {
                            // Not drawn since the last tick: off screen, or the window is hidden.
                            if l.has_clock() && l.drawn_at.elapsed() < Duration::from_millis(1500) {
                                cx.notify();
                            }
                            l.has_clock()
                        });
                        if ticking.unwrap_or(false) {
                            keep.push(weak);
                        }
                    }
                    let ticker = cx.default_global::<Ticker>();
                    ticker.lists.extend(keep);
                    ticker.running = !ticker.lists.is_empty();
                    ticker.running
                });
                if !more {
                    return;
                }
            }
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lane_that_already_collapsed_does_not_leave_again() {
        let t0 = Instant::now();
        // Finished and left at once: it holds, then exits.
        assert_eq!(leave_at(Some(t0), true, t0), Some(t0 + dur::DONE_HOLD));
        // Left midway through its exit: the exit carries on from now.
        let mid = t0 + dur::DONE_HOLD + dur::EXIT / 2;
        assert_eq!(leave_at(Some(t0), true, mid), Some(mid));
        // Dropped long after it collapsed (the board keeps a settled lane for a minute): nothing to play.
        assert_eq!(leave_at(Some(t0), true, t0 + Duration::from_secs(60)), None);
        // Never seen finishing, or a view that folds finished lanes: it leaves now.
        assert_eq!(leave_at(None, true, mid), Some(mid));
        assert_eq!(leave_at(Some(t0), false, mid), Some(mid));
    }

    #[test]
    fn model_names_shorten_to_their_family() {
        assert_eq!(short_model("claude-haiku-5-5"), "haiku");
        assert_eq!(short_model("claude-opus-5-5"), "opus");
        assert_eq!(short_model("gpt-x"), "gpt-x");
    }

    #[test]
    fn a_finished_lane_reads_as_a_short_report() {
        let lane: AgentLane = serde_json::from_value(serde_json::json!({
            "laneId": "T30", "role": "implementer", "title": "x", "status": "done",
            "startedAt": "2026-10-18T10:00:00Z", "endedAt": "2026-10-18T10:03:02Z",
            "receipts": {"commands": 14, "commandsFailed": 1, "filesChanged": 4, "toolCalls": 30},
            "pr": {"changeId": "X11", "repo": "acme/storefront", "number": 211, "url": "https://github.com/acme/storefront/pull/211",
                   "state": "merged", "reviewsDone": 2, "reviewsNeeded": 2}
        }))
        .unwrap();
        assert_eq!(report(&lane), "done in 3:02 · #211 · ran 14 commands (1 failed) · changed 4 files");
        let failed = AgentLane {
            status: LaneStatus::Failed,
            status_reason: Some(fleetd_contracts::prim::Text::unchecked("tests failed (exit 101)")),
            receipts: None,
            ..lane
        };
        assert_eq!(report(&failed), "failed: tests failed (exit 101) · #211");
    }
}
