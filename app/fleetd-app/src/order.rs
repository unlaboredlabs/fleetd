//! The order view (spec 2.4): the fleet's lanes, PRs and done-when on the left; the project lead's
//! conversation, focused on this order, with a receipt under each steer, on the right; its asks, the fan-out pill,
//! the line for a steer waiting on the lead's next step, and the steer composer at the bottom. Everything on it comes from the hub: the conversation's folds, merged event lines and
//! roll-up are built here from the lead's tail and the order's events, never by a model.

use std::collections::HashSet;

use fleetd_contracts::events::HubEvent;
use fleetd_contracts::live::{AgentLane, LaneStatus, OrderPhase};
use fleetd_contracts::mcp::{TailItem, TailRole};
use fleetd_contracts::model::ActionKind;
use fleetd_contracts::verification::CheckOutcome;
use gpui::{AnyElement, Context, Div, Focusable, SharedString, Window, div, prelude::*, px, relative};

use crate::board::pr_line;
use crate::notify::unix_secs;
use crate::shell::{Shell, clock, describe};
use crate::steer::receipts::{self, Act, Receipt, Tone};
use crate::steer::{Sending, Steer, SteerTarget};
use crate::theme::{STRONG, Theme, metric, size, theme};
use crate::ui::{self, Variant};

/// Who said a line in the lead conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    You,
    Lead,
}

/// One entry of the focused lead conversation.
#[derive(Clone, Debug, PartialEq)]
pub enum Conv {
    Say {
        at: String,
        who: Who,
        text: String,
        /// A steer sent straight to one of the order's agents: "T88".
        to: Option<String>,
        receipt: Option<Receipt>,
    },
    /// A finished run of tool calls: "Worked for 48s · ran 3 commands". `key` is stable across refetches.
    Fold { key: String, secs: i64, commands: usize, failed: usize, calls: Vec<(String, bool)> },
    /// The lead is mid-turn: its latest calls, unfolded.
    Working { calls: Vec<(String, bool)> },
    /// "All 3 agents finished: #211 #212", once every agent settled.
    Rollup(String),
    /// A run of messages about other orders.
    Others { n: usize, about: String },
    /// Hub events about this order between messages, merged into one line.
    Events { at: String, text: String },
}

/// The order ids (`W12`) a text mentions.
pub fn mentions(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let boundary = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if bytes[i] == b'W' && boundary {
            let end = (i + 1..bytes.len()).find(|&j| !bytes[j].is_ascii_digit()).unwrap_or(bytes.len());
            let word_end = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
            if end > i + 1 && bytes[i + 1] != b'0' && word_end && !out.contains(&&text[i..end]) {
                out.push(&text[i..end]);
            }
            i = end.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

/// A short form of a hub event for the merged line: "T31 started", "#211 merged", else its summary.
pub fn event_phrase(e: &HubEvent) -> String {
    let data = e.data.as_ref();
    let field = |k: &str| data.and_then(|d| d.get(k)).and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string())));
    let kind = e.r#type.as_str();
    match (kind, field("taskId"), field("prNumber")) {
        ("task.started", Some(t), _) => format!("{t} started"),
        ("task.done" | "task.completed", Some(t), _) => format!("{t} finished"),
        ("task.failed", Some(t), _) => format!("{t} failed"),
        ("task.cancelled", Some(t), _) => format!("{t} cancelled"),
        ("pr.merged", _, Some(n)) => format!("#{n} merged"),
        _ => e.summary.to_string(),
    }
}

/// The lead's tail, focused on order `w`: its messages at full weight, runs about other orders folded into one
/// line, finished tool-call runs folded, and this order's hub events merged between messages.
pub fn conversation(tail: &[TailItem], w: &str, events: &[&HubEvent], lead_working: bool, steers: &[Steer], sending: &[Sending]) -> Vec<Conv> {
    // Messages and actions in time order, with the events and the steers not in the lead's log (sent to an agent,
    // or not taken in yet) woven in by timestamp.
    enum Item<'a> {
        Tail(&'a TailItem),
        Event(&'a HubEvent),
        Steer(&'a Steer),
    }
    let at = |i: &Item| match i {
        Item::Tail(TailItem::Message(m)) => m.at.to_string(),
        Item::Tail(TailItem::Action(a)) => a.at.to_string(),
        Item::Event(e) => e.at.to_string(),
        Item::Steer(s) => s.queued_at.to_string(),
    };
    let mut items: Vec<Item> = tail.iter().map(Item::Tail).collect();
    let in_log = |s: &Steer| {
        tail.iter().any(|i| matches!(i, TailItem::Message(m) if m.role == TailRole::User && steer_of(&m.text, std::slice::from_ref(s)).is_some()))
    };
    for e in events.iter().map(|e| Item::Event(e)).chain(steers.iter().filter(|s| !in_log(s)).map(Item::Steer)) {
        let ix = items.iter().position(|i| at(i) > at(&e)).unwrap_or(items.len());
        items.insert(ix, e);
    }
    let mut out: Vec<Conv> = Vec::new();
    let mut calls: Vec<(String, bool, ActionKind, String)> = Vec::new();
    let mut fold_start: Option<String> = None;
    let flush_calls = |out: &mut Vec<Conv>, calls: &mut Vec<(String, bool, ActionKind, String)>, start: &mut Option<String>| {
        if calls.is_empty() {
            return;
        }
        let first = start.take().unwrap_or_else(|| calls[0].3.clone());
        let last = calls.last().map(|c| c.3.clone()).unwrap_or_default();
        let secs = match (unix_secs(&first), unix_secs(&last)) {
            (Some(a), Some(b)) => (b - a).max(0),
            _ => 0,
        };
        out.push(Conv::Fold {
            key: first,
            secs,
            commands: calls.iter().filter(|c| c.2 == ActionKind::Command).count(),
            failed: calls.iter().filter(|c| c.1).count(),
            calls: calls.drain(..).map(|c| (c.0, c.1)).collect(),
        });
    };
    for item in &items {
        match item {
            Item::Tail(TailItem::Action(a)) => {
                calls.push((a.action.summary.to_string(), a.action.failed, a.action.kind, a.at.to_string()));
            }
            Item::Steer(st) => {
                flush_calls(&mut out, &mut calls, &mut fold_start);
                out.push(steer_say(st, clock(st.queued_at.as_str())));
            }
            Item::Tail(TailItem::Message(m)) => {
                if m.role == TailRole::System {
                    continue;
                }
                // A steer as the lead received it: your words and its receipt, whatever orders it names.
                if m.role == TailRole::User
                    && let Some(st) = steer_of(&m.text, steers)
                {
                    flush_calls(&mut out, &mut calls, &mut fold_start);
                    fold_start = Some(m.at.to_string());
                    out.push(steer_say(st, clock(m.at.as_str())));
                    continue;
                }
                let ids = mentions(&m.text);
                let about_other = !ids.is_empty() && !ids.contains(&w);
                if about_other {
                    // Its calls belong to that other order too.
                    calls.clear();
                    fold_start = None;
                    match out.last_mut() {
                        Some(Conv::Others { n, .. }) => *n += 1,
                        _ => out.push(Conv::Others { n: 1, about: ids[0].to_string() }),
                    }
                    continue;
                }
                if m.role == TailRole::User {
                    flush_calls(&mut out, &mut calls, &mut fold_start);
                    fold_start = Some(m.at.to_string());
                    out.push(Conv::Say { at: clock(m.at.as_str()).to_string(), who: Who::You, text: m.text.to_string(), to: None, receipt: None });
                } else {
                    flush_calls(&mut out, &mut calls, &mut fold_start);
                    out.push(Conv::Say { at: clock(m.at.as_str()).to_string(), who: Who::Lead, text: m.text.to_string(), to: None, receipt: None });
                }
            }
            Item::Event(e) => {
                let phrase = event_phrase(e);
                match out.last_mut() {
                    Some(Conv::Events { text, .. }) => {
                        text.push_str(", ");
                        text.push_str(&phrase);
                    }
                    _ => out.push(Conv::Events { at: clock(e.at.as_str()).to_string(), text: phrase }),
                }
            }
        }
    }
    if lead_working && !calls.is_empty() {
        let n = calls.len();
        out.push(Conv::Working { calls: calls.drain(n.saturating_sub(3)..).map(|c| (c.0, c.1)).collect() });
    } else {
        flush_calls(&mut out, &mut calls, &mut fold_start);
    }
    for s in sending {
        out.push(Conv::Say {
            at: clock(&s.at).to_string(),
            who: Who::You,
            text: s.text.clone(),
            to: crate::steer::task_of(&s.target).map(str::to_string),
            receipt: Some(receipts::sending(s)),
        });
    }
    out
}

/// The steer a user message in the lead's log is: the hub's steer text begins with its id ("S12 · the human…").
pub fn steer_of<'a>(text: &str, steers: &'a [Steer]) -> Option<&'a Steer> {
    let head = text.split_whitespace().next()?;
    steers.iter().find(|s| s.id == head && matches!(s.target, SteerTarget::Lead { .. }))
}

fn steer_say(s: &Steer, at: &str) -> Conv {
    Conv::Say {
        at: at.to_string(),
        who: Who::You,
        text: s.text.to_string(),
        to: crate::steer::task_of(&s.target).map(str::to_string),
        receipt: Some(receipts::receipt(s)),
    }
}

/// "Worked for 48s · ran 3 commands (1 failed)".
pub fn fold_label(secs: i64, commands: usize, failed: usize, calls: usize) -> String {
    let time = if secs < 60 { format!("{secs}s") } else { format!("{}m {:02}s", secs / 60, secs % 60) };
    let did = match commands {
        0 => format!("{calls} tool call{}", if calls == 1 { "" } else { "s" }),
        1 => "ran 1 command".into(),
        n => format!("ran {n} commands"),
    };
    let failed = if failed > 0 { format!(" ({failed} failed)") } else { String::new() };
    format!("Worked for {time} · {did}{failed}")
}

fn settled(s: LaneStatus) -> bool {
    matches!(s, LaneStatus::Done | LaneStatus::Failed | LaneStatus::Cancelled)
}

/// The fan-out pill: the most urgent state first ("1 needs you · 3 working · 3 done", "all 3 done").
pub fn fan_out(lanes: &[AgentLane], asks: usize) -> Option<String> {
    let count = |f: &dyn Fn(LaneStatus) -> bool| lanes.iter().filter(|l| f(l.status)).count();
    let waiting = count(&|s| s == LaneStatus::Waiting) + asks;
    let working = count(&|s| matches!(s, LaneStatus::Working | LaneStatus::Starting));
    let queued = count(&|s| s == LaneStatus::Queued);
    let failed = count(&|s| s == LaneStatus::Failed);
    let done = count(&|s| s == LaneStatus::Done);
    if lanes.is_empty() && waiting == 0 {
        return None;
    }
    if waiting == 0 && working == 0 && queued == 0 && failed == 0 {
        return Some(format!("all {done} done"));
    }
    let parts: Vec<String> = [(waiting, "needs you"), (failed, "failed"), (working, "working"), (queued, "queued"), (done, "done")]
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, w)| format!("{n} {w}"))
        .collect();
    Some(parts.join(" · "))
}

/// The line that closes a run once every agent settled: "All 3 agents finished: #211 #212" or "2 of 3 finished;
/// T32 failed". None while any still runs.
pub fn rollup(lanes: &[AgentLane]) -> Option<String> {
    let agents: Vec<&AgentLane> = lanes.iter().filter(|l| l.role != fleetd_contracts::live::AgentRole::Lead).collect();
    if agents.is_empty() || !agents.iter().all(|l| settled(l.status)) {
        return None;
    }
    let failed: Vec<String> = agents.iter().filter(|l| l.status != LaneStatus::Done).map(|l| l.lane_id.to_string()).collect();
    let mut prs: Vec<String> = agents.iter().filter_map(|l| l.pr.as_ref()).map(|p| format!("#{}", p.number.get())).collect();
    prs.dedup();
    let n = agents.len();
    Some(if failed.is_empty() {
        let prs = if prs.is_empty() { String::new() } else { format!(": {}", prs.join(" ")) };
        format!("All {n} agent{} finished{prs}", if n == 1 { "" } else { "s" })
    } else {
        format!("{} of {n} finished; {} {}", n - failed.len(), failed.join(", "), if failed.len() == 1 { "failed" } else { "did not finish" })
    })
}

impl Shell {
    pub(crate) fn order_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let Some(order) = self.state.order.as_ref() else { return div().flex_1().into_any_element() };
        let w = order.workstream_id.clone();
        let card = order.card.clone();
        let key = order.key.clone();
        let stopping = order.stopping;
        let project = key.as_ref().map_or(String::new(), |k| self.state.project(k).map_or(k.1.clone(), |r| r.summary.title.clone()));
        let title =
            card.as_ref().map(|c| c.title.to_string()).or_else(|| self.state.workstream(&w).map(|ws| ws.title.to_string())).unwrap_or_default();
        let lanes = self.state.live.lanes(&fleetd_contracts::ledger::WorkstreamId::unchecked(&w));
        let asks = self.state.order_asks(&w).len();
        let phase = card.as_ref().map(|c| c.phase);
        let finished = matches!(phase, Some(OrderPhase::Stopped | OrderPhase::Done | OrderPhase::Failed));
        let status = {
            let mut parts = Vec::new();
            if let Some(f) = fan_out(&lanes, asks) {
                parts.push(f);
            }
            if let Some(c) = &card
                && c.total.get() > 0
            {
                parts.push(format!("{}/{} settled", c.settled.get(), c.total.get()));
            }
            parts.join(" · ")
        };
        let back = ui::button(t, "order-back", "‹ Board", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| {
            this.go(crate::shell::Screen::Board);
            cx.notify();
        }));
        let stop = if phase == Some(OrderPhase::Stopped) {
            ui::button(t, "order-reorder", "Reorder", Variant::Secondary, true)
                .on_click(cx.listener(|this, _, window, cx| this.reorder(window, cx)))
                .into_any_element()
        } else if !finished {
            ui::button(t, "order-stop", if stopping { format!("Stopping {w}…") } else { format!("Stop {w}") }, Variant::Secondary, !stopping)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.stop_confirm = !this.stop_confirm;
                    cx.notify();
                }))
                .into_any_element()
        } else {
            div().into_any_element()
        };
        let needs = phase == Some(OrderPhase::WaitingOnYou);
        let header = div()
            .h(px(metric::BAR))
            .flex_none()
            .px_4()
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(t.hairline)
            .child(back)
            .child(div().text_color(t.quiet).child(format!("{project} ›")))
            .child(div().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(w.clone()))
            .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().font_weight(STRONG).child(title))
            .child(div().flex_1())
            .when(needs, |d| d.child(ui::dot(t.warning)))
            .child(ui::button(t, "order-time", "Time", Variant::Ghost, true).on_click(cx.listener({
                let w = w.clone();
                move |this, _, _, cx| this.open_time(Some(w.clone()), cx)
            })))
            .child(div().text_size(px(size::XS)).text_color(t.quiet).child(status))
            .child(ui::button(t, "order-status", "Status", Variant::Ghost, true).on_click(cx.listener({
                let w = w.clone();
                move |this, _, _, cx| this.open_status(crate::status::order_scope(&w), cx)
            })))
            .child(ui::kbd(t, ui::shortcut("⇧.")))
            .child(stop);
        let wide = window.viewport_size().width >= px(1100.);
        let left = self.order_left(&w, &lanes, cx);
        let right = self.order_right(window, cx);
        let panes = if wide {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(div().w(relative(0.56)).flex_none().min_h_0().flex().flex_col().border_r_1().border_color(t.hairline).child(left))
                .child(div().flex_1().min_w_0().min_h_0().flex().flex_col().child(right))
                .into_any_element()
        } else {
            let tab = self.order_tab;
            let tab_button = |id: &'static str, label: &'static str, on: bool, cx: &mut Context<Self>| {
                ui::button(t, id, label, if on { Variant::Secondary } else { Variant::Ghost }, true).on_click(cx.listener(move |this, _, _, cx| {
                    this.order_tab = id == "tab-lead";
                    cx.notify();
                }))
            };
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .px_4()
                        .py_1()
                        .flex()
                        .gap_1()
                        .child(tab_button("tab-fleet", "Fleet", !tab, cx))
                        .child(tab_button("tab-lead", "Lead", tab, cx)),
                )
                .child(div().flex_1().min_h_0().flex().flex_col().child(if tab { right } else { left }))
                .into_any_element()
        };
        let confirm = self.stop_confirm.then(|| {
            let running = lanes.iter().filter(|l| matches!(l.status, LaneStatus::Working | LaneStatus::Starting | LaneStatus::Queued)).count();
            ui::floating(t)
                .absolute()
                .top(px(metric::BAR + 4.))
                .right(px(16.))
                .w(px(340.))
                .p_4()
                .flex()
                .flex_col()
                .gap_3()
                .child(div().font_weight(STRONG).child(format!("Stop {w}?")))
                .child(div().text_color(t.quiet).whitespace_normal().child(format!(
                    "Its {running} running agent{} {} cancelled; merged PRs stay. A stopped order isn't reopened; Reorder starts it again.",
                    if running == 1 { "" } else { "s" },
                    if running == 1 { "is" } else { "are" }
                )))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(ui::button(t, "stop-cancel", "Keep it", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| {
                            this.stop_confirm = false;
                            cx.notify();
                        })))
                        .child(ui::button(t, "stop-confirm", format!("Stop {w}"), Variant::Danger, true).on_click(cx.listener(|this, _, _, cx| {
                            this.stop_confirm = false;
                            let out = this.state.stop_order();
                            this.send(out);
                            cx.notify();
                        }))),
                )
        });
        div()
            .relative()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(panes)
            .child(self.order_bottom(&w, &lanes, cx))
            .children(confirm)
            .into_any_element()
    }

    fn order_left(&self, w: &str, lanes: &[AgentLane], cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let order = self.state.order.as_ref();
        let loaded = order.is_some_and(|o| o.loaded);
        let error = order.and_then(|o| o.error.clone());
        let mut col = div().id("order-left").flex_1().min_h_0().overflow_y_scroll().px_4().pb_4().flex().flex_col();
        if let Some(e) = error {
            let retry = ui::button(t, "order-retry", "Retry", Variant::Secondary, true).on_click(cx.listener(|this, _, _, cx| {
                if let Some(w) = this.state.order.as_ref().map(|o| o.workstream_id.clone()) {
                    let out = this.state.open_order(&w);
                    this.send(out);
                }
                cx.notify();
            }));
            col = col.child(
                div().flex().items_center().gap_2().child(div().flex_1().child(self.error_line("copy-order-error", e, None, cx))).child(retry),
            );
        } else if lanes.iter().all(|l| l.role == fleetd_contracts::live::AgentRole::Lead) {
            col = col.child(div().py_2().text_color(t.quiet).child(if loaded || self.bench.is_some() {
                "No agents yet. The lead starts them after it freezes the brief.".to_string()
            } else {
                format!("Loading {w}…")
            }));
        } else if let Some(entity) = &self.order_lanes {
            // A cached view takes the size its parent gives it, so the box is exactly the lanes' height.
            let h = entity.read(cx).height();
            col = col.child(div().w_full().h(px(h)).flex_none().child(entity.clone().cached(gpui::StyleRefinement::default().size_full())));
        }
        // Pull requests.
        let prs = self.state.order.as_ref().and_then(|o| o.card.as_ref()).map(|c| c.prs.to_vec()).unwrap_or_default();
        if !prs.is_empty() {
            col = col.child(section(t, "PULL REQUESTS", String::new()));
            for pr in prs {
                let url = pr.url.to_string();
                let pos = pr.position.map(|p| format!("   position {}", p.get() + 1)).unwrap_or_default();
                col = col.child(
                    ui::clickable(t, div().id(SharedString::from(format!("pr-{}", pr.number.get()))))
                        .h(px(metric::ROW))
                        .flex()
                        .items_center()
                        .gap_3()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .hover(|s| s.underline())
                        .child(pr_line(&pr))
                        .child(pos)
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                );
            }
        }
        // Done when: the brief's checks with the latest claim's results.
        if let Some(brief) = self.state.workstream(w).and_then(|ws| ws.brief.as_ref()) {
            let claim = self.state.order.as_ref().and_then(|o| o.claims.first());
            col = col.child(section(t, "DONE WHEN", String::new()));
            for (i, check) in brief.done_when.iter().enumerate() {
                let result = claim.and_then(|c| c.results.iter().find(|r| r.check_index.get() == i as i64));
                let mark = match result.map(|r| r.result) {
                    Some(CheckOutcome::Pass) => ui::dot(t.success),
                    Some(CheckOutcome::Fail) => ui::dot(t.danger),
                    Some(CheckOutcome::Error) => ui::dot(t.warning),
                    None => ui::ring(t.faint),
                };
                col = col.child(
                    div()
                        .py_0p5()
                        .flex()
                        .items_start()
                        .gap_2()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .child(mark)
                        .child(div().flex_1().whitespace_normal().child(describe(check)))
                        .when_some(result.filter(|r| r.result != CheckOutcome::Pass), |d, r| {
                            d.child(div().text_color(t.quiet).child(r.evidence.to_string()))
                        }),
                );
            }
        } else if self.state.workstream(w).is_some() {
            col = col
                .child(section(t, "DONE WHEN", String::new()))
                .child(div().text_size(px(size::XS)).text_color(t.quiet).child("Draft: the lead hasn't frozen the brief yet."));
        }
        col.into_any_element()
    }

    fn order_right(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        if self.bench.as_ref().is_some_and(|(_, p)| p.scroll_started.is_some()) || self.bench_log {
            return self.bench_log_pane(t, window, cx).into_any_element();
        }
        // A cached view: typing in the follow-up or a lane's 1 Hz tick re-renders the shell, not this.
        div().flex_1().min_h_0().flex().flex_col().child(self.conv.clone().cached(gpui::StyleRefinement::default().size_full())).into_any_element()
    }

    /// Hands the lead conversation what the state now says; it re-renders only when that changed.
    pub(crate) fn sync_conversation(&mut self, cx: &mut Context<Self>) {
        let Some(w) = self.state.order.as_ref().map(|o| o.workstream_id.clone()) else { return };
        let w = w.as_str();
        let order = self.state.order.as_ref();
        let lead = self.state.live.lead(&fleetd_contracts::ledger::WorkstreamId::unchecked(w));
        let key = order.and_then(|o| o.key.clone());
        let project = key.as_ref().map_or(String::new(), |k| k.1.clone());
        let lead_state = key.as_ref().and_then(|k| self.state.project(k)).and_then(|r| r.lead()).map(|l| crate::shell::wire_label(&l.state));
        let model = lead.as_ref().and_then(|l| l.model.as_ref()).map(|m| short_model(m));
        let head: Vec<String> = [Some(project), model, lead_state].into_iter().flatten().filter(|s| !s.is_empty()).collect();
        let detail = self.state.detail.as_ref();
        let tail = detail.map(|d| d.tail.clone()).unwrap_or_default();
        let tail_error = detail.and_then(|d| d.tail_error.clone());
        let working = lead.as_ref().is_some_and(|l| matches!(l.status, LaneStatus::Working | LaneStatus::Starting))
            || key
                .as_ref()
                .and_then(|k| self.state.project(k))
                .and_then(|r| r.lead())
                .is_some_and(|l| l.state == fleetd_contracts::ledger::LeadState::Working);
        let events: Vec<&HubEvent> = self.state.order_events(w).collect();
        let sending: Vec<Sending> = self.state.steer_sends.iter().filter(|s| s.workstream_id == w).cloned().collect();
        let mut entries = conversation(&tail, w, &events, working, &self.state.steers, &sending);
        // The lead's newest message as it streams; the tail refetch replaces it once complete.
        if let Some((_, text)) = lead.as_ref().and_then(|l| self.state.live.text(&l.lane_id)).filter(|(_, text)| !text.trim().is_empty())
            && !tail.iter().any(|i| matches!(i, TailItem::Message(m) if m.text.as_str() == text))
        {
            entries.push(Conv::Say { at: String::new(), who: Who::Lead, text: text.to_string(), to: None, receipt: None });
        }
        let notice = match tail_error {
            Some(e) => Some((e, true)),
            None if entries.is_empty() => Some((
                if detail.is_some_and(|d| d.version > 0) || self.bench.is_some() {
                    format!("The lead hasn't said anything about {w} yet.")
                } else {
                    "Loading the lead's log…".to_string()
                },
                false,
            )),
            None => None,
        };
        let lanes = self.state.live.lanes(&fleetd_contracts::ledger::WorkstreamId::unchecked(w));
        if let Some(r) = rollup(&lanes) {
            entries.push(Conv::Rollup(r));
        }
        let workspace = key.as_ref().and_then(|k| self.state.project(k)).map(|r| r.summary.workspace_root.clone());
        let on_open = self.link_opener(workspace, cx);
        let told = key.as_ref().and_then(|k| {
            let lead = self.state.project(k)?.lead()?;
            Some(fleetd_contracts::ids::ThreadRef {
                machine_id: fleetd_contracts::ids::MachineId::unchecked(k.0.as_str()),
                thread_id: lead.thread_id.clone(),
            })
        });
        let shell = cx.entity().downgrade();
        let on_told: OnTold = std::rc::Rc::new(move |thread, cx| {
            shell.update(cx, |this, cx| this.open_told(thread, "the lead".into(), cx)).ok();
        });
        let shell = cx.entity().downgrade();
        let on_steer: OnSteer = std::rc::Rc::new(move |act, cx| {
            shell.update(cx, |this, cx| this.steer_act(act, cx)).ok();
        });
        let shell = cx.entity().downgrade();
        let on_lead: OnLead = std::rc::Rc::new(move |cx| {
            shell
                .update(cx, |this, cx| {
                    if let Some(agent) = this.lead_agent() {
                        this.open_steer_sheet(agent, cx);
                    }
                })
                .ok();
        });
        let snap = ConvSnapshot { head: head.join(" · "), told, lead: lead.filter(|l| l.live.is_some()), notice, entries };
        self.conv.update(cx, |c, cx| c.set(snap, on_open, on_told, on_steer, on_lead, cx));
    }

    fn order_bottom(&self, w: &str, lanes: &[AgentLane], cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let asks = self.order_asks(w, cx);
        let pill = fan_out(lanes, self.state.order_asks(w).len());
        let needs = !self.state.order_asks(w).is_empty() || lanes.iter().any(|l| l.status == LaneStatus::Waiting);
        // A queued steer waits for the lead's running step to end; say what that is and for how long. Its age moves
        // only when the shell renders anyway (the lanes' 1 Hz tick while the lead works).
        let lead = self.state.live.lead(&fleetd_contracts::ledger::WorkstreamId::unchecked(w));
        let to_lead = self.state.steers.iter().filter(|s| matches!(s.target, SteerTarget::Lead { .. }));
        let waiting = lead.and_then(|l| receipts::waiting_line(to_lead, &l, "the lead's", self.state.live.hub_now_ms(crate::shell::now_ms())));
        div()
            .flex_none()
            .px_4()
            .pt_1()
            .pb_3()
            .flex()
            .flex_col()
            .gap_1()
            .border_t_1()
            .border_color(t.hairline)
            .children(asks)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .min_h(px(metric::LINE + 4.))
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .when_some(pill, |d, p| {
                        d.child(
                            ui::clickable(t, div().id("fan-out"))
                                .flex()
                                .items_center()
                                .gap_1p5()
                                .when(needs, |d| d.child(ui::dot(t.warning)))
                                .when(needs, |d| d.text_color(t.text).font_weight(STRONG))
                                .child(p)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.order_tab = false;
                                    cx.notify();
                                })),
                        )
                    })
                    .child(div().flex_1())
                    .when_some(waiting, |d, line| d.child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(line))),
            )
            .child(self.follow.clone())
    }

    /// Reorder: a stopped order's text goes back into the new-order composer.
    fn reorder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(w) = self.state.order.as_ref().map(|o| o.workstream_id.clone()) else { return };
        let text = self
            .state
            .workstream(&w)
            .map(|ws| ws.source.text.to_string())
            .or_else(|| self.state.card(&w).map(|c| c.title.to_string()))
            .unwrap_or_default();
        let key = self.state.project_of(&w);
        self.go(crate::shell::Screen::Board);
        self.docked.update(cx, |c, cx| {
            c.set_text(&text, cx);
            c.choose(key, cx);
        });
        window.focus(&self.docked.focus_handle(cx), cx);
        cx.notify();
    }
}

/// What the lead conversation shows: built by the shell from the state on each change.
#[derive(Clone, Default, PartialEq)]
pub struct ConvSnapshot {
    pub head: String,
    /// The lead's session, for "Show full prompt" in the header.
    pub told: Option<fleetd_contracts::ids::ThreadRef>,
    pub lead: Option<AgentLane>,
    /// The empty or loading line, or the tail's error (true).
    pub notice: Option<(String, bool)>,
    pub entries: Vec<Conv>,
}

/// The order view's lead conversation, its own view so that typing in the follow-up composer and the lanes'
/// 1 Hz tick don't lay it out again. A virtualized list, newest at the bottom.
pub struct LeadConv {
    snap: ConvSnapshot,
    list: gpui::ListState,
    on_open: crate::links::OnOpen,
    on_told: OnTold,
    on_steer: OnSteer,
    /// The lead's activity line opens its steer box, as an agent's lane does.
    on_lead: OnLead,
    open_folds: OpenFolds,
}

pub type OnLead = std::rc::Rc<dyn Fn(&mut gpui::App)>;

/// A receipt's withdraw or redirect, carried out by the shell.
pub type OnSteer = std::rc::Rc<dyn Fn(Act, &mut gpui::App)>;

/// One steer's receipt: its stage in words, coloured by how it went, and what you can do about it.
pub fn receipt_line(t: &Theme, id: impl Into<gpui::ElementId>, r: &Receipt, on_steer: &OnSteer) -> Div {
    let color = match r.tone {
        Tone::Quiet => t.quiet,
        Tone::Good => t.success,
        Tone::Warn => t.warning,
        Tone::Bad => t.danger,
    };
    let act = r.act.clone().map(|act| {
        let label = match &act {
            Act::Withdraw(_) => "Withdraw",
            Act::Redirect(_) => "Interrupt and redirect",
        };
        let on_steer = on_steer.clone();
        ui::clickable(t, div().id(id.into())).text_color(t.text).underline().child(label).on_click(move |_, _, cx| on_steer(act.clone(), cx))
    });
    div()
        .w_full()
        .pt_0p5()
        .flex()
        .items_baseline()
        .gap_x_2()
        .text_size(px(size::XS))
        .child(div().min_w_0().text_color(color).whitespace_normal().child(r.line.clone()))
        .children(act.map(|a| a.flex_none()))
}

pub type OnTold = std::rc::Rc<dyn Fn(fleetd_contracts::ids::ThreadRef, &mut gpui::App)>;

impl LeadConv {
    pub fn new() -> Self {
        Self {
            snap: ConvSnapshot::default(),
            list: gpui::ListState::new(0, gpui::ListAlignment::Bottom, px(400.)),
            on_open: std::rc::Rc::new(|_, _, _| {}),
            on_told: std::rc::Rc::new(|_, _| {}),
            on_steer: std::rc::Rc::new(|_, _| {}),
            on_lead: std::rc::Rc::new(|_| {}),
            open_folds: OpenFolds::new(),
        }
    }

    pub fn set(
        &mut self,
        snap: ConvSnapshot,
        on_open: crate::links::OnOpen,
        on_told: OnTold,
        on_steer: OnSteer,
        on_lead: OnLead,
        cx: &mut Context<Self>,
    ) {
        self.on_open = on_open;
        self.on_told = on_told;
        self.on_steer = on_steer;
        self.on_lead = on_lead;
        if snap == self.snap {
            return;
        }
        if snap.entries != self.snap.entries {
            let old = self.list.item_count();
            self.list.splice(0..old, snap.entries.len());
        }
        self.snap = snap;
        cx.notify();
    }

    fn item(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let Some(entry) = self.snap.entries.get(ix).cloned() else { return div().into_any_element() };
        let on_open = self.on_open.clone();
        let el: AnyElement = match entry {
            Conv::Say { at, who, text, to, receipt } => div()
                .flex()
                .gap_3()
                .child(div().w(px(52.)).flex_none().text_size(px(size::XS)).text_color(t.quiet).pt(px(1.)).child(at))
                .child(
                    div()
                        .w(px(32.))
                        .flex_none()
                        .text_size(px(size::XS))
                        .text_color(if who == Who::You { t.accent } else { t.quiet })
                        .pt(px(1.))
                        .child(match who {
                            Who::You => "You",
                            Who::Lead => "Lead",
                        }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .when_some(to, |d, to| d.child(div().text_size(px(size::XS)).text_color(t.quiet).child(format!("to {to}, directly"))))
                        .child(div().whitespace_normal().child(crate::links::text(t, format!("conv-{ix}"), text, true, on_open.clone())))
                        .when_some(receipt, |d, r| d.child(receipt_line(t, ("conv-receipt", ix), &r, &self.on_steer))),
                )
                .into_any_element(),
            Conv::Fold { key, secs, commands, failed, calls } => {
                let open = self.open_folds.contains(&key);
                let label = fold_label(secs, commands, failed, calls.len());
                let toggle = key.clone();
                let mut fold = div().pl(px(96.)).flex().flex_col().child(
                    ui::clickable(t, div().id(SharedString::from(format!("fold-{key}"))))
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .hover(|s| s.underline())
                        .child(format!("{} {label}", if open { "▾" } else { "▸" }))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.open_folds.remove(&toggle) {
                                this.open_folds.insert(toggle.clone());
                            }
                            this.list.remeasure_items(ix..ix + 1);
                            cx.notify();
                        })),
                );
                if open {
                    for (summary, bad) in calls {
                        fold = fold.child(call_row(t, &summary, bad));
                    }
                }
                fold.into_any_element()
            }
            Conv::Working { calls } => {
                let mut col = div().pl(px(96.)).flex().flex_col();
                for (summary, bad) in calls {
                    col = col.child(call_row(t, &summary, bad));
                }
                col.into_any_element()
            }
            Conv::Others { n, about } => div()
                .pl(px(96.))
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .child(format!("─ {n} message{} about {about} ─", if n == 1 { "" } else { "s" }))
                .into_any_element(),
            Conv::Rollup(r) => div().pl(px(96.)).text_size(px(size::XS)).text_color(t.quiet).child(r).into_any_element(),
            Conv::Events { at, text } => div()
                .flex()
                .gap_3()
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .child(div().w(px(52.)).flex_none().child(at))
                .child(div().w(px(32.)).flex_none())
                .child(div().flex_1().min_w_0().whitespace_normal().child(text))
                .into_any_element(),
        };
        div().w_full().pt_2().child(el).into_any_element()
    }
}

impl Render for LeadConv {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let told = self.snap.told.clone().map(|thread| {
            let on_told = self.on_told.clone();
            ui::clickable(t, div().id("lead-told"))
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .hover(|s| s.underline())
                .child("Show full prompt")
                .on_click(move |_, _, cx| on_told(thread.clone(), cx))
        });
        let head = section(t, "LEAD", self.snap.head.clone()).child(div().flex_1()).children(told);
        let mut col = div().px_4().flex().flex_col().gap_2().child(head);
        if let Some(lead) = &self.snap.lead {
            let on_lead = self.on_lead.clone();
            col = col.child(
                div().pl(px(96.)).child(
                    ui::clickable(t, div().id("lead-activity"))
                        .hover(|s| s.underline())
                        .child(crate::live::activity::activity_line(t, lead))
                        .on_click(move |_, _, cx| on_lead(cx)),
                ),
            );
        }
        if let Some((text, error)) = &self.snap.notice {
            col = col.child(div().whitespace_normal().text_color(if *error { t.danger } else { t.quiet }).child(text.clone()));
        }
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(col)
            .child(gpui::list(self.list.clone(), cx.processor(|this, ix, _, cx| this.item(ix, cx))).flex_1().px_4().pb_4())
    }
}

fn section(t: &Theme, label: &'static str, detail: String) -> Div {
    div()
        .pt_4()
        .pb_1()
        .flex()
        .items_center()
        .gap_3()
        .text_size(px(size::XS))
        .child(div().font_weight(STRONG).text_color(t.quiet).child(label))
        .child(div().text_color(t.quiet).child(detail))
}

fn call_row(t: &Theme, summary: &str, failed: bool) -> Div {
    div()
        .h(px(metric::LINE))
        .flex_none()
        .flex()
        .items_center()
        .gap_2()
        .font_family(t.mono_font.clone())
        .text_size(px(size::XS))
        .text_color(if failed { t.danger } else { t.quiet })
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .child(summary.to_string())
}

/// "claude-haiku-5-5" → "haiku".
pub fn short_model(model: &str) -> String {
    ["haiku", "sonnet", "opus", "fable"].iter().find(|m| model.contains(*m)).map_or_else(|| model.to_string(), |m| m.to_string())
}

/// Folds the user opened, by key; kept while the app runs.
pub type OpenFolds = HashSet<String>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tail(items: serde_json::Value) -> Vec<TailItem> {
        serde_json::from_value(items).unwrap()
    }

    fn msg(at: &str, role: &str, text: &str) -> serde_json::Value {
        json!({ "kind": "message", "at": format!("2026-10-18T10:{at}.000Z"), "role": role, "text": text })
    }

    fn act(at: &str, kind: &str, summary: &str, failed: bool) -> serde_json::Value {
        let at = format!("2026-10-18T10:{at}.000Z");
        json!({ "kind": "action", "at": at, "action": { "at": at, "kind": kind, "status": if failed { "failed" } else { "completed" },
                "summary": summary, "failed": failed } })
    }

    fn event(at: &str, kind: &str, data: serde_json::Value) -> HubEvent {
        serde_json::from_value(json!({ "seq": 1, "at": format!("2026-10-18T10:{at}.000Z"), "type": kind, "summary": kind, "data": data })).unwrap()
    }

    #[test]
    fn finished_turns_fold_and_other_orders_collapse() {
        let items = tail(json!([
            msg("02:00", "user", "New order W14: harden the digest"),
            act("02:05", "command", "cargo test", false),
            act("02:20", "file_change", "hub/leads/digest.rs", false),
            act("02:53", "command", "cargo clippy", true),
            msg("02:55", "assistant", "Froze the brief for W14: 2 checks, tier M."),
            msg("03:00", "assistant", "W12 is in CI."),
            act("03:01", "command", "gh pr checks 208", false),
            msg("03:02", "assistant", "W12 rebased."),
            msg("03:10", "assistant", "Waiting on T33's review."),
        ]));
        let conv = conversation(&items, "W14", &[], false, &[], &[]);
        assert!(matches!(&conv[0], Conv::Say { who: Who::You, .. }));
        assert_eq!(
            conv[1],
            Conv::Fold {
                key: "2026-10-18T10:02:00.000Z".into(),
                secs: 53,
                commands: 2,
                failed: 1,
                calls: vec![("cargo test".into(), false), ("hub/leads/digest.rs".into(), false), ("cargo clippy".into(), true)]
            }
        );
        assert!(matches!(&conv[2], Conv::Say { who: Who::Lead, text, .. } if text.starts_with("Froze")));
        assert_eq!(conv[3], Conv::Others { n: 2, about: "W12".into() }, "messages about W12 and their calls fold into one line");
        assert!(matches!(&conv[4], Conv::Say { text, .. } if text.starts_with("Waiting")), "a message naming no order is shown");
        assert_eq!(conv.len(), 5);
        assert_eq!(fold_label(53, 2, 1, 3), "Worked for 53s · ran 2 commands (1 failed)");
        assert_eq!(fold_label(125, 0, 0, 1), "Worked for 2m 05s · 1 tool call");
    }

    #[test]
    fn events_between_messages_merge_into_one_line_and_a_working_lead_shows_its_latest_calls() {
        let items = tail(json!([
            msg("02:00", "assistant", "Starting W14's writers."),
            msg("05:00", "assistant", "T31 is editing the digest."),
            act("05:10", "command", "a", false),
            act("05:11", "command", "b", false),
            act("05:12", "command", "c", false),
            act("05:13", "command", "d", false),
        ]));
        let e1 = event("03:00", "task.started", json!({ "workstreamId": "W14", "taskId": "T31" }));
        let e2 = event("03:01", "task.started", json!({ "workstreamId": "W14", "taskId": "T33" }));
        let e3 = event("03:02", "pr.merged", json!({ "workstreamId": "W14", "prNumber": 211 }));
        let conv = conversation(&items, "W14", &[&e1, &e2, &e3], true, &[], &[]);
        assert_eq!(conv[1], Conv::Events { at: "10:03:00".into(), text: "T31 started, T33 started, #211 merged".into() });
        assert_eq!(conv[3], Conv::Working { calls: vec![("b".into(), false), ("c".into(), false), ("d".into(), false)] });
    }

    #[test]
    fn order_ids_are_whole_words() {
        assert_eq!(mentions("W14 and W12, not W0 or AW3 or W5x"), vec!["W14", "W12"]);
        assert_eq!(mentions("(W7)"), vec!["W7"]);
    }

    fn lanes(statuses: &[(&str, &str, Option<u64>)]) -> Vec<AgentLane> {
        statuses
            .iter()
            .map(|(id, status, pr)| {
                let mut lane = json!({ "laneId": id, "role": "implementer", "title": id, "status": status });
                if let Some(n) = pr {
                    lane["pr"] = json!({ "changeId": "X1", "repo": "wynn-dev/fleetd", "number": n, "url": format!("https://github.com/wynn-dev/fleetd/pull/{n}"),
                        "state": "merged", "reviewsDone": 1, "reviewsNeeded": 1 });
                }
                serde_json::from_value(lane).unwrap()
            })
            .collect()
    }

    #[test]
    fn the_pill_leads_with_the_most_urgent_state_and_the_rollup_waits_for_every_agent() {
        let l = lanes(&[("T31", "working", None), ("T33", "working", None), ("T34", "queued", None), ("T30", "done", Some(211))]);
        assert_eq!(fan_out(&l, 1).as_deref(), Some("1 needs you · 2 working · 1 queued · 1 done"));
        assert_eq!(rollup(&l), None);
        let done = lanes(&[("T30", "done", Some(211)), ("T31", "done", Some(212))]);
        assert_eq!(fan_out(&done, 0).as_deref(), Some("all 2 done"));
        assert_eq!(rollup(&done).as_deref(), Some("All 2 agents finished: #211 #212"));
        let mixed = lanes(&[("T30", "done", None), ("T31", "done", None), ("T32", "failed", None)]);
        assert_eq!(rollup(&mixed).as_deref(), Some("2 of 3 finished; T32 failed"));
        assert_eq!(fan_out(&[], 0), None);
    }
}
