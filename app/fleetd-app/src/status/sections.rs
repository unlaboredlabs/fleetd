//! The lists under the strip, one line per item: the scope's parts (projects, milestones), Needs you with the
//! inbox's one-tap answers, Risks, In progress joined to the live lanes, Next up and Done. Rows that arrive while
//! the view is open grow in; nothing moves on the first paint.

use std::collections::HashSet;

use fleetd_contracts::ledger::{Ask, BatchId, WorkstreamId};
use fleetd_contracts::live::AgentLane;
use fleetd_contracts::status::{RiskLevel, RiskRule, ScopePart, StatusDoc, StatusScope};
use gpui::{AnyElement, Context, Div, SharedString, div, prelude::*, px};

use super::number;
use super::{stale_age, when};
use crate::inbox::Fit;
use crate::live::motion::{self, Presence};
use crate::shell::{Screen, Shell};
use crate::theme::{STRONG, Theme, metric, radius, size, theme};
use crate::ui;

/// Rows seen so far per list, so only new ones animate in. Reset with each session (skeleton, scope switch).
#[derive(Default)]
pub struct Lists {
    session: u64,
    in_progress: Presence<String>,
    done: Presence<String>,
    entered: HashSet<String>,
}

impl Lists {
    fn diff(&mut self, session: u64, doc: &StatusDoc) {
        if session != self.session {
            *self = Self { session, ..Self::default() };
        }
        let doing = doc.in_progress.iter().map(|r| format!("p-{}", row_key(r.item_id.as_deref(), Some(r.workstream_id.as_str()))));
        let done = doc.done.iter().map(|r| format!("d-{}", row_key(r.item_id.as_deref(), r.workstream_id.as_deref())));
        let mut entered = self.in_progress.diff(doing).entered;
        entered.extend(self.done.diff(done).entered);
        // Kept until the row leaves, so a redraw mid-animation does not cut it short.
        self.entered.extend(entered);
    }
}

fn row_key(item: Option<&str>, order: Option<&str>) -> String {
    format!("{}{}", item.unwrap_or(""), order.unwrap_or(""))
}

impl Shell {
    pub(super) fn status_sections(&mut self, doc: &StatusDoc, now: i64, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        self.status_ui.lists.diff(self.state.status.session, doc);
        let mut col = div().flex().flex_col();
        if !doc.parts.is_empty() {
            let label = match doc.scope {
                StatusScope::Fleet => "Projects",
                _ => "Milestones",
            };
            col = col.child(head(t, label, doc.parts.len() as i64, doc.more.parts.get()));
            for (i, p) in doc.parts.iter().enumerate() {
                col = col.child(self.part_row(i, p, now, cx));
            }
        }
        col = col.child(self.needs_you(doc, cx));
        col = col.child(head(t, "Risks", doc.risks.len() as i64, doc.more.risks.get()));
        if doc.risks.is_empty() {
            col = col.child(none(t, "No risks the rules see."));
        }
        for (i, r) in doc.risks.iter().enumerate() {
            let color = if r.level == RiskLevel::Danger { t.danger } else { t.warning };
            let mark = div().flex_none().text_color(color).child("▲");
            let text = div().min_w_0().overflow_hidden().text_ellipsis().child(SharedString::from(r.message.to_string()));
            let row = match r.rule {
                RiskRule::MachineOffline | RiskRule::MachineFlaky | RiskRule::UsageHigh => {
                    ui::row(t, SharedString::from(format!("status-risk-{i}")), false)
                        .child(mark)
                        .child(text)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.go(Screen::Machines);
                            cx.notify();
                        }))
                        .into_any_element()
                }
                RiskRule::BlockedOnYou => ui::row(t, SharedString::from(format!("status-risk-{i}")), false)
                    .child(mark)
                    .child(text)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_inbox(true, cx)))
                    .into_any_element(),
                _ => line(t).child(mark).child(text).into_any_element(),
            };
            col = col.child(row);
        }
        col = col.child(head(t, "In progress", doc.in_progress.len() as i64, doc.more.in_progress.get()));
        if doc.in_progress.is_empty() {
            col = col.child(none(t, "Nothing running."));
        }
        // The activity comes from the live feed, not the doc: shown as the lanes show it when that feed stalls.
        let live_stale = self.state.live_stale() && self.bench.is_none();
        for (i, r) in doc.in_progress.iter().enumerate() {
            let lanes = self.state.live.lanes(&r.workstream_id);
            let lane = r.task_ids.iter().find_map(|task| lanes.iter().find(|l| l.task_id.as_ref() == Some(task))).cloned();
            let key = format!("p-{}", row_key(r.item_id.as_deref(), Some(r.workstream_id.as_str())));
            let row = ui::row(t, SharedString::from(format!("status-doing-{i}")), false)
                .when(r.stale.is_some(), |d| d.border_1().border_color(t.warning))
                .child(item_id(t, r.item_id.as_deref().unwrap_or(r.workstream_id.as_str())))
                .child(
                    div()
                        .flex_none()
                        .max_w(px(260.))
                        .overflow_hidden()
                        .text_ellipsis()
                        .text_color(t.text)
                        .child(SharedString::from(r.title.to_string())),
                )
                .child(activity(t, lane.as_ref(), &r.task_ids.iter().map(|t| t.to_string()).collect::<Vec<_>>(), live_stale))
                .children(
                    r.gate.as_ref().map(|g| div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(format!("waiting on {}", &**g))),
                )
                .children(r.stale.as_ref().map(|s| div().flex_none().text_size(px(size::XS)).text_color(t.warning).child(stale_age(s, now))))
                .on_click(order_click(r.workstream_id.clone(), cx));
            col = col.child(self.entering(&key, row.into_any_element()));
        }
        col = col.child(head(t, "Next up", doc.next.len() as i64, doc.more.next.get()));
        if doc.next.is_empty() {
            col = col.child(none(t, "Nothing queued in the plan."));
        }
        for (i, r) in doc.next.iter().enumerate() {
            let after = (!r.after.is_empty()).then(|| format!("after {}", r.after.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ")));
            let cells = [
                item_id(t, r.item_id.as_str()),
                div().min_w_0().overflow_hidden().text_ellipsis().text_color(t.text).child(SharedString::from(r.title.to_string())),
                div().flex_none().text_size(px(size::XS)).text_color(t.quiet).children(after),
            ];
            col = col.child(match &r.workstream_id {
                Some(w) => ui::row(t, SharedString::from(format!("status-next-{i}")), false)
                    .children(cells)
                    .on_click(order_click(w.clone(), cx))
                    .into_any_element(),
                None => line(t).children(cells).into_any_element(),
            });
        }
        col = col.child(head(t, "Done", doc.done.len() as i64, doc.more.done.get()));
        if doc.done.is_empty() {
            col = col.child(none(t, "Nothing verified yet. Items count as done only when fleetd's checks pass."));
        }
        for (i, r) in doc.done.iter().enumerate() {
            let key = format!("d-{}", row_key(r.item_id.as_deref(), r.workstream_id.as_deref()));
            let cells = [
                div().flex_none().text_color(t.success).child("✓"),
                item_id(t, r.item_id.as_deref().or(r.workstream_id.as_deref()).unwrap_or("")),
                div().flex_none().max_w(px(300.)).overflow_hidden().text_ellipsis().text_color(t.text).child(SharedString::from(r.title.to_string())),
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(SharedString::from(r.evidence.to_string())),
                div().flex_1(),
                div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(when(r.done_at.as_str(), now)),
            ];
            let row = match &r.workstream_id {
                Some(w) => ui::row(t, SharedString::from(format!("status-done-{i}")), false)
                    .children(cells)
                    .on_click(order_click(w.clone(), cx))
                    .into_any_element(),
                None => line(t).children(cells).into_any_element(),
            };
            col = col.child(self.entering(&key, row));
        }
        col.into_any_element()
    }

    fn entering(&mut self, key: &str, row: AnyElement) -> AnyElement {
        if self.status_ui.lists.entered.contains(key) {
            motion::enter_sized(SharedString::from(format!("status-enter-{key}")), row, px(metric::ROW))
        } else {
            row
        }
    }

    fn part_row(&mut self, i: usize, p: &ScopePart, now: i64, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let pr = &p.progress;
        let empty = pr.total.get() == 0 && pr.polish_total.get() == 0;
        let cells = div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .gap_2()
            .child(div().w(px(220.)).flex_none().overflow_hidden().text_ellipsis().text_color(t.text).child(SharedString::from(p.title.to_string())))
            .child(div().w(px(36.)).flex_none().text_color(t.text).font_weight(STRONG).child(if empty {
                "–".into()
            } else {
                format!("{}%", pr.pct)
            }))
            .child(div().w(px(220.)).flex_none().child(number::bar(t, if empty { 0 } else { pr.pct.get() }, None, 4.)))
            .child(div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(if empty {
                "no plan items".into()
            } else {
                format!("{}/{} must", pr.done, pr.total)
            }))
            .children(pr.marker.as_ref().map(|m| {
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(size::XS))
                    .text_color(t.warning)
                    .child(SharedString::from(m.text.to_string()))
            }))
            .children(pr.stale.as_ref().map(|s| div().flex_none().text_size(px(size::XS)).text_color(t.warning).child(stale_age(s, now))));
        let stale = pr.stale.is_some();
        match &p.scope {
            Some(scope) => {
                let scope = scope.clone();
                ui::row(t, SharedString::from(format!("status-part-{i}")), false)
                    .when(stale, |d| d.border_1().border_color(t.warning))
                    .child(cells)
                    .on_click(cx.listener(move |this, _, _, cx| this.open_status(scope.clone(), cx)))
                    .into_any_element()
            }
            None => line(t).when(stale, |d| d.border_1().border_color(t.warning)).child(cells).into_any_element(),
        }
    }

    /// The scope's open asks with the same one-tap answers as the inbox.
    fn needs_you(&mut self, doc: &StatusDoc, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let count = doc.needs_you.count.get();
        let shown: Vec<(BatchId, i64, Ask)> = doc
            .needs_you
            .ask_ids
            .iter()
            .filter_map(|id| self.state.inbox().into_iter().find(|i| i.ask.ask_id == *id).map(|i| (i.batch_id.clone(), i.number, i.ask.clone())))
            .collect();
        let mut col = div().flex().flex_col().child(head(t, "Needs you", count, 0));
        if count == 0 {
            return col.child(none(t, "Nothing needs you."));
        }
        for (batch, number, ask) in &shown {
            col = col.child(div().px_2().child(self.ask_block(batch, *number, ask, Fit::Strip, false, cx)));
        }
        let rest = count - shown.len() as i64;
        if rest > 0 {
            col = col.child(
                ui::row(t, "status-needs-more", false)
                    .text_size(px(size::XS))
                    .text_color(t.accent)
                    .child(format!("{rest} more in the inbox {}", ui::shortcut("I")))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_inbox(true, cx))),
            );
        }
        col
    }
}

fn order_click(w: WorkstreamId, cx: &mut Context<Shell>) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    cx.listener(move |this, _, _, cx| this.open_order(w.as_str(), cx))
}

/// A section head: "In progress 3", with "+2 more" when the hub capped the list.
fn head(t: &Theme, label: &'static str, n: i64, more: i64) -> Div {
    div()
        .pt_5()
        .pb_1()
        .px_2()
        .flex()
        .items_center()
        .gap_2()
        .text_size(px(size::XS))
        .child(div().font_weight(STRONG).text_color(t.quiet).child(label))
        .child(div().text_color(t.quiet).child(n.to_string()))
        .when(more > 0, |d| d.child(div().text_color(t.quiet).child(format!("+{more} more not shown"))))
}

/// A row that isn't a control: the list's metrics without hover or focus.
fn line(t: &Theme) -> Div {
    div()
        .w_full()
        .h(px(metric::ROW))
        .flex_none()
        .px_2()
        .flex()
        .items_center()
        .gap_2()
        .rounded(px(radius::SM))
        .whitespace_nowrap()
        .overflow_hidden()
        .text_color(t.text)
}

fn none(t: &Theme, text: &'static str) -> Div {
    div().px_2().h(px(metric::ROW)).flex().items_center().text_color(t.quiet).child(text)
}

fn item_id(t: &Theme, id: &str) -> Div {
    div()
        .w(px(44.))
        .flex_none()
        .font_family(t.mono_font.clone())
        .text_size(px(size::SM))
        .text_color(t.quiet)
        .child(SharedString::from(id.to_string()))
}

/// What the item's agent is doing now, from the live lanes: its role and activity, or its task ids when no lane
/// is on screen.
fn activity(t: &Theme, lane: Option<&AgentLane>, tasks: &[String], stale: bool) -> Div {
    let inner = match lane {
        Some(l) => div()
            .flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .child(crate::live::chips::role_tag(t, l.role, size::XS))
            .child(crate::live::activity::render(t, &crate::live::activity::describe(l), stale)),
        None if !tasks.is_empty() => div().text_size(px(size::XS)).text_color(t.quiet).child(tasks.join(", ")),
        None => div(),
    };
    div().flex_1().min_w_0().overflow_hidden().pl_2().rounded(px(radius::SM)).child(inner)
}
