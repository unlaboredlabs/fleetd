//! The health strip: main CI per repo, machines (offline ones with how long, recent sleeps), Claude usage and the
//! slots. Each part carries the hub's as-of; one the hub marked stale is outlined with its age, and its reason is
//! in the list of stale sources above.

use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::status::{CiState, HealthUsage, StaleMark, StatusDoc};
use gpui::{AnyElement, Context, Div, Hsla, SharedString, Stateful, div, prelude::*, px};

use super::{age, span, stale_age, when};
use crate::shell::{Screen, Shell};
use crate::theme::{STRONG, Theme, radius, size, theme};
use crate::ui;

impl Shell {
    pub(super) fn status_health(&mut self, doc: &StatusDoc, now: i64, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let h = &doc.health;
        let mut ci = group(t, "main CI");
        if h.ci.is_empty() {
            ci = ci.child(div().text_color(t.quiet).child("no repos on the train"));
        }
        for (i, c) in h.ci.iter().enumerate() {
            let failing = c.failing.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(", ");
            let (mark, words, color) = match c.state {
                CiState::Green => (ui::dot(t.success), String::new(), t.quiet),
                CiState::Red => (ui::dot(t.danger), format!("red: {failing}"), t.danger),
                CiState::Pending => (ui::ring(t.quiet), "pending".to_string(), t.quiet),
                CiState::Unknown => (ui::ring(t.faint), "not checked since the hub started".to_string(), t.quiet),
            };
            let checked = c.as_of.as_ref().and_then(|a| super::ms(a.as_str())).map(|at| format!("checked {} ago", age(now - at))).unwrap_or_default();
            let url = format!("https://github.com/{}/actions", c.repo);
            let part = part(t, SharedString::from(format!("status-ci-{i}")), c.stale.as_ref())
                .child(mark)
                .child(div().text_color(t.text).child(SharedString::from(c.repo.to_string())))
                .when(!words.is_empty(), |d| d.child(div().text_color(color).child(words)))
                .child(div().text_color(t.quiet).child(checked))
                .children(stale_tail(t, c.stale.as_ref(), now))
                .on_click(move |_, _, cx| cx.open_url(&url));
            ci = ci.child(part);
        }
        let mut machines = group(t, "machines");
        let online = h.machines.iter().filter(|m| m.status == MachineStatus::Online).count();
        machines = machines.child(div().text_color(t.text).child(format!("{online} of {} online", h.machines.len())));
        for (i, m) in h.machines.iter().enumerate() {
            let seen = m.last_seen_at.as_ref().and_then(|a| super::ms(a.as_str())).map(|at| age(now - at));
            let (mark, words, color): (Div, String, Hsla) = match m.status {
                MachineStatus::Online if m.slept.is_none() && m.stale.is_none() => continue,
                MachineStatus::Online => (ui::dot(t.success), String::new(), t.quiet),
                MachineStatus::Degraded => (ui::dot(t.warning), format!("degraded, seen {} ago", seen.unwrap_or_default()), t.warning),
                MachineStatus::Offline => (ui::ring(t.warning), seen.map_or("offline, never seen".into(), |s| format!("offline {s}")), t.warning),
            };
            let slept = m.slept.filter(|_| m.status == MachineStatus::Online).map(|s| {
                let at = crate::live::state::fmt_iso(s.from_ms.get());
                format!("slept {} at {}", span(s.to_ms.get() - s.from_ms.get()), when(&at, now))
            });
            let drops = m.drops_today.get();
            machines = machines.child(
                part(t, SharedString::from(format!("status-machine-{i}")), m.stale.as_ref())
                    .child(mark)
                    .child(div().text_color(t.text).child(SharedString::from(m.machine_id.to_string())))
                    .when(!words.is_empty(), |d| d.child(div().text_color(color).child(words)))
                    .when_some(slept, |d, s| d.child(div().text_color(t.quiet).child(s)))
                    .when(drops >= 2, |d| d.child(div().text_color(t.warning).child(format!("{drops}× today"))))
                    .children(stale_tail(t, m.stale.as_ref(), now))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.go(Screen::Machines);
                        cx.notify();
                    })),
            );
        }
        let mut usage = group(t, "claude");
        if h.usage.is_empty() {
            usage = usage.child(div().text_color(t.quiet).child("no reading yet"));
        }
        for (i, u) in h.usage.iter().enumerate() {
            usage = usage.child(
                part(t, SharedString::from(format!("status-usage-{i}")), u.stale.as_ref())
                    .children(usage_words(t, u, now))
                    .children(stale_tail(t, u.stale.as_ref(), now))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.go(Screen::Machines);
                        cx.notify();
                    })),
            );
        }
        let s = &h.slots;
        let queued = if s.queued.get() > 0 { format!(" · {} queued", s.queued) } else { String::new() };
        let agents = group(t, "agents").child(div().text_color(t.text).child(format!("{} running · slots {}/{}{queued}", s.running, s.used, s.cap)));
        div()
            .py_3()
            .flex()
            .flex_wrap()
            .gap_x_6()
            .gap_y_2()
            .border_t_1()
            .border_b_1()
            .border_color(t.hairline)
            .text_size(px(size::XS))
            .child(ci)
            .child(machines)
            .child(usage)
            .child(agents)
            .into_any_element()
    }
}

/// "58% 5h · as of 10:05" for one usage window.
fn usage_words(t: &Theme, u: &HealthUsage, now: i64) -> Vec<Div> {
    let window = match u.limit_type.as_str() {
        "five_hour" => "5h",
        "seven_day" => "wk",
        "seven_day_opus" => "opus wk",
        "seven_day_sonnet" => "sonnet wk",
        other => other,
    };
    let pct = u.utilization.map(|v| (v.get() * 100.).round() as i64);
    let high = pct.is_some_and(|p| p >= 90) || matches!(u.status.as_str(), "allowed_warning" | "rejected");
    let as_of = u.observed_at.as_ref().map_or("no reading time".into(), |a| format!("as of {}", when(a.as_str(), now)));
    vec![
        div().text_color(if high { t.warning } else { t.text }).child(pct.map_or(format!("{window} unknown"), |p| format!("{p}% {window}"))),
        div().text_color(t.quiet).child(as_of),
    ]
}

fn group(t: &Theme, label: &'static str) -> Div {
    div().flex().flex_wrap().items_center().gap_2().child(div().font_weight(STRONG).text_color(t.quiet).child(label))
}

/// One clickable part of the strip; outlined with "stale 4m: reason" when the hub marked it.
fn part(t: &Theme, id: impl Into<SharedString>, stale: Option<&StaleMark>) -> Stateful<Div> {
    let hover = t.hover;
    let el = ui::clickable(t, div().id(id.into()))
        .flex()
        .items_center()
        .gap_1p5()
        .px_1p5()
        .py_0p5()
        .rounded(px(radius::SM))
        .border_1()
        .border_color(gpui::transparent_black())
        .hover(move |s| s.bg(hover));
    match stale {
        Some(_) => el.border_color(t.warning),
        None => el,
    }
}

/// A stale part ends with its age; the reason is in the list of stale sources above the strip.
fn stale_tail(t: &Theme, stale: Option<&StaleMark>, now: i64) -> Option<Div> {
    stale.map(|s| div().text_color(t.warning).child(stale_age(s, now)))
}
