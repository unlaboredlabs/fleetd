//! The board (spec 2.2), the default screen: the docked composer, the needs-you strip, then the open orders,
//! grouped by project (or by status, ⌘⇧G). Quiet work, loud decision: an order that needs you is full weight
//! with the amber dot; working orders recede. Nothing reorders under the pointer or the keyboard selection; the
//! board resorts 2 s after the last interaction.

use std::collections::HashMap;

use fleetd_contracts::ledger::LeadState;
use fleetd_contracts::live::{LaneStatus, OrderCard, OrderPhase};
use gpui::{AnyElement, Context, Div, ExternalPaths, Focusable, SharedString, Stateful, div, prelude::*, px};

use crate::live;
use crate::notify::unix_secs;
use crate::shell::{Shell, ago_short};
use crate::state::{ProjectKey, Sent, SentOrder, State};
use crate::theme::{STRONG, Theme, metric, size, theme};
use crate::ui::{self, Variant};

/// Done orders stay on the board this long after they finish.
pub const DONE_HOLD_SECS: i64 = 600;

/// The status buckets of "Group: Status", in attention order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Bucket {
    NeedsYou,
    Working,
    ReviewAndMerge,
    PlanningAndQueued,
    Done,
}

impl Bucket {
    pub fn of(phase: OrderPhase) -> Self {
        match phase {
            OrderPhase::WaitingOnYou | OrderPhase::Failed => Bucket::NeedsYou,
            OrderPhase::Working => Bucket::Working,
            OrderPhase::Reviewing | OrderPhase::Merging | OrderPhase::Verifying => Bucket::ReviewAndMerge,
            OrderPhase::Queued | OrderPhase::Planning | OrderPhase::Idle => Bucket::PlanningAndQueued,
            OrderPhase::Stopped | OrderPhase::Done => Bucket::Done,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Bucket::NeedsYou => "Needs you",
            Bucket::Working => "Working",
            Bucket::ReviewAndMerge => "Review and merge",
            Bucket::PlanningAndQueued => "Planning and queued",
            Bucket::Done => "Done",
        }
    }
}

/// An order still on the board: open, or finished less than [`DONE_HOLD_SECS`] ago.
pub fn on_board(card: &OrderCard, now_secs: i64) -> bool {
    match card.phase {
        OrderPhase::Done | OrderPhase::Stopped => unix_secs(card.updated_at.as_str()).is_some_and(|at| now_secs - at < DONE_HOLD_SECS),
        _ => true,
    }
}

/// Orders of one project in board order: by phase, then most recently updated.
pub fn sort_cards(cards: &mut [&OrderCard]) {
    cards.sort_by(|a, b| a.phase.cmp(&b.phase).then_with(|| b.updated_at.cmp(&a.updated_at)));
}

/// Projects with something on the board, in board order: those that need you first, then by latest order activity.
pub fn project_order(state: &State, now_secs: i64) -> Vec<ProjectKey> {
    let mut keyed: Vec<(bool, String, ProjectKey)> = state
        .projects
        .iter()
        .filter_map(|row| {
            let key = row.key();
            let cards: Vec<&OrderCard> = state.live.orders(&key).iter().filter(|c| on_board(c, now_secs)).collect();
            let sent =
                state.sent.iter().any(|o| o.to.as_ref() == Some(&key) || matches!(&o.status, Sent::Placed { project: Some(p), .. } if *p == key));
            if cards.is_empty() && !sent {
                return None;
            }
            let needs = cards.iter().any(|c| c.phase == OrderPhase::WaitingOnYou);
            let latest = cards.iter().map(|c| c.updated_at.to_string()).max().unwrap_or_default();
            Some((needs, latest, key))
        })
        .collect();
    keyed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    keyed.into_iter().map(|(_, _, k)| k).collect()
}

/// Keeps a list where the eye left it: ids still present stay in `held` order, new ids go in at their place in
/// `now`, gone ids drop out.
pub fn hold(held: &[String], now: &[String]) -> Vec<String> {
    let mut out: Vec<String> = held.iter().filter(|id| now.contains(id)).cloned().collect();
    for (ix, id) in now.iter().enumerate() {
        if !out.contains(id) {
            // After whatever came before it in `now`.
            let at = now[..ix].iter().filter_map(|prev| out.iter().position(|o| o == prev)).max().map_or(0, |p| p + 1);
            out.insert(at, id.clone());
        }
    }
    out
}

/// "4/7 agents settled" for a project's open orders.
pub fn settled_line(cards: &[&OrderCard]) -> Option<String> {
    let total: i64 = cards.iter().map(|c| c.total.get()).sum();
    let settled: i64 = cards.iter().map(|c| c.settled.get()).sum();
    (total > 0).then(|| format!("{settled}/{total} agents settled"))
}

/// One row of the board, in display order (also the order ↑/↓ moves through).
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Header(ProjectKey),
    Bucket(Bucket),
    /// Orders sent to "Any project" that the hub hasn't placed yet.
    Routing,
    Card(String),
    Sent(String),
}

impl Shell {
    /// The rows of the board as they show now, holding their order while you look.
    pub(crate) fn board_rows(&mut self) -> Vec<Row> {
        let now = self.now_secs();
        let mut rows = Vec::new();
        if self.group_by_status {
            let mut buckets: HashMap<Bucket, Vec<&OrderCard>> = HashMap::new();
            for row in &self.state.projects {
                for card in self.state.live.orders(&row.key()).iter().filter(|c| on_board(c, now)) {
                    buckets.entry(Bucket::of(card.phase)).or_default().push(card);
                }
            }
            let mut keys: Vec<Bucket> = buckets.keys().copied().collect();
            keys.sort();
            for bucket in keys {
                rows.push(Row::Bucket(bucket));
                let mut cards = buckets.remove(&bucket).unwrap_or_default();
                sort_cards(&mut cards);
                rows.extend(cards.iter().map(|c| Row::Card(c.workstream_id.to_string())));
            }
            rows.extend(self.state.sent.iter().map(|o| Row::Sent(o.request_id.clone())));
        } else {
            // Orders the hub is still placing: at the top, where the eye is after Enter.
            let routing: Vec<&SentOrder> = self.state.sent.iter().filter(|o| sent_project(o).is_none()).collect();
            if !routing.is_empty() {
                rows.push(Row::Routing);
                rows.extend(routing.iter().rev().map(|o| Row::Sent(o.request_id.clone())));
            }
            for key in project_order(&self.state, now) {
                rows.push(Row::Header(key.clone()));
                for o in self.state.sent.iter().rev().filter(|o| sent_project(o).as_ref() == Some(&key)) {
                    rows.push(Row::Sent(o.request_id.clone()));
                }
                let mut cards: Vec<&OrderCard> = self.state.live.orders(&key).iter().filter(|c| on_board(c, now)).collect();
                sort_cards(&mut cards);
                rows.extend(cards.iter().map(|c| Row::Card(c.workstream_id.to_string())));
            }
        }
        let ids: Vec<String> = rows.iter().map(row_id).collect();
        if let Some(held) = &self.board_held {
            let order = hold(held, &ids);
            rows.sort_by_key(|r| order.iter().position(|id| *id == row_id(r)).unwrap_or(usize::MAX));
            self.board_held = Some(order);
        }
        rows
    }

    /// The order cards in display order, for ↑/↓ and Enter.
    pub(crate) fn board_cards(&mut self) -> Vec<String> {
        self.board_rows().into_iter().filter_map(|r| if let Row::Card(id) = r { Some(id) } else { None }).collect()
    }

    /// The board as a virtualized list: gpui lays out and paints everything it is given, on screen or not, so
    /// a long board must only build the rows in view. Item 0 is the composer, the needs-you strip and any
    /// errors; then one item per row.
    pub(crate) fn board_screen(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let rows = self.board_rows();
        let ids: Vec<String> = rows.iter().map(row_id).collect();
        let old = self.board_list.item_count();
        if ids != self.board_ids || old != rows.len() + 1 {
            self.board_list.splice(0..old, rows.len() + 1);
            self.board_ids = ids;
        } else if std::mem::take(&mut self.board_remeasure) {
            self.board_list.remeasure_items(0..old);
        }
        self.board_now = rows;
        div()
            .id("board")
            .flex_1()
            .min_w_0()
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| this.hold_board(*hovered, cx)))
            .child(gpui::list(self.board_list.clone(), cx.processor(|this, ix, _, cx| this.board_item(ix, cx))).size_full())
            .into_any_element()
    }

    fn board_item(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        // A list item is laid out on its own: without a width it shrinks to its content.
        let frame = |el: AnyElement| div().w_full().child(div().max_w(px(metric::MEASURE + 260.)).px_6().child(el)).into_any_element();
        if ix == 0 {
            return frame(self.board_top(cx).into_any_element());
        }
        let Some(row) = self.board_now.get(ix - 1).cloned() else { return div().into_any_element() };
        let first = !self.board_now[..ix - 1].iter().any(|r| matches!(r, Row::Header(_) | Row::Bucket(_)));
        let last = ix == self.board_now.len();
        let el = match &row {
            Row::Header(key) => self.project_header(key, first, cx).into_any_element(),
            Row::Bucket(b) => self.bucket_header(*b, first, cx).into_any_element(),
            Row::Routing => {
                let t = theme(cx);
                div().pt_6().pb_1().border_b_1().border_color(t.hairline).font_weight(STRONG).child("Routing…").into_any_element()
            }
            Row::Card(id) => self.order_card(id, cx).into_any_element(),
            Row::Sent(id) => self.sent_card(id, cx).into_any_element(),
        };
        frame(div().when(last, |d| d.pb_8()).child(el).into_any_element())
    }

    fn board_top(&mut self, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let body = if !self.board_now.is_empty() {
            None
        } else if self.state.projects.is_empty() && self.state.conn == crate::state::Conn::Live {
            Some(
                div()
                    .pt_6()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .text_color(t.quiet)
                    .child("No projects yet. Add one on a machine:")
                    .child(div().max_w(px(420.)).child(self.command_line("copy-project-add", "fleetd project add <path>", cx))),
            )
        } else if !self.boards_loaded() {
            Some(ui::loading(t, "Loading orders…"))
        } else {
            Some(div().pt_6().text_color(t.quiet).child("Nothing running. Type what the fleet should do above, then Enter."))
        };
        let errors: Vec<(ProjectKey, String)> = self.state.board_errors.iter().map(|(k, e)| (k.clone(), e.clone())).collect();
        let mut errs = div().pt_2().flex().flex_col().gap_2();
        for (key, e) in errors {
            errs = errs.child(self.error_line(SharedString::from(format!("copy-board-{}", key.1)), format!("{}: {e}", key.1), None, cx));
        }
        div().pt_6().flex().flex_col().child(self.docked.clone()).children(self.needs_you_strip(cx)).child(errs).children(body)
    }

    fn boards_loaded(&self) -> bool {
        self.state.projects.iter().all(|r| !self.state.live.orders(&r.key()).is_empty() || self.state.board_errors.contains_key(&r.key()))
            || self.bench.is_some()
    }

    fn group_switch(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let by_status = self.group_by_status;
        let option = |id: &'static str, label: &'static str, on: bool, cx: &mut Context<Self>| {
            ui::clickable(t, div().id(id)).px_1().when(on, |d| d.text_color(t.text)).when(!on, |d| d.hover(|s| s.underline())).child(label).on_click(
                cx.listener(move |this, _, _, cx| {
                    this.group_by_status = id == "group-status";
                    this.selected_card = None;
                    cx.notify();
                }),
            )
        };
        div()
            .flex()
            .items_center()
            .gap_1()
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .child("Group:")
            .child(option("group-project", "Project", !by_status, cx))
            .child("|")
            .child(option("group-status", "Status", by_status, cx))
    }

    fn project_header(&self, key: &ProjectKey, first: bool, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let row = self.state.project(key);
        let title = row.map_or(key.1.clone(), |r| r.summary.title.clone());
        let now = self.now_secs();
        let cards: Vec<&OrderCard> = self.state.live.orders(key).iter().filter(|c| on_board(c, now)).collect();
        let open = cards.iter().filter(|c| !matches!(c.phase, OrderPhase::Done | OrderPhase::Stopped)).count();
        let lead = match row.and_then(|r| r.lead()).map(|l| l.state) {
            Some(LeadState::Working) => "lead working",
            Some(LeadState::Idle) => "lead idle",
            Some(LeadState::Starting) => "lead starting",
            Some(LeadState::Stalled) => "lead stalled",
            Some(LeadState::Stopped) => "lead stopped",
            None => "no lead",
        };
        let mut facts = vec![lead.to_string(), format!("{open} order{}", if open == 1 { "" } else { "s" })];
        facts.extend(settled_line(&cards));
        let done_today = cards.iter().filter(|c| c.phase == OrderPhase::Done).count();
        let pick = key.clone();
        div()
            .pt_6()
            .pb_1()
            .flex()
            .items_center()
            .gap_3()
            .border_b_1()
            .border_color(t.hairline)
            .child(
                ui::clickable(t, div().id(SharedString::from(format!("board-project-{}-{}", key.0, key.1))))
                    .font_weight(STRONG)
                    .child(title)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected_project = Some(pick.clone());
                        this.sync_composers(cx);
                        cx.notify();
                    })),
            )
            .child(div().text_size(px(size::XS)).text_color(if lead == "lead stalled" { t.warning } else { t.quiet }).child(facts.join(" · ")))
            .when(done_today > 0, |d| d.child(div().text_size(px(size::XS)).text_color(t.quiet).child(format!("done today {done_today}"))))
            .child(div().flex_1())
            .when(first, |d| d.child(self.group_switch(t, cx)))
    }

    fn bucket_header(&self, bucket: Bucket, first: bool, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        div()
            .pt_6()
            .pb_1()
            .flex()
            .items_center()
            .border_b_1()
            .border_color(t.hairline)
            .child(div().font_weight(STRONG).child(bucket.label()))
            .child(div().flex_1())
            .when(first, |d| d.child(self.group_switch(t, cx)))
    }

    /// Title row, up to four lanes, then the PR and "next:" line.
    fn order_card(&self, id: &str, cx: &mut Context<Self>) -> Stateful<Div> {
        let t = &theme(cx).clone();
        let Some(card) = self.state.card(id).cloned() else { return div().id(SharedString::from(format!("card-{id}"))) };
        let needs = card.phase == OrderPhase::WaitingOnYou;
        let selected = self.selected_card.as_deref() == Some(id);
        let active = card.lanes.iter().any(|l| !matches!(l.status, LaneStatus::Done | LaneStatus::Failed | LaneStatus::Cancelled));
        let quiet_phase = matches!(card.phase, OrderPhase::Merging | OrderPhase::Verifying | OrderPhase::Idle | OrderPhase::Queued);
        let collapsed = quiet_phase && !active;
        let done = matches!(card.phase, OrderPhase::Done | OrderPhase::Stopped);
        let age = ago_short(card.created_at.as_str(), self.now_secs());
        let prs: Vec<String> = card.prs.iter().map(pr_line).collect();
        let next = card.next.as_ref().map(|n| format!("next: {n}"));
        let detail_line = (!collapsed && !done && (!prs.is_empty() || next.is_some())).then(|| {
            let mut parts = prs.clone();
            parts.extend(next.clone());
            parts.join("   ")
        });
        let lanes = (!collapsed && !done && active).then(|| self.card_lanes.get(id).cloned()).flatten();
        // A card without lane rows still says what its most relevant agent is doing now; with rows, each row does.
        let now_line = (lanes.is_none() && !done).then(|| now_lane(&self.state.live.lanes(&card.workstream_id))).flatten().map(|lane| {
            div()
                .pl(px(48.))
                .h(px(metric::LINE + 2.))
                .flex()
                .items_center()
                .gap_2()
                .child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::XS)).text_color(t.quiet).child(lane.lane_id.to_string()))
                .child(live::activity::activity_line(t, &lane))
        });
        let open_id = id.to_string();
        let drop_id = id.to_string();
        let hover = t.hover;
        let wid = card.workstream_id.to_string();
        let title_color = if needs {
            t.text
        } else if done {
            t.quiet
        } else {
            t.text
        };
        let chip = live::chips::phase_chip(t, card.phase, card.phase_detail.as_deref());
        live_enter(
            &wid,
            div()
                .id(SharedString::from(format!("card-{id}")))
                .py_1()
                .px_2()
                .mx(px(-8.))
                .rounded(px(crate::theme::radius::SM))
                .cursor_pointer()
                .when(selected, |d| d.bg(t.selected))
                .when(!selected, |d| d.hover(move |s| s.bg(hover)))
                .on_click(cx.listener(move |this, _, _, cx| this.open_order(&open_id, cx)))
                .on_drop(cx.listener(move |this, paths: &ExternalPaths, _, cx| {
                    this.open_order(&drop_id, cx);
                    let paths = paths.paths().to_vec();
                    this.follow.update(cx, |c, cx| c.attach_paths(paths, cx));
                }))
                .flex()
                .flex_col()
                .child(
                    div()
                        .h(px(metric::ROW))
                        .flex()
                        .items_center()
                        .gap_3()
                        .child(
                            div()
                                .w(px(36.))
                                .flex_none()
                                .font_family(t.mono_font.clone())
                                .text_size(px(size::SM))
                                .text_color(t.quiet)
                                .child(wid.clone()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_color(title_color)
                                .when(needs, |d| d.font_weight(STRONG))
                                .child(card.title.to_string()),
                        )
                        .child(chip)
                        .child(div().w(px(36.)).flex_none().flex().justify_end().text_size(px(size::XS)).text_color(t.quiet).child(age)),
                )
                .when_some(lanes, |d, lanes| {
                    // A cached view takes the size its parent gives it, so the box is exactly the rows' height.
                    let h = lanes.read(cx).height();
                    d.child(div().pl(px(48.)).h(px(h)).flex_none().child(lanes.cached(gpui::StyleRefinement::default().size_full())))
                })
                .children(now_line)
                .when_some(detail_line, |d, line| {
                    d.child(
                        div()
                            .pl(px(48.))
                            .h(px(metric::LINE + 2.))
                            .flex()
                            .items_center()
                            .text_size(px(size::XS))
                            .text_color(t.quiet)
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(line),
                    )
                }),
        )
    }

    /// An order between Enter and its card: sending, placed, needing a project, or failed with Retry and Edit.
    fn sent_card(&self, request_id: &str, cx: &mut Context<Self>) -> Stateful<Div> {
        let t = &theme(cx).clone();
        let Some(order) = self.state.sent.iter().find(|o| o.request_id == request_id).cloned() else {
            return div().id(SharedString::from(format!("sent-{request_id}")));
        };
        let (id, chip, line): (String, Div, Option<Div>) = match &order.status {
            Sent::Sending if order.to.is_none() => (String::new(), plain_chip(t, t.faint, "picking a project"), None),
            Sent::Sending => (String::new(), plain_chip(t, t.faint, "sending"), None),
            Sent::Placed { workstream_id, lead_waiting, .. } => (
                workstream_id.clone(),
                plain_chip(t, t.faint, "planning"),
                lead_waiting.clone().map(|why| div().text_color(t.warning).whitespace_normal().child(format!("Waits for its lead: {why}"))),
            ),
            Sent::Unrouted { ask_id } => {
                let ask = self.state.asks.get(ask_id.as_str()).cloned();
                let batch = ask.as_ref().and_then(|a| a.batch_id.clone());
                let block = match (ask, batch) {
                    (Some(ask), Some(batch)) => {
                        let number = ask.number.map_or(0, |n| n.get());
                        self.ask_block(&batch, number, &ask, crate::inbox::Fit::Strip, false, cx)
                    }
                    _ => div().text_color(t.quiet).child("Which project is this for? Loading the question…"),
                };
                (String::new(), plain_chip(t, t.warning, "needs you"), Some(block))
            }
            Sent::Failed(e) => {
                let retry_id = request_id.to_string();
                let edit_id = request_id.to_string();
                (
                    String::new(),
                    plain_chip(t, t.danger, "not sent"),
                    Some(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(div().flex_1().min_w_0().text_color(t.danger).whitespace_normal().child(e.clone()))
                            .child(ui::button(t, SharedString::from(format!("retry-{request_id}")), "Retry", Variant::Secondary, true).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    let out = this.state.retry_order(&retry_id);
                                    this.send(out);
                                    cx.notify();
                                }),
                            ))
                            .child(ui::button(t, SharedString::from(format!("edit-{request_id}")), "Edit", Variant::Ghost, true).on_click(
                                cx.listener(move |this, _, window, cx| {
                                    if let Some(o) = this.state.take_sent(&edit_id) {
                                        this.docked.update(cx, |c, cx| c.set_text(&o.text, cx));
                                        this.go(crate::shell::Screen::Board);
                                        window.focus(&this.docked.focus_handle(cx), cx);
                                    }
                                    cx.notify();
                                }),
                            )),
                    ),
                )
            }
        };
        live_enter(
            &format!("sent-{request_id}"),
            div()
                .id(SharedString::from(format!("sent-{request_id}")))
                .py_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .h(px(metric::ROW))
                        .flex()
                        .items_center()
                        .gap_3()
                        .child(div().w(px(36.)).flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(id))
                        .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(order.title().to_string()))
                        .child(chip)
                        .child(div().w(px(36.)).flex_none()),
                )
                .when_some(line, |d, line| d.child(div().pl(px(48.)).text_size(px(size::XS)).child(line))),
        )
    }
}

/// The lane whose activity speaks for an order: one waiting on you, else the one that changed last, else the
/// latest still running. None when no agent is at work (rule 9: no line when there is nothing to know).
pub fn now_lane(lanes: &[fleetd_contracts::live::AgentLane]) -> Option<fleetd_contracts::live::AgentLane> {
    if let Some(l) = lanes.iter().find(|l| l.status == LaneStatus::Waiting) {
        return Some(l.clone());
    }
    let active = lanes
        .iter()
        .filter(|l| matches!(l.status, LaneStatus::Working | LaneStatus::Starting | LaneStatus::Queued | LaneStatus::Parked | LaneStatus::Stalled));
    active.max_by_key(|l| l.live.as_ref().and_then(|v| v.activity.as_ref()).map(|a| a.since.to_string()).unwrap_or_default()).cloned()
}

/// The project a sent order's card sits under, once known.
fn sent_project(o: &SentOrder) -> Option<ProjectKey> {
    match &o.status {
        Sent::Placed { project: Some(p), .. } => Some(p.clone()),
        Sent::Unrouted { .. } => None,
        _ => o.to.clone(),
    }
}

pub(crate) fn row_id(row: &Row) -> String {
    match row {
        Row::Header(k) => format!("h:{}/{}", k.0, k.1),
        Row::Bucket(b) => format!("b:{b:?}"),
        Row::Routing => "routing".into(),
        Row::Card(id) => format!("c:{id}"),
        Row::Sent(id) => format!("s:{id}"),
    }
}

/// "#212 · reviewing 1/2", "#208 · CI failed", "#211 · merged".
pub fn pr_line(pr: &fleetd_contracts::live::PrRef) -> String {
    use fleetd_contracts::train::ChangeState::*;
    let stage = match pr.state {
        Queued => "queued".to_string(),
        Reviewing => format!("reviewing {}/{}", pr.reviews_done.get(), pr.reviews_needed.get()),
        Ready => "ready to merge".into(),
        Rebasing => "rebasing".into(),
        Ci => "in CI".into(),
        Merging => "merging".into(),
        Merged => "merged".into(),
        NeedsRebase => "needs a rebase".into(),
        CiFailed => "CI failed".into(),
        Refused => "refused".into(),
        Abandoned => "abandoned".into(),
    };
    format!("#{} · {stage}", pr.number.get())
}

/// A phase chip for client-only states (sending, picking a project) and sent-card states.
fn plain_chip(t: &Theme, color: gpui::Hsla, word: &'static str) -> Div {
    div().flex().items_center().gap_1p5().text_size(px(size::XS)).text_color(t.quiet).child(ui::dot(color)).child(word)
}

/// Cards enter once (fade and grow), keyed by their id so a re-render doesn't replay it.
fn live_enter(id: &str, el: Stateful<Div>) -> Stateful<Div> {
    div().id(SharedString::from(format!("enter-{id}"))).child(live::motion::enter(SharedString::from(format!("enter-anim-{id}")), el))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn held_lists_keep_their_order_and_take_new_items_at_their_place() {
        assert_eq!(hold(&s(&["a", "b", "c"]), &s(&["c", "a", "b"])), s(&["a", "b", "c"]), "a resort waits");
        assert_eq!(hold(&s(&["a", "b", "c"]), &s(&["c", "x", "a", "b"])), s(&["a", "b", "c", "x"]), "new after its predecessor");
        assert_eq!(hold(&s(&["a", "b"]), &s(&["x", "b", "a"])), s(&["x", "a", "b"]), "new at the top stays at the top");
        assert_eq!(hold(&s(&["a", "b", "c"]), &s(&["c", "a"])), s(&["a", "c"]), "gone items leave");
    }

    #[test]
    fn buckets_follow_attention_order() {
        assert_eq!(Bucket::of(OrderPhase::WaitingOnYou), Bucket::NeedsYou);
        assert_eq!(Bucket::of(OrderPhase::Failed), Bucket::NeedsYou);
        assert_eq!(Bucket::of(OrderPhase::Merging), Bucket::ReviewAndMerge);
        assert_eq!(Bucket::of(OrderPhase::Idle), Bucket::PlanningAndQueued);
        assert!(Bucket::NeedsYou < Bucket::Working && Bucket::Working < Bucket::Done);
    }

    fn board() -> Vec<OrderCard> {
        let out: fleetd_contracts::mcp::OrdersBoardOutput =
            serde_json::from_str(include_str!("../../../crates/fleetd-contracts/tests/fixtures/live/orders_board.output.json")).unwrap();
        out.orders.to_vec()
    }

    #[test]
    fn the_card_speaks_for_the_agent_waiting_on_you_else_the_latest_change() {
        let mut lanes = crate::live::fixture::order_fixture().order.lanes.to_vec();
        assert_eq!(now_lane(&lanes).map(|l| l.lane_id.to_string()).as_deref(), Some("T31"), "T31 changed last");
        lanes[2].status = LaneStatus::Waiting;
        assert_eq!(now_lane(&lanes).map(|l| l.lane_id.to_string()).as_deref(), Some("T34"));
        for l in &mut lanes {
            l.status = LaneStatus::Done;
        }
        assert_eq!(now_lane(&lanes), None);
    }

    #[test]
    fn cards_sort_by_phase_then_recency_and_done_ones_leave_after_ten_minutes() {
        let mut cards = board();
        cards[1].phase = OrderPhase::WaitingOnYou;
        cards[1].updated_at = "2026-10-18T11:00:00.000Z".into();
        let mut refs: Vec<&OrderCard> = cards.iter().collect();
        sort_cards(&mut refs);
        assert_eq!(refs[0].workstream_id, "W12", "same phase: the newer first");

        let mut done = board().remove(0);
        done.phase = OrderPhase::Done;
        done.updated_at = "2026-10-18T10:00:00.000Z".into();
        let at = unix_secs("2026-10-18T10:00:00.000Z").unwrap();
        assert!(on_board(&done, at + 599));
        assert!(!on_board(&done, at + 600));
        assert_eq!(settled_line(&[&board()[0]]).as_deref(), Some("3/7 agents settled"));
    }
}
