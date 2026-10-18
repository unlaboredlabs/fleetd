//! The sidebar (spec 2.6): Board and Machines, then every project with its open orders beneath it, then the
//! connection. The amber dot means something there needs you; the quiet number is the project's running agents.
//! Holding ⌘ (Ctrl) shows jump numbers on the first nine orders, which ⌘1..9 open.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use fleetd_contracts::ledger::LeadState;
use fleetd_contracts::live::{LaneStatus, OrderCard};
use fleetd_contracts::model::MachineStatus;
use gpui::{AnyElement, App, Div, Hsla, SharedString, Window, div, prelude::*, px};

use crate::board::{on_board, sort_cards};
use crate::state::{ProjectKey, State};
use crate::theme::{STRONG, Theme, metric, size};
use crate::ui;

/// Where a click in the sidebar goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pick {
    Board,
    Machines,
    Project(ProjectKey),
    Order(String),
    Settings,
}

/// Called with where a sidebar click goes.
pub type OnPick = Rc<dyn Fn(Pick, &mut Window, &mut App)>;

/// Which entry is current.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Active {
    Board,
    Machines,
    Project(ProjectKey),
    Order(String),
    Settings,
    None,
}

/// Open asks per project.
pub fn needs_you(state: &State) -> HashMap<ProjectKey, usize> {
    let mut out = HashMap::new();
    for item in state.inbox() {
        if let Some(p) = &item.ask.project_ref {
            *out.entry((p.machine_id.to_string(), p.project_id.to_string())).or_insert(0) += 1;
        }
    }
    out
}

/// Orders with an open ask.
pub fn orders_needing_you(state: &State) -> HashSet<String> {
    state.inbox().iter().filter_map(|i| i.ask.workstream_id.as_ref().map(|w| w.to_string())).collect()
}

/// A project's agents that are running now.
pub fn running(cards: &[OrderCard]) -> usize {
    cards.iter().flat_map(|c| c.lanes.iter()).filter(|l| matches!(l.status, LaneStatus::Working | LaneStatus::Starting)).count()
}

/// The orders the sidebar lists, in its order (projects as listed, each project's orders as on the board).
pub fn orders(state: &State, now_secs: i64) -> Vec<(ProjectKey, String)> {
    let mut out = Vec::new();
    for row in &state.projects {
        let key = row.key();
        let mut cards: Vec<&OrderCard> = state.live.orders(&key).iter().filter(|c| on_board(c, now_secs)).collect();
        sort_cards(&mut cards);
        out.extend(cards.into_iter().map(|c| (key.clone(), c.workstream_id.to_string())));
    }
    out
}

/// What you have seen of each project: its last activity time when you last looked. Kept for the session;
/// what was there when the app connected counts as seen, so a launch doesn't light up every project.
#[derive(Default)]
pub struct Seen {
    at: HashMap<ProjectKey, String>,
    primed: HashSet<ProjectKey>,
}

impl Seen {
    /// Records each project's activity time the first time it appears, as already seen.
    pub fn prime(&mut self, state: &State) {
        for row in &state.projects {
            let key = row.key();
            if self.primed.insert(key.clone()) {
                self.at.insert(key, row.summary.last_activity_at.to_string());
            }
        }
    }

    pub fn mark(&mut self, key: &ProjectKey, last_activity_at: &str) {
        self.at.insert(key.clone(), last_activity_at.to_string());
    }

    /// Hub timestamps are fixed-width RFC 3339 in UTC, so string order is time order.
    pub fn unread(&self, key: &ProjectKey, last_activity_at: &str) -> bool {
        self.at.get(key).is_some_and(|seen| last_activity_at > seen.as_str())
    }
}

pub struct Conn {
    pub label: SharedString,
    pub color: Hsla,
}

/// `notice` (the update notice) sits above the connection line.
#[allow(clippy::too_many_arguments)]
pub fn render(
    t: &Theme,
    state: &State,
    seen: &Seen,
    active: &Active,
    now_secs: i64,
    jump_hints: bool,
    conn: Conn,
    notice: Option<AnyElement>,
    on_pick: OnPick,
) -> Div {
    let down = state.machines.iter().filter(|m| m.status != MachineStatus::Online).count();
    let needs = needs_you(state);
    let order_needs = orders_needing_you(state);
    let entry = |id: &'static str, label: &'static str, pick: Pick, is_active: bool, trailing: AnyElement| {
        let on_pick = on_pick.clone();
        ui::row(t, id, is_active).child(div().flex_1().child(label)).child(trailing).on_click(move |_, window, cx| on_pick(pick.clone(), window, cx))
    };
    let machines_note = if down > 0 {
        div().text_size(px(size::XS)).text_color(t.warning).child(format!("{down} down")).into_any_element()
    } else {
        div().into_any_element()
    };
    let board_keys = ui::kbd(t, ui::shortcut("0")).into_any_element();

    let mut projects = div().id("sidebar-projects").flex_1().min_h_0().overflow_y_scroll().px_2().pb_2().flex().flex_col();
    if state.projects.is_empty() {
        projects = projects.child(
            div()
                .px_2()
                .py_1()
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .whitespace_normal()
                .child("No projects yet. Run fleetd init again on the hub: it offers the repos it finds."),
        );
    }
    let mut jump = 0;
    for row in &state.projects {
        let key = row.key();
        let selected = *active == Active::Project(key.clone());
        let n = needs.get(&key).copied().unwrap_or(0);
        let unread = !selected && seen.unread(&key, row.summary.last_activity_at.as_str());
        let stalled = row.lead().is_some_and(|l| l.state == LeadState::Stalled);
        let all = state.live.orders(&key);
        let mut cards: Vec<&OrderCard> = all.iter().filter(|c| on_board(c, now_secs)).collect();
        sort_cards(&mut cards);
        let agents = running(all);
        let on_pick_p = on_pick.clone();
        let pick = Pick::Project(key.clone());
        projects = projects.child(
            ui::row(t, SharedString::from(format!("p-{}-{}", key.0, key.1)), selected)
                .child(div().w(px(6.)).flex_none().when(unread, |d| d.child(ui::unread(t))))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .when(n > 0, |d| d.font_weight(STRONG))
                        .when(n == 0 && cards.is_empty() && !selected, |d| d.text_color(t.quiet))
                        .child(row.summary.title.clone()),
                )
                .when(n > 0, |d| d.child(ui::dot(t.warning)))
                .when(stalled && n == 0, |d| d.child(div().text_size(px(size::XS)).text_color(t.warning).child("stalled")))
                .when(agents > 0, |d| {
                    d.child(div().font_family(t.mono_font.clone()).text_size(px(size::XS)).text_color(t.quiet).child(agents.to_string()))
                })
                .on_click(move |_, window, cx| on_pick_p(pick.clone(), window, cx)),
        );
        for card in cards {
            let id = card.workstream_id.to_string();
            let open = *active == Active::Order(id.clone());
            let needs = order_needs.contains(&id);
            jump += 1;
            let hint = (jump_hints && jump <= 9).then(|| jump.to_string());
            let on_pick_o = on_pick.clone();
            let pick = Pick::Order(id.clone());
            projects = projects.child(
                ui::row(t, SharedString::from(format!("o-{id}")), open)
                    .h(px(metric::ROW - 4.))
                    .pl(px(22.))
                    .text_size(px(size::XS))
                    .child(div().w(px(30.)).flex_none().font_family(t.mono_font.clone()).text_color(t.quiet).child(id.clone()))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(if needs || open { t.text } else { t.quiet })
                            .when(needs, |d| d.font_weight(STRONG))
                            .child(card.title.to_string()),
                    )
                    .when(needs, |d| d.child(ui::dot(t.warning)))
                    .when_some(hint, |d, h| d.child(div().text_color(t.accent).child(h)))
                    .on_click(move |_, window, cx| on_pick_o(pick.clone(), window, cx)),
            );
        }
    }

    let settings_pick = on_pick.clone();
    div()
        .w(px(metric::SIDEBAR))
        .flex_none()
        .h_full()
        .flex()
        .flex_col()
        .bg(t.sidebar)
        .text_size(px(size::MD))
        .text_color(t.text)
        .child(
            div()
                .pt_2()
                .px_2()
                .pb_2()
                .flex()
                .flex_col()
                .border_b_1()
                .border_color(t.hairline)
                .child(entry("nav-board", "Board", Pick::Board, *active == Active::Board, board_keys))
                .child(entry("nav-machines", "Machines", Pick::Machines, *active == Active::Machines, machines_note)),
        )
        .child(div().h(px(8.)))
        .child(projects)
        .children(notice)
        .child(
            ui::clickable(t, div().id("sidebar-conn"))
                .h(px(metric::BAR))
                .flex_none()
                .px_4()
                .flex()
                .items_center()
                .gap_2()
                .border_t_1()
                .border_color(t.hairline)
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .hover(|s| s.opacity(0.8))
                .on_click(move |_, window, cx| settings_pick(Pick::Settings, window, cx))
                .child(ui::dot(conn.color))
                .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(conn.label)),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_you_counts_open_asks_per_project_and_order() {
        let state = crate::fake::fixture_state();
        let needs = needs_you(&state);
        assert_eq!(needs.get(&("devbox".to_string(), "storefront".to_string())), Some(&1));
        assert!(orders_needing_you(&state).contains("W14"));
    }

    #[test]
    fn sidebar_orders_follow_the_project_list_and_board_order() {
        let state = crate::fake::fixture_state();
        let now = crate::notify::unix_secs("2026-10-18T10:07:12.000Z").unwrap();
        let ids: Vec<String> = orders(&state, now).into_iter().map(|(_, w)| w).collect();
        assert_eq!(&ids[..2], ["W14", "W12"], "storefront first, its needs-you order on top");
        assert_eq!(running(state.live.orders(&("devbox".into(), "storefront".into()))), 2, "two lanes working in W14");
    }

    #[test]
    fn projects_are_read_on_first_sight_and_unread_after_new_activity() {
        let mut state = crate::fake::fixture_state();
        let mut seen = Seen::default();
        seen.prime(&state);
        let key = state.projects[0].key();
        let at = state.projects[0].summary.last_activity_at.to_string();
        assert!(!seen.unread(&key, &at));
        assert!(seen.unread(&key, "2026-10-19T10:05:00.000Z"));
        seen.mark(&key, "2026-10-19T10:05:00.000Z");
        assert!(!seen.unread(&key, "2026-10-19T10:05:00.000Z"));
        // Priming again after a refresh doesn't overwrite what you have (not) seen.
        state.projects[0].summary.last_activity_at = serde_json::from_value(serde_json::json!("2026-10-19T11:00:00.000Z")).unwrap();
        seen.prime(&state);
        assert!(seen.unread(&key, "2026-10-19T11:00:00.000Z"));
    }
}
