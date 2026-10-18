//! One row per agent of an order: role, model, what it is doing now, elapsed, a sparkline of the last minute
//! and its tokens. `Density::Card` is the board (one line per lane, at most 4 rows, finished lanes hold 8 s
//! then leave); `Density::Full` is the order view (two or three lines per lane, a status header, finished
//! lanes folded into "done (n)" as short reports).
//!
//! Rows enter and leave with `motion::enter_sized`/`exit_sized`, driven by a [`Presence`] diff of what the
//! hub sent, so a row moves only when a lane arrived or went. The elapsed labels are the only thing that
//! changes without an event: one app-wide 1 Hz ticker re-renders the lane lists that have a running clock and
//! were drawn since the last tick, and stops when none has.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::live::{AgentLane, LaneId, LaneStatus};
use fleetd_contracts::train::GitHubPrUrl;
use gpui::{
    Animation, AnimationExt, AnyElement, App, Context, Div, EventEmitter, Global, Hsla, IntoElement, Render, SharedString, Task, WeakEntity, Window,
    div, ease_out_quint, prelude::*, px,
};

use super::activity::{self, describe};
use super::chips::{pr_chip, role_tag};
use super::motion::{self, Presence, dur};
use super::spark::sparkline;
use super::state::{fleet_summary, fmt_elapsed, fmt_tokens, is_final, is_running, parse_ms};
use crate::theme::{STRONG, Theme, metric, radius, size, theme};
use crate::ui;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Density {
    Card,
    Full,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LaneEvent {
    Open(LaneId),
    OpenPr(GitHubPrUrl),
}

/// Rows a card shows; past this the last row says "+N more agents".
const CARD_ROWS: usize = 4;
pub const LANE_ROW_H: f32 = 24.;
const SPARK_W: f32 = 48.;
const SPARK_H: f32 = 12.;
const MODEL_W: f32 = 72.;
const CLOCK_W: f32 = 44.;
const TOKENS_W: f32 = 40.;

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
            drawn_at: Instant::now(),
            wake: None,
        }
    }

    pub fn workstream(&self) -> &WorkstreamId {
        &self.workstream
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
            // A lane the board saw finish stays for the rest of its hold; anything else leaves now.
            let exit_at = match self.ended.get(&id) {
                Some(&at) if self.density == Density::Card => (at + dur::DONE_HOLD).max(now),
                _ => now,
            };
            self.gone.push(Gone { lane, index, exit_at });
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
        self.lanes = lanes;
        self.stale = stale;
        self.schedule(cx);
        if self.has_clock() {
            Ticker::join(cx.entity().downgrade(), cx);
        }
        cx.notify();
    }

    /// The order view lists active lanes and folds finished ones; a card lists everything it was given.
    fn listed(&self, lane: &AgentLane) -> bool {
        self.density == Density::Card || !is_final(lane.status)
    }

    fn has_clock(&self) -> bool {
        self.lanes.iter().any(|l| is_running(l.status) && l.started_at.is_some() && l.ended_at.is_none())
    }

    fn exit_start(&self, lane: &AgentLane) -> Option<Instant> {
        if self.density != Density::Card {
            return None;
        }
        self.ended.get(lane.lane_id.as_str()).map(|&at| at + dur::DONE_HOLD)
    }

    /// One timer, for the next row to start or finish leaving.
    fn schedule(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let starts = self.lanes.iter().filter_map(|l| self.exit_start(l)).chain(self.gone.iter().map(|g| g.exit_at));
        let next = starts.flat_map(|s| [s, s + dur::EXIT]).filter(|&due| due > now).min();
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

    fn row_height(&self, lane: &AgentLane) -> f32 {
        match self.density {
            Density::Card => LANE_ROW_H,
            Density::Full => {
                let third = lane.branch.is_some() || lane.pr.is_some();
                LANE_ROW_H + metric::LINE + if third { metric::LINE } else { 0. } + 6.
            }
        }
    }

    fn row(&self, t: &Theme, lane: &AgentLane, cx: &mut Context<Self>) -> Div {
        let id = lane.lane_id.to_string();
        let open = lane.lane_id.clone();
        let hover = t.hover;
        let said = describe(lane);
        let line = || activity::render(t, &said, self.stale);
        let live = lane.live.as_ref();
        let running = !is_final(lane.status) && lane.status != LaneStatus::Queued;
        let clock = lane.started_at.as_ref().and_then(|s| parse_ms(s.as_str())).filter(|_| lane.status != LaneStatus::Queued).map(|start| {
            let end = lane.ended_at.as_ref().and_then(|e| parse_ms(e.as_str())).unwrap_or_else(|| self.hub_now());
            fmt_elapsed(end - start)
        });
        let tokens = live.and_then(|l| l.tokens.as_ref()).map(|tk| fmt_tokens(tk.input + tk.output));
        let mono = |s: String, w: f32| {
            div().w(px(w)).flex_none().flex().justify_end().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(s)
        };
        let figures = div()
            .flex()
            .flex_none()
            .items_center()
            .gap_3()
            .child(mono(clock.unwrap_or_default(), CLOCK_W))
            .child(if running {
                sparkline(t, live.and_then(|l| l.spark.as_ref()), px(SPARK_W), px(SPARK_H))
            } else {
                div().w(px(SPARK_W)).flex_none().into_any_element()
            })
            .child(mono(tokens.unwrap_or_default(), TOKENS_W));
        let model = match (self.density, lane.model.as_deref().map(short_model), lane.effort) {
            (Density::Full, Some(m), Some(e)) => format!("{m} · {}", effort_word(e)),
            (_, Some(m), _) => m.to_string(),
            _ => String::new(),
        };
        let head = div()
            .h(px(LANE_ROW_H))
            .flex()
            .items_center()
            .gap_2()
            .child(self.status_dot(t, lane))
            .child(role_tag(t, lane.role))
            .when(self.density == Density::Full, |d| {
                d.when_some(lane.task_id.as_ref(), |d, task| {
                    d.child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(task.to_string()))
                })
            })
            .child(
                div()
                    .w(px(MODEL_W))
                    .flex_none()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(model),
            )
            .child(if self.density == Density::Card { line().flex_1() } else { div().flex_1() })
            .child(figures);
        let body = div()
            .id(SharedString::from(format!("lane-{id}")))
            .w_full()
            .px_2()
            .rounded(px(radius::SM))
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(LaneEvent::Open(open.clone()))))
            .child(head);
        if self.density == Density::Card {
            return div().child(body);
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
        div().pb(px(6.)).child(body.child(div().h(px(metric::LINE)).pl(px(15.)).flex().items_center().child(line())).children(third))
    }

    /// The lane's status dot; a status change crossfades its colour over 120 ms.
    fn status_dot(&self, t: &Theme, lane: &AgentLane) -> AnyElement {
        let id = lane.lane_id.to_string();
        let to = status_color(t, lane.status);
        let Some(&before) = self.was.get(&id) else { return ui::dot(to).into_any_element() };
        let from = status_color(t, before);
        // The animator rebuilds the dot at the blended colour; a dot has no state to keep.
        div()
            .flex_none()
            .child(ui::dot(to))
            .with_animation(
                SharedString::from(format!("st-{id}-{:?}", lane.status)),
                Animation::new(dur::MICRO).with_easing(ease_out_quint()),
                move |_, p| div().flex_none().child(ui::dot(mix(from, to, p))),
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
            .when(self.stale, |d| d.child(div().text_color(t.faint).child("live feed reconnecting")))
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
                .child(ui::dot(status_color(t, l.status)))
                .child(role_tag(t, l.role))
                .when_some(l.task_id.as_ref(), |d, task| {
                    d.child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(task.to_string()))
                })
                .child(div().min_w_0().overflow_hidden().text_ellipsis().child(report(l)))
        });
        Some(div().flex().flex_col().child(toggle).when(open, |d| d.children(reports)))
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
        let overflow = self.density == Density::Card && rows.len() > CARD_ROWS;
        let shown = if overflow { CARD_ROWS - 1 } else { rows.len() };
        for (lane, leaving) in rows.iter().take(shown) {
            let id = lane.lane_id.to_string();
            let h = px(self.row_height(lane));
            let row = self.row(&t, lane, cx);
            list = list.child(match leaving {
                Some(start) => motion::exit_sized(SharedString::from(format!("out-{id}-{start:?}")), row, h),
                None if self.arrived.contains(&id) => motion::enter_sized(SharedString::from(format!("in-{id}")), row, h),
                None => row.into_any_element(),
            });
        }
        if overflow {
            let first_hidden = rows[shown].0.lane_id.clone();
            let hover = t.hover;
            list = list.child(
                div()
                    .id("more-lanes")
                    .h(px(LANE_ROW_H))
                    .px_2()
                    .flex()
                    .items_center()
                    .rounded(px(radius::SM))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(format!("+{} more agents", rows.len() - shown))
                    .on_click(cx.listener(move |_, _, _, cx| cx.emit(LaneEvent::Open(first_hidden.clone())))),
            );
        }
        if self.density == Density::Full {
            list = list.children(self.done_fold(&t, cx));
        }
        list
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
