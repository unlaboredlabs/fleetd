//! The time inspector (docs/build/time-inspector-spec.md §8): where an order's, a project's or the fleet's agent
//! time went. One filter bar over three tabs: the timeline (an order's lanes: agents, its PR, each CI check and its
//! asks), the breakdown (share per category, slowest commands, CI checks, time on you, the critical path) and the
//! insights (the hub's deterministic rules). Every number is the hub's (`time_*` tools); the app lays them out and
//! says plainly where a figure is a bound or a split rather than a measurement (spec §2f).
//!
//! Nothing here polls. A running order's open view refetches on the hub events that change it (`state.rs`).

pub mod breakdown;
pub mod filters;
pub mod fixture;
pub mod insights;
pub mod timeline;

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::live::AgentRole;
use fleetd_contracts::mcp::{TailItem, TailRole, TimeBreakdownInput, TimeBreakdownOutput, TimeInsightsInput, TimeInsightsOutput};
use fleetd_contracts::time::{Category, Period, Span, SpanKind, SpanStatus, TimeFilters, TimeScope};
use gpui::{
    Background, Bounds, Context, Div, Entity, EventEmitter, FocusHandle, Focusable, Hsla, KeyDownEvent, Pixels, SharedString, Stateful,
    UniformListScrollHandle, Window, anchored, deferred, div, pattern_slash, point, prelude::*, px, solid_background,
};

use crate::input::TextInput;
use crate::live::chips::role_word;
use crate::state::{Linked, LinkedSpans, ProjectKey, State, TimeQuery, TranscriptWindow};
use crate::theme::{STRONG, Theme, metric, radius, size, theme};
use crate::ui::{self, Variant};
use filters::Filters;
use timeline::Model;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Timeline,
    Breakdown,
    Insights,
}

pub enum TimeEvent {
    /// Scope, filters or period changed: ask the hub again.
    Query(Box<TimeQuery>),
    Linked(Linked),
    CloseLinked,
    Window {
        machine: String,
        thread: String,
        item: String,
    },
    CloseWindow,
    /// "Show in thread": the order view this lane belongs to.
    OpenOrder(String),
    /// The filters changed; the shell saves them.
    Save(Filters),
}

/// What the hub's ids are called on screen: lanes by their live role and task, PRs by number, orders by title.
#[derive(Clone, Default)]
pub struct Names {
    /// thread id → (role, task id, title).
    pub threads: HashMap<String, (AgentRole, Option<String>, String)>,
    /// The projects' lead threads.
    pub leads: HashSet<String>,
    /// change id → PR number.
    pub changes: HashMap<String, i64>,
    /// order id → (title, project title).
    pub orders: HashMap<String, (String, String)>,
    pub projects: Vec<(ProjectKey, String)>,
    pub machines: Vec<String>,
}

impl Names {
    pub fn from_state(state: &State) -> Self {
        let mut n = Names::default();
        for row in &state.projects {
            let key = row.key();
            n.projects.push((key.clone(), row.summary.title.clone()));
            if let Some(lead) = row.lead() {
                n.leads.insert(lead.thread_id.to_string());
            }
            for ws in row.outcome.iter().flat_map(|o| o.workstreams.iter().flatten()) {
                n.orders.insert(ws.workstream_id.to_string(), (ws.title.to_string(), row.summary.title.clone()));
            }
            for card in state.live.orders(&key) {
                n.orders.insert(card.workstream_id.to_string(), (card.title.to_string(), row.summary.title.clone()));
                for pr in card.prs.iter() {
                    n.changes.insert(pr.change_id.to_string(), pr.number.get());
                }
                for lane in card.lanes.iter() {
                    if let Some(t) = &lane.thread_ref {
                        n.threads.insert(t.thread_id.to_string(), (lane.role, lane.task_id.as_ref().map(|t| t.to_string()), lane.title.to_string()));
                    }
                }
            }
        }
        if let Some(order) = &state.order {
            for lane in state.live.lanes(&WorkstreamId::unchecked(&order.workstream_id)) {
                if let Some(t) = &lane.thread_ref {
                    n.threads.insert(t.thread_id.to_string(), (lane.role, lane.task_id.as_ref().map(|t| t.to_string()), lane.title.to_string()));
                }
            }
        }
        n.machines = state.machines.iter().map(|m| m.machine_id.to_string()).collect();
        n
    }
}

/// What the pointer is over on the timeline.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Hover {
    Bar { row: usize, bar: timeline::Bar, at: gpui::Point<Pixels> },
    Lane { row: usize, at: gpui::Point<Pixels> },
    Path { seg: usize, at: gpui::Point<Pixels> },
}

/// Bars a finding or a breakdown row points at, drawn at full strength while the rest recede.
#[derive(Clone)]
pub(crate) struct Highlight {
    pub ids: Rc<HashSet<i64>>,
    pub title: String,
    pub linked: Linked,
    /// Matched here by kind, label and check (not listed by the hub), so new spans are matched again.
    pub matched: bool,
}

pub struct TimeView {
    pub(crate) order: Option<String>,
    pub(crate) tab: Tab,
    pub(crate) filters: Filters,
    pub(crate) names: Names,
    version: Option<u64>,
    pub(crate) model: Option<Rc<Model>>,
    pub(crate) breakdown: Option<Result<TimeBreakdownOutput, String>>,
    pub(crate) insights: Option<Result<TimeInsightsOutput, String>>,
    pub(crate) linked: LinkedSpans,
    pub(crate) window: TranscriptWindow,
    pub(crate) spans_done: bool,
    pub(crate) spans_error: Option<String>,
    /// The zoomed range, hub ms; None shows the whole order.
    pub(crate) view: Option<(i64, i64)>,
    /// A drag on the tracks, window x: (from, to).
    pub(crate) drag: Option<(f32, f32)>,
    pub(crate) hover: Option<Hover>,
    pub(crate) highlight: Option<Highlight>,
    pub(crate) menu: Option<filters::Menu>,
    pub(crate) custom: (Entity<TextInput>, Entity<TextInput>),
    pub(crate) custom_error: Option<String>,
    /// Where the tracks are on screen, written as they paint, so a pointer x maps to a time.
    pub(crate) track: Rc<Cell<Bounds<Pixels>>>,
    /// The first row's top, for placing a card over a row picked without the pointer (the bench).
    pub(crate) row0: Rc<Cell<Pixels>>,
    /// A bench state asked for before the data arrived.
    bench_pending: Option<String>,
    pub(crate) scroll: UniformListScrollHandle,
    pub(crate) now_ms: i64,
    focus: FocusHandle,
}

impl EventEmitter<TimeEvent> for TimeView {}

impl Focusable for TimeView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The lookback for an order's own spans: everything the hub can still have.
const ORDER_LOOKBACK_MS: i64 = 365 * 86_400_000;

impl TimeView {
    pub fn new(filters: Filters, cx: &mut Context<Self>) -> Self {
        let since = cx.new(|cx| TextInput::new(cx).placeholder("2026-10-12 09:00").borderless());
        let until = cx.new(|cx| TextInput::new(cx).placeholder("now").borderless());
        Self {
            order: None,
            tab: Tab::Breakdown,
            filters,
            names: Names::default(),
            version: None,
            model: None,
            breakdown: None,
            insights: None,
            linked: None,
            window: None,
            spans_done: false,
            spans_error: None,
            view: None,
            drag: None,
            hover: None,
            highlight: None,
            menu: None,
            custom: (since, until),
            custom_error: None,
            track: Rc::new(Cell::new(Bounds::default())),
            row0: Rc::new(Cell::new(px(0.))),
            bench_pending: None,
            scroll: UniformListScrollHandle::new(),
            now_ms: 0,
            focus: cx.focus_handle(),
        }
    }

    /// Opens on an order (its timeline) or on the fleet as the filters say (its breakdown).
    pub fn open(&mut self, order: Option<String>, now_ms: i64, cx: &mut Context<Self>) {
        self.tab = if order.is_some() {
            Tab::Timeline
        } else if self.tab == Tab::Timeline {
            Tab::Breakdown
        } else {
            self.tab
        };
        self.order = order;
        self.now_ms = now_ms;
        self.reset_view();
        self.ask(cx);
    }

    pub fn set_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        if tab == Tab::Timeline && self.order.is_none() {
            return;
        }
        self.tab = tab;
        self.hover = None;
        cx.notify();
    }

    fn reset_view(&mut self) {
        self.view = None;
        self.drag = None;
        self.hover = None;
        self.highlight = None;
        self.menu = None;
        self.version = None;
        self.model = None;
    }

    /// The scope the filters and the open order make: an order, else a project, else a machine, else the fleet.
    pub fn scope(&self) -> TimeScope {
        if let Some(w) = &self.order {
            return TimeScope::Order { workstream_id: WorkstreamId::unchecked(w) };
        }
        if let Some((m, p)) = &self.filters.project {
            return TimeScope::Project { project_ref: ProjectRef { machine_id: MachineId::unchecked(m), project_id: ProjectId::unchecked(p) } };
        }
        if let Some(m) = &self.filters.machine {
            return TimeScope::Machine { machine_id: MachineId::unchecked(m) };
        }
        TimeScope::Fleet
    }

    pub fn query(&self) -> TimeQuery {
        let scope = self.scope();
        let order = self.order.is_some();
        let (since, until) =
            if order { (self.now_ms - ORDER_LOOKBACK_MS, None) } else { filters::period(self.filters.range, self.now_ms, self.filters.custom) };
        let ts = |ms: i64| Timestamp::from(crate::live::state::fmt_iso(ms));
        let end = until.unwrap_or(self.now_ms);
        let compare = (self.filters.compare && !order).then(|| Period { since: ts(since - (end - since)), until: ts(since) });
        let tf = TimeFilters {
            // The scope already carries the project or machine it is for; the role narrows any scope.
            project_ref: None,
            machine_id: match (&self.filters.machine, &scope) {
                (Some(m), TimeScope::Project { .. }) => Some(MachineId::unchecked(m)),
                _ => None,
            },
            role: self.filters.role,
        };
        TimeQuery {
            breakdown: TimeBreakdownInput { scope: scope.clone(), since: ts(since), until: until.map(ts), compare: compare.clone(), filters: tf },
            insights: TimeInsightsInput { scope: scope.clone(), since: ts(since), until: until.map(ts), compare },
            spans: order,
            scope,
        }
    }

    pub(crate) fn ask(&mut self, cx: &mut Context<Self>) {
        let q = self.query();
        cx.emit(TimeEvent::Query(Box::new(q)));
        cx.notify();
    }

    pub(crate) fn filters_changed(&mut self, cx: &mut Context<Self>) {
        self.menu = None;
        cx.emit(TimeEvent::Save(self.filters.clone()));
        self.ask(cx);
    }

    /// Takes the hub's latest answers; rebuilds the timeline only when something new arrived.
    pub fn sync(&mut self, state: &State, now_ms: i64, cx: &mut Context<Self>) {
        self.now_ms = now_ms;
        let t = &state.time;
        if self.version == Some(t.version) {
            return;
        }
        self.version = Some(t.version);
        self.names = Names::from_state(state);
        self.breakdown = t.breakdown.clone();
        self.insights = t.insights.clone();
        self.linked = t.linked.clone();
        self.window = t.window.clone();
        self.spans_done = t.spans_done;
        self.spans_error = t.spans_error.clone();
        let path = self.breakdown.as_ref().and_then(|b| b.as_ref().ok()).and_then(|b| b.critical_path.clone());
        self.model = (self.order.is_some() && !t.spans.is_empty()).then(|| Rc::new(Model::build(&t.spans, path.as_ref(), &self.names, now_ms)));
        if let Some(h) = self.highlight.clone().filter(|h| h.matched && self.model.is_some()) {
            self.highlight_local(h.linked, h.title, None);
        }
        if let Some(extra) = self.bench_pending.take() {
            self.bench_extra(&extra, cx);
        }
        cx.notify();
    }

    /// Lights the open order's bars a finding or a row means. `ids` when the hub listed them (a finding's
    /// `spanIds`); otherwise matched on the spans here by kind, label and check.
    pub(crate) fn highlight_local(&mut self, linked: Linked, title: String, ids: Option<&[i64]>) {
        let set: HashSet<i64> = match (ids, &self.model) {
            (Some(ids), _) => ids.iter().copied().collect(),
            (None, Some(m)) => m.spans.iter().filter(|s| linked.keeps(s)).map(|s| s.id.get()).collect(),
            (None, None) => HashSet::new(),
        };
        self.highlight = Some(Highlight { ids: Rc::new(set), title, linked, matched: ids.is_none() });
        self.tab = Tab::Timeline;
    }

    /// "Show spans": on an order, its own timeline lit up; elsewhere the hub lists them.
    pub(crate) fn show_linked(&mut self, linked: Linked, ids: Option<Vec<i64>>, cx: &mut Context<Self>) {
        if self.order.is_some() {
            let title = linked.title.clone();
            self.highlight_local(linked, title, ids.as_deref());
        } else {
            cx.emit(TimeEvent::Linked(linked));
        }
        cx.notify();
    }

    pub(crate) fn clear_highlight(&mut self, cx: &mut Context<Self>) {
        self.highlight = None;
        cx.notify();
    }

    /// A click on a span of a session: its transcript, opened at that item.
    pub(crate) fn open_transcript(&mut self, span: &Span, cx: &mut Context<Self>) -> bool {
        let (Some(machine), Some(thread), Some(item)) = (&span.machine_id, &span.thread_id, &span.item_id) else { return false };
        cx.emit(TimeEvent::Window { machine: machine.to_string(), thread: thread.to_string(), item: item.to_string() });
        true
    }

    /// Screenshots: open the view in a given state. `transcript` opens a failed full-suite run's transcript,
    /// `highlight` lights the first finding's spans, `hover` points at a full-suite run, `zoom` zooms to it.
    pub fn bench_extra(&mut self, extra: &str, cx: &mut Context<Self>) {
        let Some(m) = self.model.clone().filter(|_| self.insights.is_some()) else {
            self.bench_pending = Some(extra.to_string());
            return;
        };
        let suite = m.items.iter().position(|it| {
            let s = &m.spans[it.span];
            s.label.as_deref() == Some("npm test") && s.status == SpanStatus::Failed
        });
        match extra {
            "transcript" => {
                if let Some(ix) = suite {
                    let span = m.spans[m.items[ix].span].clone();
                    self.open_transcript(&span, cx);
                }
            }
            "highlight" => {
                if let Some(Ok(out)) = &self.insights
                    && let Some(first) = out.insights.first()
                {
                    let ids: Vec<i64> = first.span_ids.iter().map(|i| i.get()).collect();
                    let linked = Linked { title: first.message.to_string(), rule: Some(first.rule), kinds: Vec::new(), label: None, check: None };
                    self.show_linked(linked, Some(ids), cx);
                }
            }
            "zoom" | "hover" => {
                let Some(ix) = suite else { return };
                let it = m.items[ix];
                if extra == "zoom" {
                    self.view = Some((it.start - 6 * 60_000, it.end + 4 * 60_000));
                    return;
                }
                // The track's size is known after the first frame.
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(std::time::Duration::from_millis(600)).await;
                    this.update(cx, |v, cx| {
                        let Some(row) = m.rows.iter().position(|r| r.items.contains(&ix)) else { return };
                        let bars = v.row_bars_pub(&m, row);
                        if let Some(bar) = bars.into_iter().find(|b| (b.first..b.first + b.n as usize).contains(&ix)) {
                            let b = v.track.get();
                            let at = point(b.origin.x + px((bar.x0 + bar.x1) / 2.), v.row0.get() + px(26. * row as f32 + 13.));
                            v.hover = Some(Hover::Bar { row, bar, at });
                            cx.notify();
                        }
                    })
                    .ok();
                })
                .detach();
            }
            _ => {}
        }
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key != "escape" {
            return;
        }
        // Esc closes the innermost thing: a menu, a sheet, the highlight, then the zoom.
        let closed = self.menu.take().is_some()
            || if self.window.is_some() {
                cx.emit(TimeEvent::CloseWindow);
                true
            } else if self.linked.is_some() {
                cx.emit(TimeEvent::CloseLinked);
                true
            } else {
                self.highlight.take().is_some() || self.view.take().is_some()
            };
        if !closed {
            return;
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn head(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let b = self.breakdown.as_ref().and_then(|b| b.as_ref().ok());
        let title: SharedString = match &self.order {
            Some(w) => self.names.orders.get(w).map_or_else(|| w.clone(), |(title, _)| title.clone()).into(),
            None => "Where the time went".into(),
        };
        let mut figures = Vec::new();
        if let Some(b) = b {
            let wall = b.wall_ms.get();
            let agent = b.agent_ms.get();
            let word = if self.order.is_some() { "wall" } else { "wall of orders" };
            figures.push(format!("{word} {}", fmt_dur(wall)));
            if let Some(p) = &b.critical_path {
                figures.push(format!("path {}", fmt_dur(p.end_ms.get() - p.start_ms.get())));
            }
            figures.push(format!("agents {}", fmt_dur(agent)));
            if wall > 0 {
                figures.push(format!("{:.1}× in parallel", agent as f64 / wall as f64));
            }
        }
        let tab = |id: &'static str, label: &'static str, tab: Tab, enabled: bool, cx: &mut Context<Self>| {
            let on = self.tab == tab;
            ui::button(t, id, label, if on { Variant::Secondary } else { Variant::Ghost }, enabled)
                .when(enabled, |b| b.on_click(cx.listener(move |this, _, _, cx| this.set_tab(tab, cx))))
        };
        div()
            .h(px(metric::BAR))
            .flex_none()
            .px_4()
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(t.hairline)
            .when_some(self.order.clone(), |d, w| {
                let project = self.names.orders.get(&w).map(|(_, p)| format!("{p} ›")).unwrap_or_default();
                d.child(ui::button(t, "time-back", "‹ Order", Variant::Ghost, true).on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(TimeEvent::OpenOrder(w.clone()));
                })))
                .child(div().text_color(t.quiet).child(project))
                .child(
                    div().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(self.order.clone().unwrap_or_default()),
                )
            })
            .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().font_weight(STRONG).child(title))
            .child(div().flex_1())
            .child(div().flex_none().text_size(px(size::XS)).text_color(t.quiet).whitespace_nowrap().child(figures.join(" · ")))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .gap_1()
                    .child(tab("time-tab-timeline", "Timeline", Tab::Timeline, self.order.is_some(), cx))
                    .child(tab("time-tab-breakdown", "Breakdown", Tab::Breakdown, true, cx))
                    .child(tab("time-tab-insights", "Insights", Tab::Insights, true, cx)),
            )
    }

    /// The transcript sheet: the items around the clicked span, that one marked, with a way to the full thread.
    fn transcript_sheet(&self, t: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let ((_, thread, _), answer) = self.window.clone()?;
        let lane = self.names.threads.get(&thread);
        let who = lane.map_or_else(|| thread.clone(), |(role, task, _)| format!("{} {}", role_word(*role), task.clone().unwrap_or_default()));
        let order = self.order.clone();
        let body: gpui::AnyElement = match answer {
            None => ui::loading(t, "Asking the machine for this part of the transcript…").into_any_element(),
            Some(Err(e)) => div().p_4().child(ui::quiet(t, e)).into_any_element(),
            Some(Ok(w)) if w.focus.is_none() => div()
                .p_4()
                .whitespace_normal()
                .child(ui::quiet(t, "The machine no longer has this item: its session was cleaned up. The span's numbers above still stand."))
                .into_any_element(),
            Some(Ok(w)) => {
                let focus = w.focus.map(|f| f.get() as usize);
                let mut list = div().id("time-transcript").flex_1().min_h_0().overflow_y_scroll().px_2().py_2().flex().flex_col().gap_1();
                for (ix, it) in w.items.iter().enumerate() {
                    list = list.child(transcript_item(t, it, Some(ix) == focus));
                }
                list.into_any_element()
            }
        };
        Some(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(px(440.))
                .flex()
                .flex_col()
                .bg(t.raised)
                .border_l_1()
                .border_color(t.border)
                .shadow(t.float_shadow())
                .occlude()
                .child(
                    div()
                        .h(px(metric::BAR))
                        .flex_none()
                        .px_4()
                        .flex()
                        .items_center()
                        .gap_2()
                        .border_b_1()
                        .border_color(t.hairline)
                        .child(div().font_weight(STRONG).child("Transcript"))
                        .child(div().text_size(px(size::XS)).text_color(t.quiet).child(who))
                        .child(div().flex_1())
                        .when_some(order, |d, w| {
                            d.child(ui::button(t, "time-in-thread", "Show in order", Variant::Ghost, true).on_click(cx.listener(
                                move |_, _, _, cx| {
                                    cx.emit(TimeEvent::OpenOrder(w.clone()));
                                },
                            )))
                        })
                        .child(
                            ui::button(t, "time-sheet-close", "Close", Variant::Secondary, true)
                                .on_click(cx.listener(|_, _, _, cx| cx.emit(TimeEvent::CloseWindow))),
                        ),
                )
                .child(
                    div()
                        .px_4()
                        .pt_2()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .child("What the agent said and ran around the span you clicked, which is marked."),
                )
                .child(body),
        )
    }

    /// The spans a finding or row links to, one per line, as `fleetd time --spans` prints them.
    fn linked_sheet(&self, t: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let (linked, answer) = self.linked.clone()?;
        let body: gpui::AnyElement = match answer {
            None => ui::loading(t, "Asking the hub for these spans…").into_any_element(),
            Some(Err(e)) => div().p_4().child(ui::quiet(t, e)).into_any_element(),
            Some(Ok(spans)) if spans.is_empty() => div().p_4().child(ui::quiet(t, "No spans in this period.")).into_any_element(),
            Some(Ok(spans)) => {
                let n = spans.len();
                let mut list = div().id("time-linked").flex_1().min_h_0().overflow_y_scroll().px_2().py_1().flex().flex_col();
                for s in spans.into_iter() {
                    let id = s.id.get();
                    let row_name = lane_name(&self.names, &s);
                    let clickable = s.item_id.is_some() && s.thread_id.is_some();
                    let span = s.clone();
                    list = list.child(
                        ui::row(t, SharedString::from(format!("linked-{id}")), false)
                            .text_size(px(size::XS))
                            .child(
                                div().w(px(56.)).flex_none().font_family(t.mono_font.clone()).text_color(t.quiet).child(clock_ms(s.start_ms.get())),
                            )
                            .child(div().w(px(56.)).flex_none().font_family(t.mono_font.clone()).child(span_dur_text(&s, &self.names)))
                            .child(
                                div()
                                    .w(px(52.))
                                    .flex_none()
                                    .text_color(if s.status == SpanStatus::Failed { t.danger } else { t.quiet })
                                    .child(s.exit_code.map(|c| format!("exit {}", c.get())).unwrap_or_default()),
                            )
                            .child(div().w(px(84.)).flex_none().overflow_hidden().text_ellipsis().text_color(t.quiet).child(row_name))
                            .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().font_family(t.mono_font.clone()).child(span_title(&s)))
                            .when(clickable, |r| {
                                r.on_click(cx.listener(move |this, _, _, cx| {
                                    this.open_transcript(&span, cx);
                                }))
                            }),
                    );
                }
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(div().px_4().pt_2().text_size(px(size::XS)).text_color(t.quiet).child(format!(
                        "{n} span{}{}",
                        if n == 1 { "" } else { "s" },
                        if n >= 500 { " (the first 500)" } else { "" }
                    )))
                    .child(list)
                    .into_any_element()
            }
        };
        Some(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(px(560.))
                .flex()
                .flex_col()
                .bg(t.raised)
                .border_l_1()
                .border_color(t.border)
                .shadow(t.float_shadow())
                .occlude()
                .child(
                    div()
                        .h(px(metric::BAR))
                        .flex_none()
                        .px_4()
                        .flex()
                        .items_center()
                        .gap_2()
                        .border_b_1()
                        .border_color(t.hairline)
                        .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().font_weight(STRONG).child(linked.title.clone()))
                        .child(div().flex_1())
                        .child(
                            ui::button(t, "time-linked-close", "Close", Variant::Secondary, true)
                                .on_click(cx.listener(|_, _, _, cx| cx.emit(TimeEvent::CloseLinked))),
                        ),
                )
                .child(body),
        )
    }

    fn hover_card(&self, t: &Theme) -> Option<gpui::AnyElement> {
        let hover = self.hover.as_ref()?;
        let model = self.model.as_ref()?;
        let (at, lines): (gpui::Point<Pixels>, Vec<Div>) = match hover {
            Hover::Bar { row, bar, at } => (*at, timeline::bar_card(t, model, *row, bar, &self.names)),
            Hover::Lane { row, at } => (*at, timeline::lane_card(t, model, *row)),
            Hover::Path { seg, at } => (*at, timeline::path_card(t, model, *seg)),
        };
        let card = ui::floating(t).px_3().py_2().max_w(px(420.)).flex().flex_col().gap_0p5().text_size(px(size::XS)).children(lines);
        Some(
            deferred(anchored().position(point(at.x + px(12.), at.y + px(16.))).snap_to_window_with_margin(px(8.)).child(card))
                .with_priority(2)
                .into_any_element(),
        )
    }
}

impl Render for TimeView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let body: gpui::AnyElement = match self.tab {
            Tab::Timeline => timeline::render(self, t, window, cx),
            Tab::Breakdown => breakdown::render(self, t, cx),
            Tab::Insights => insights::render(self, t, cx),
        };
        let sheet = self.transcript_sheet(t, cx).or_else(|| self.linked_sheet(t, cx));
        let card = self.hover_card(t);
        div()
            .id("time-view")
            .relative()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .child(self.head(t, cx))
            .child(filters::bar(self, t, cx))
            .child(div().flex_1().min_h_0().flex().flex_col().child(body))
            .children(sheet)
            .children(filters::menu(self, t, cx))
            .children(card)
    }
}

fn transcript_item(t: &Theme, item: &TailItem, focused: bool) -> Stateful<Div> {
    let (at, body) = match item {
        TailItem::Message(m) => {
            let who = match m.role {
                TailRole::User => "you",
                TailRole::Assistant => "agent",
                TailRole::System => "system",
            };
            (
                m.at.to_string(),
                div()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .child(div().text_size(px(size::XS)).text_color(t.quiet).child(who))
                    .child(div().whitespace_normal().child(m.text.to_string())),
            )
        }
        TailItem::Action(a) => {
            let act = &a.action;
            let exit = act.exit_code.map(|c| format!("exit {}", c.get()));
            (
                a.at.to_string(),
                div()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .whitespace_normal()
                                    .font_family(t.mono_font.clone())
                                    .text_size(px(size::SM))
                                    .child(act.summary.to_string()),
                            )
                            .when_some(exit, |d, e| {
                                d.child(div().flex_none().text_size(px(size::XS)).text_color(if act.failed { t.danger } else { t.quiet }).child(e))
                            }),
                    )
                    .when_some(act.output_tail.as_ref().filter(|_| focused), |d, tail| {
                        d.child(
                            div()
                                .mt_1()
                                .px_2()
                                .py_1()
                                .rounded(px(radius::SM))
                                .bg(t.selected)
                                .font_family(t.mono_font.clone())
                                .text_size(px(size::SM))
                                .text_color(t.quiet)
                                .whitespace_normal()
                                .child(tail.to_string()),
                        )
                    }),
            )
        }
    };
    div()
        .id(SharedString::from(format!("tr-{at}")))
        .px_2()
        .py_1p5()
        .rounded(px(radius::SM))
        .flex()
        .gap_3()
        .when(focused, |d| d.bg(t.selected).border_l_2().border_color(t.accent))
        .child(
            div()
                .w(px(56.))
                .flex_none()
                .font_family(t.mono_font.clone())
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .child(crate::shell::clock(&at).to_string()),
        )
        .child(div().flex_1().min_w_0().child(body))
}

// ---- words and figures -----------------------------------------------------------------------

/// "840 ms", "3.2s", "42s", "2m10s", "34m", "1h42m".
pub fn fmt_dur(ms: i64) -> String {
    let ms = ms.max(0);
    match ms {
        0..1_000 => format!("{ms} ms"),
        1_000..10_000 => format!("{:.1}s", ms as f64 / 1000.),
        10_000..60_000 => format!("{}s", ms / 1000),
        60_000..600_000 if ms / 1000 % 60 == 0 => format!("{}m", ms / 60_000),
        60_000..600_000 => format!("{}m{:02}s", ms / 60_000, ms / 1000 % 60),
        600_000..3_600_000 => format!("{}m", (ms + 30_000) / 60_000),
        _ => {
            let m = (ms + 30_000) / 60_000;
            format!("{}h{:02}m", m / 60, m % 60)
        }
    }
}

/// "312 B", "48 KB", "1.2 MB", "118 MB".
pub fn fmt_bytes(b: i64) -> String {
    let b = b.max(0) as f64;
    match b {
        b if b < 1024. => format!("{b} B"),
        b if b < 1024. * 1024. => format!("{:.0} KB", b / 1024.),
        b if b < 10. * 1024. * 1024. => format!("{:.1} MB", b / 1024. / 1024.),
        b if b < 1024. * 1024. * 1024. => format!("{:.0} MB", b / 1024. / 1024.),
        b => format!("{:.1} GB", b / 1024. / 1024. / 1024.),
    }
}

/// "10:21:04" for a hub ms stamp.
pub fn clock_ms(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let d = s.rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", d / 3600, d / 60 % 60, d % 60)
}

pub fn cat_label(cat: Category) -> &'static str {
    match cat {
        Category::Model => "model",
        Category::Tools => "tools",
        Category::Machine => "machine",
        Category::Queue => "queue",
        Category::Human => "you",
        Category::Pipeline => "CI · review · train",
        Category::Idle => "idle",
    }
}

/// One word per kind, the breakdown's and the hover card's vocabulary.
pub fn kind_word(kind: SpanKind) -> &'static str {
    use SpanKind::*;
    match kind {
        Run => "run",
        ModelMessage => "model message",
        ModelFirstToken => "first token",
        ModelThinking => "thinking",
        ModelOutput => "output",
        ToolBash => "Bash",
        ToolRead => "Read",
        ToolEdit => "Edit",
        ToolWeb => "web",
        ToolMcp => "MCP",
        ToolOther => "other tools",
        ToolsParallel => "parallel tools",
        Git => "git",
        CheckClaim => "done-when checks",
        WaitRetryApi => "API retries",
        WaitRetryNode => "node retries",
        RunStartup => "startup",
        Compaction => "compaction",
        ClaudeOther => "claude overhead",
        WaitOffline => "machine offline",
        QueueSlot => "slots",
        QueueLease => "leases",
        QueueUsage => "usage limit",
        QueueOffline => "machine offline",
        RunQueued => "behind a run",
        WakeDebounce => "wake debounce",
        ParkUsage => "usage parks",
        SlotsFull => "slots full",
        WaitPermission => "approvals",
        WaitAsk => "asks",
        AskBatching => "batching",
        AskInfo => "info asks",
        ChangeReview => "review",
        ChangeQueue => "train line",
        ChangeRebase => "rebase",
        ChangeCi => "CI",
        CiCheck => "CI check",
        CiQueue => "CI queue",
        ChangeMerge => "merge",
        ChangeBlocked => "blocked",
        IntakeRoute => "routing",
        Idle => "idle",
        Gap => "missing data",
    }
}

/// What a span's figure can't say exactly (spec §2f): the mark beside the number and the sentence behind it.
pub fn inexact(span: &Span, names: &Names, parallel: bool) -> Option<(&'static str, &'static str)> {
    use SpanKind::*;
    let lead = span.thread_id.as_ref().is_some_and(|t| names.leads.contains(t.as_str()));
    match span.kind {
        ModelFirstToken => Some((
            "≈",
            "Time to the first token includes claude's own work before the request, the network, API queueing and prefill; they can't be told apart.",
        )),
        ModelThinking | ModelOutput => Some(("≈", "Split as streamed: summarized thinking can arrive in bursts. The message's total is exact.")),
        _ if parallel => {
            Some(("≤", "Ran alongside other tools from the same message, so this call's own time is an upper bound. The group's time is exact."))
        }
        CiCheck => Some(("±1 s", "GitHub's own start and end, which are whole seconds.")),
        WaitAsk | AskBatching => Some(("", "From when the ask was published to your answer; when you first saw it isn't known.")),
        _ if lead => Some(("split", "One lead turn serves every order it woke for; its time is split equally across them.")),
        _ => None,
    }
}

/// A span's duration as shown: "2m10s", "≤ 48s", "≈ 3.2s".
pub fn span_dur_text(span: &Span, names: &Names) -> String {
    let d = fmt_dur(span.end_ms.map_or(0, |e| e.get()) - span.start_ms.get());
    match inexact(span, names, false) {
        Some((mark, _)) if mark == "≈" || mark == "≤" => format!("{mark} {d}"),
        _ => d,
    }
}

/// The command, the path, the check, or the kind's word.
pub fn span_title(span: &Span) -> String {
    if let Some(check) = span.extra.as_ref().and_then(|e| e.check.as_ref()) {
        return check.to_string();
    }
    if let Some(key) = span.extra.as_ref().and_then(|e| e.key.as_ref()) {
        return format!("ask {key}");
    }
    match span.label.as_ref().filter(|l| !l.is_empty()) {
        Some(l) => l.to_string(),
        None => kind_word(span.kind).to_string(),
    }
}

/// "implementer T31", "lead", "PR #212", "asks".
pub fn lane_name(names: &Names, span: &Span) -> String {
    if let Some(thread) = &span.thread_id {
        if names.leads.contains(thread.as_str()) {
            return "lead".into();
        }
        if let Some((role, task, _)) = names.threads.get(thread.as_str()) {
            return format!("{} {}", role_word(*role), task.clone().unwrap_or_default()).trim().to_string();
        }
        return span.task_id.as_ref().map_or_else(|| thread.to_string(), |t| t.to_string());
    }
    let lane = span.lane.as_str();
    if let Some(change) = lane.strip_prefix("change:") {
        return names.changes.get(change).map_or_else(|| change.to_string(), |n| format!("PR #{n}"));
    }
    lane.split(':').next().unwrap_or(lane).to_string()
}

/// How a category is drawn: its fill, and an outline for the ones drawn as outlines. Static fills only: hatches
/// and stripes are patterns, nothing repaints.
pub fn cat_paint(t: &Theme, cat: Category) -> (Option<Background>, Option<Hsla>) {
    match cat {
        Category::Model => (Some(solid_background(t.accent)), None),
        Category::Tools => (Some(solid_background(t.quiet)), None),
        Category::Machine => (None, Some(t.warning)),
        Category::Queue => (Some(pattern_slash(t.warning, 1.5, 3.)), Some(t.warning)),
        Category::Human => (Some(solid_background(t.text)), None),
        Category::Pipeline => (Some(pattern_slash(t.quiet, 1., 2.5)), Some(t.faint)),
        Category::Idle => (None, None),
    }
}

/// A small swatch of a category, for legends and breakdown rows.
pub fn swatch(t: &Theme, cat: Category) -> Div {
    let (fill, border) = cat_paint(t, cat);
    div().w(px(14.)).h(px(8.)).flex_none().rounded(px(1.)).when_some(fill, |d, f| d.bg(f)).when_some(border, |d, b| d.border_1().border_color(b))
}

/// The categories in the order the breakdown and the legend list them.
pub const SHOWN: [Category; 6] = [Category::Model, Category::Tools, Category::Pipeline, Category::Queue, Category::Human, Category::Machine];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_like_the_cli() {
        assert_eq!(fmt_dur(840), "840 ms");
        assert_eq!(fmt_dur(3_240), "3.2s");
        assert_eq!(fmt_dur(42_900), "42s");
        assert_eq!(fmt_dur(130_000), "2m10s");
        assert_eq!(fmt_dur(242_000), "4m02s");
        assert_eq!(fmt_dur(360_400), "6m", "no \"6m00s\"");
        assert_eq!(fmt_dur(34 * 60_000 + 10_000), "34m");
        assert_eq!(fmt_dur(102 * 60_000), "1h42m");
        assert_eq!(fmt_dur(185 * 60_000 + 20_000), "3h05m");
        assert_eq!(fmt_dur(-5), "0 ms", "a clock step backwards never shows as negative");
    }

    #[test]
    fn sizes_and_clocks() {
        assert_eq!(fmt_bytes(312), "312 B");
        assert_eq!(fmt_bytes(48 * 1024 + 100), "48 KB");
        assert_eq!(fmt_bytes(1_258_291), "1.2 MB");
        assert_eq!(fmt_bytes(118 * 1024 * 1024), "118 MB");
        let ms = crate::live::state::parse_ms("2026-10-18T10:21:04.500Z").unwrap();
        assert_eq!(clock_ms(ms), "10:21:04");
    }
}
