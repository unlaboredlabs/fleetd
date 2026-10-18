//! The filter bar over all three tabs: time range, project, order, machine and role, plus compare with the period
//! before. Choices persist in the app's preferences. On an order the range is the order's own, so range and
//! compare step aside.

use fleetd_contracts::live::AgentRole;
use gpui::{AnyElement, Context, Div, MouseButton, Pixels, Point, SharedString, anchored, deferred, div, point, prelude::*, px};
use serde::{Deserialize, Serialize};

use super::{Tab, TimeView};
use crate::live::chips::role_word;
use crate::live::state::parse_ms;
use crate::state::ProjectKey;
use crate::theme::{Theme, metric, size};
use crate::ui::{self, Variant};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Range {
    Hour,
    Today,
    #[default]
    Week,
    Month,
    Custom,
}

impl Range {
    pub const PRESETS: [Range; 4] = [Range::Hour, Range::Today, Range::Week, Range::Month];

    pub fn label(self) -> &'static str {
        match self {
            Range::Hour => "Last hour",
            Range::Today => "Today (UTC)",
            Range::Week => "Last 7 days",
            Range::Month => "Last 30 days",
            Range::Custom => "Custom",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    pub range: Range,
    /// The custom range, hub ms: (since, until or now).
    pub custom: Option<(i64, Option<i64>)>,
    pub project: Option<ProjectKey>,
    pub machine: Option<String>,
    pub role: Option<AgentRole>,
    pub compare: bool,
}

const DAY: i64 = 86_400_000;

/// (since, until) in hub ms for a range ending now; `None` until means now.
pub fn period(range: Range, now_ms: i64, custom: Option<(i64, Option<i64>)>) -> (i64, Option<i64>) {
    match range {
        Range::Hour => (now_ms - 3_600_000, None),
        Range::Today => (now_ms - now_ms.rem_euclid(DAY), None),
        Range::Week => (now_ms - 7 * DAY, None),
        Range::Month => (now_ms - 30 * DAY, None),
        Range::Custom => custom.unwrap_or((now_ms - 7 * DAY, None)),
    }
}

/// "2026-10-12" or "2026-10-12 09:30" (UTC) → hub ms. Empty is `None` (now, for the end).
pub fn parse_when(text: &str) -> Option<i64> {
    let t = text.trim();
    match t.len() {
        10 => parse_ms(&format!("{t}T00:00:00.000Z")),
        16 => parse_ms(&format!("{}T{}:00.000Z", &t[..10], &t[11..])),
        _ => parse_ms(t),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKind {
    Range,
    Project,
    Order,
    Machine,
    Role,
    Custom,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Menu {
    pub kind: MenuKind,
    pub at: Point<Pixels>,
}

const ROLES: [AgentRole; 6] = [AgentRole::Lead, AgentRole::Implementer, AgentRole::Reader, AgentRole::Reviewer, AgentRole::Verifier, AgentRole::Qa];

fn chip(t: &Theme, id: &'static str, label: String, enabled: bool, kind: MenuKind, cx: &mut Context<TimeView>) -> impl IntoElement {
    ui::button(t, id, format!("{label} ▾"), Variant::Secondary, enabled).when(enabled, |b| {
        b.on_click(cx.listener(move |v, e: &gpui::ClickEvent, _, cx| {
            let at = e.position();
            v.menu =
                if v.menu.as_ref().is_some_and(|m| m.kind == kind) { None } else { Some(Menu { kind, at: point(at.x - px(8.), at.y + px(14.)) }) };
            cx.notify();
        }))
    })
}

pub fn bar(v: &TimeView, t: &Theme, cx: &mut Context<TimeView>) -> Div {
    let f = &v.filters;
    let order = v.order.is_some();
    let range = if order { "Whole order".to_string() } else { f.range.label().to_string() };
    let project = f
        .project
        .as_ref()
        .map_or("All projects".to_string(), |k| v.names.projects.iter().find(|(p, _)| p == k).map_or(k.1.clone(), |(_, n)| n.clone()));
    let order_label = v.order.clone().map_or("All orders".to_string(), |w| format!("Order {w}"));
    let machine = f.machine.clone().unwrap_or_else(|| "All machines".into());
    let role = f.role.map_or("All roles".to_string(), |r| role_word(r).to_string());
    let compare = !order && f.compare;
    let period = if order {
        String::new()
    } else {
        let (since, until) = period(f.range, v.now_ms, f.custom);
        let end = until.map_or("now".to_string(), |u| crate::live::state::fmt_iso(u)[..16].replace('T', " "));
        format!("{} to {end} UTC", crate::live::state::fmt_iso(since)[..16].replace('T', " "))
    };
    div()
        .min_h(px(metric::BAR - 4.))
        .flex_none()
        .px_4()
        .py_1()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_1p5()
        .border_b_1()
        .border_color(t.hairline)
        .child(chip(t, "f-range", range, !order, MenuKind::Range, cx))
        .child(chip(t, "f-project", project, !order, MenuKind::Project, cx))
        .child(chip(t, "f-order", order_label, true, MenuKind::Order, cx))
        .child(chip(t, "f-machine", machine, true, MenuKind::Machine, cx))
        .child(chip(t, "f-role", role, true, MenuKind::Role, cx))
        .child(
            ui::button(
                t,
                "f-compare",
                if compare { "Comparing with the period before" } else { "Compare with the period before" },
                if compare { Variant::Secondary } else { Variant::Ghost },
                !order,
            )
            .when(!order, |b| {
                b.on_click(cx.listener(|v, _, _, cx| {
                    v.filters.compare = !v.filters.compare;
                    v.filters_changed(cx);
                }))
            }),
        )
        .child(div().flex_1())
        .child(div().text_size(px(size::XS)).text_color(t.quiet).child(period))
}

/// The open filter's choices, under the chip that opened it. A click outside closes it.
pub fn menu(v: &TimeView, t: &Theme, cx: &mut Context<TimeView>) -> Option<AnyElement> {
    let m = v.menu.clone()?;
    type Pick = Box<dyn Fn(&mut TimeView)>;
    let mut options: Vec<(String, bool, Pick)> = Vec::new();
    let f = v.filters.clone();
    match m.kind {
        MenuKind::Range => {
            for r in Range::PRESETS {
                options.push((r.label().into(), f.range == r, Box::new(move |v| v.filters.range = r)));
            }
            options.push((
                "Custom…".into(),
                f.range == Range::Custom,
                Box::new(|v| {
                    v.menu = v.menu.take().map(|m| Menu { kind: MenuKind::Custom, ..m });
                }),
            ));
        }
        MenuKind::Project => {
            options.push(("All projects".into(), f.project.is_none(), Box::new(|v| v.filters.project = None)));
            for (key, name) in v.names.projects.clone() {
                let on = f.project.as_ref() == Some(&key);
                options.push((name, on, Box::new(move |v| v.filters.project = Some(key.clone()))));
            }
        }
        MenuKind::Order => {
            options.push((
                "All orders (totals)".into(),
                v.order.is_none(),
                Box::new(|v| {
                    v.order = None;
                    if v.tab == Tab::Timeline {
                        v.tab = Tab::Breakdown;
                    }
                }),
            ));
            let mut orders: Vec<(String, String, String)> =
                v.names.orders.iter().map(|(w, (title, p))| (w.clone(), title.clone(), p.clone())).collect();
            let project = f.project.as_ref().and_then(|k| v.names.projects.iter().find(|(p, _)| p == k).map(|(_, n)| n.clone()));
            orders.retain(|(_, _, p)| project.as_ref().is_none_or(|want| want == p));
            orders.sort_by_key(|(w, _, _)| std::cmp::Reverse(w.trim_start_matches('W').parse::<i64>().unwrap_or(0)));
            for (w, title, p) in orders.into_iter().take(40) {
                let on = v.order.as_deref() == Some(w.as_str());
                options.push((
                    format!("{w}  {title} · {p}"),
                    on,
                    Box::new(move |v| {
                        v.order = Some(w.clone());
                        v.tab = Tab::Timeline;
                        v.view = None;
                        v.highlight = None;
                    }),
                ));
            }
        }
        MenuKind::Machine => {
            options.push(("All machines".into(), f.machine.is_none(), Box::new(|v| v.filters.machine = None)));
            for name in v.names.machines.clone() {
                let on = f.machine.as_deref() == Some(name.as_str());
                options.push((name.clone(), on, Box::new(move |v| v.filters.machine = Some(name.clone()))));
            }
        }
        MenuKind::Role => {
            options.push(("All roles".into(), f.role.is_none(), Box::new(|v| v.filters.role = None)));
            for r in ROLES {
                options.push((role_word(r).into(), f.role == Some(r), Box::new(move |v| v.filters.role = Some(r))));
            }
        }
        MenuKind::Custom => {}
    }
    let card = if m.kind == MenuKind::Custom {
        custom_card(v, t, cx)
    } else {
        let mut list = div().id("time-menu").max_h(px(360.)).overflow_y_scroll().p_1().flex().flex_col();
        for (ix, (label, on, pick)) in options.into_iter().enumerate() {
            let pick = std::rc::Rc::new(pick);
            let reopen = matches!(m.kind, MenuKind::Range) && label == "Custom…";
            list = list.child(
                ui::row(t, SharedString::from(format!("menu-{ix}")), on)
                    .min_w(px(220.))
                    .text_size(px(size::MD))
                    .child(div().min_w_0().overflow_hidden().text_ellipsis().child(label))
                    .on_click(cx.listener(move |v, _, _, cx| {
                        pick(v);
                        if reopen {
                            cx.notify();
                        } else {
                            v.filters_changed(cx);
                        }
                    })),
            );
        }
        ui::floating(t).child(list)
    };
    let layer = div()
        .absolute()
        .inset_0()
        .occlude()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|v, _, _, cx| {
                v.menu = None;
                cx.notify();
            }),
        )
        .child(deferred(anchored().position(m.at).snap_to_window_with_margin(px(8.)).child(card.occlude())).with_priority(1));
    Some(layer.into_any_element())
}

fn custom_card(v: &TimeView, t: &Theme, cx: &mut Context<TimeView>) -> Div {
    let (since, until) = v.custom.clone();
    let field = |input: gpui::Entity<crate::input::TextInput>, label: &'static str| {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(div().text_size(px(size::XS)).text_color(t.quiet).child(label))
            .child(ui::field(t, false).w(px(200.)).px_2().child(input))
    };
    let bad = v.custom_error.clone();
    ui::floating(t)
        .p_3()
        .flex()
        .flex_col()
        .gap_2()
        .child(div().text_size(px(size::XS)).text_color(t.quiet).child("Dates in UTC: 2026-10-12 or 2026-10-12 09:30."))
        .child(div().flex().gap_2().child(field(since, "From")).child(field(until, "To (empty: now)")))
        .when_some(bad, |d, e| d.child(div().text_size(px(size::XS)).text_color(t.danger).child(e)))
        .child(div().flex().justify_end().child(ui::button(t, "custom-apply", "Apply", Variant::Primary, true).on_click(cx.listener(
            |v, _, _, cx| {
                let (s, u) = (v.custom.0.read(cx).text().to_string(), v.custom.1.read(cx).text().to_string());
                match (parse_when(&s), if u.trim().is_empty() { Some(None) } else { parse_when(&u).map(Some) }) {
                    (Some(since), Some(until)) if until.is_none_or(|u| u > since) => {
                        v.custom_error = None;
                        v.filters.custom = Some((since, until));
                        v.filters.range = Range::Custom;
                        v.filters_changed(cx);
                    }
                    _ => {
                        v.custom_error = Some("Couldn't read those dates, or the end is before the start.".into());
                        cx.notify();
                    }
                }
            },
        ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_end_now_and_today_starts_at_utc_midnight() {
        let now = parse_ms("2026-10-18T10:07:12.000Z").unwrap();
        assert_eq!(period(Range::Hour, now, None), (now - 3_600_000, None));
        assert_eq!(period(Range::Today, now, None).0, parse_ms("2026-10-18T00:00:00.000Z").unwrap());
        assert_eq!(period(Range::Week, now, None).0, parse_ms("2026-10-11T10:07:12.000Z").unwrap());
        let custom = (parse_ms("2026-10-01T00:00:00.000Z").unwrap(), Some(now));
        assert_eq!(period(Range::Custom, now, Some(custom)), custom);
    }

    #[test]
    fn custom_dates_read_as_utc() {
        assert_eq!(parse_when("2026-10-12"), parse_ms("2026-10-12T00:00:00.000Z"));
        assert_eq!(parse_when(" 2026-10-12 09:30 "), parse_ms("2026-10-12T09:30:00.000Z"));
        assert_eq!(parse_when("last tuesday"), None);
    }

    #[test]
    fn filters_survive_a_round_trip_and_tolerate_old_files() {
        let f = Filters {
            range: Range::Month,
            project: Some(("devbox".into(), "storefront".into())),
            role: Some(AgentRole::Reviewer),
            compare: true,
            ..Default::default()
        };
        let back: Filters = serde_json::from_value(serde_json::to_value(&f).unwrap()).unwrap();
        assert_eq!(back, f);
        let old: Filters = serde_json::from_str("{}").unwrap();
        assert_eq!(old.range, Range::Week);
    }
}
