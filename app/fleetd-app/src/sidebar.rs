//! The sidebar: Inbox and Machines, then every project, then the connection. A project that has an open ask
//! is set in full-weight text with its count; one with news since you last looked has the accent dot; a
//! stalled lead gets a warning dot; the rest are quiet. The open project lists its threads beneath it.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use fleetd_contracts::ledger::LeadState;
use fleetd_contracts::model::{MachineStatus, ThreadStatus};
use gpui::{AnyElement, App, Div, Hsla, SharedString, Window, div, prelude::*, px};

use crate::state::{ProjectKey, State};
use crate::theme::{STRONG, Theme, metric, size};
use crate::ui;

/// Where a click in the sidebar goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pick {
    Inbox,
    Projects,
    Machines,
    Project(ProjectKey),
    Settings,
}

/// Called with where a sidebar click goes.
pub type OnPick = Rc<dyn Fn(Pick, &mut Window, &mut App)>;

/// Which entry is current.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Active {
    Inbox,
    Projects,
    Machines,
    Project(ProjectKey),
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
pub fn render(t: &Theme, state: &State, seen: &Seen, active: &Active, conn: Conn, notice: Option<AnyElement>, on_pick: OnPick) -> Div {
    let asks = state.inbox().len();
    let down = state.machines.iter().filter(|m| m.status != MachineStatus::Online).count();
    let needs = needs_you(state);
    let entry = |id: &'static str, label: &'static str, pick: Pick, is_active: bool, trailing: AnyElement| {
        let on_pick = on_pick.clone();
        ui::row(t, id, is_active).child(div().flex_1().child(label)).child(trailing).on_click(move |_, window, cx| on_pick(pick.clone(), window, cx))
    };
    let inbox_count = if asks > 0 { ui::count(t, asks, true).into_any_element() } else { div().into_any_element() };
    let machines_note = if down > 0 {
        div().text_size(px(size::XS)).text_color(t.warning).child(format!("{down} down")).into_any_element()
    } else {
        div().into_any_element()
    };

    let mut projects = div().id("sidebar-projects").flex_1().min_h_0().overflow_y_scroll().px_2().pb_2().flex().flex_col();
    if state.projects.is_empty() {
        projects = projects.child(
            div()
                .px_4()
                .py_1()
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .whitespace_normal()
                .child("No projects yet. Add one with fleetd init on the hub."),
        );
    }
    for row in &state.projects {
        let key = row.key();
        let open = *active == Active::Project(key.clone());
        let n = needs.get(&key).copied().unwrap_or(0);
        let unread = !open && seen.unread(&key, row.summary.last_activity_at.as_str());
        let stalled = row.lead().is_some_and(|l| l.state == LeadState::Stalled);
        let on_pick = on_pick.clone();
        let pick = Pick::Project(key.clone());
        projects = projects.child(
            ui::row(t, SharedString::from(format!("p-{}-{}", key.0, key.1)), open)
                .child(div().w(px(6.)).flex_none().when(unread, |d| d.child(ui::unread(t))))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .when(n > 0, |d| d.font_weight(STRONG))
                        .when(n == 0 && !unread && !open, |d| d.text_color(t.quiet))
                        .child(row.summary.title.clone()),
                )
                .when(stalled, |d| d.child(ui::dot(t.warning)))
                .when(n > 0, |d| d.child(ui::count(t, n, true)))
                .on_click(move |_, window, cx| on_pick(pick.clone(), window, cx)),
        );
        if open {
            for thread in row.outcome.iter().flat_map(|o| o.threads.iter()) {
                let color = match thread.status {
                    ThreadStatus::Running => t.success,
                    ThreadStatus::Waiting => t.warning,
                    ThreadStatus::Failed => t.danger,
                    _ => t.faint,
                };
                projects = projects.child(
                    div()
                        .h(px(metric::ROW - 4.))
                        .pl(px(26.))
                        .pr_4()
                        .flex()
                        .items_center()
                        .gap_2()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .child(ui::dot(color))
                        .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(thread.title.clone())),
                );
            }
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
                .flex()
                .flex_col()
                .child(entry("nav-inbox", "Inbox", Pick::Inbox, *active == Active::Inbox, inbox_count))
                .child(entry("nav-machines", "Machines", Pick::Machines, *active == Active::Machines, machines_note)),
        )
        .child(
            ui::clickable(t, div().id("nav-projects"))
                .px_4()
                .pt_4()
                .pb_1()
                .flex()
                .items_center()
                .text_size(px(size::XS))
                .font_weight(STRONG)
                .text_color(if *active == Active::Projects { t.text } else { t.quiet })
                .hover(|s| s.opacity(0.8))
                .on_click({
                    let on_pick = on_pick.clone();
                    move |_, window, cx| on_pick(Pick::Projects, window, cx)
                })
                .child("Projects"),
        )
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
    fn needs_you_counts_open_asks_per_project() {
        let state = crate::fake::fixture_state();
        let needs = needs_you(&state);
        // The fixture's three open asks are on its first three projects, one each.
        assert_eq!(needs.values().sum::<usize>(), 3);
        assert_eq!(needs.get(&("forge".to_string(), "fleetd".to_string())), Some(&1));
    }

    #[test]
    fn projects_are_read_on_first_sight_and_unread_after_new_activity() {
        let mut state = crate::fake::fixture_state();
        let mut seen = Seen::default();
        seen.prime(&state);
        let key = state.projects[0].key();
        let at = state.projects[0].summary.last_activity_at.to_string();
        assert!(!seen.unread(&key, &at));
        assert!(seen.unread(&key, "2026-10-17T10:05:00.000Z"));
        seen.mark(&key, "2026-10-17T10:05:00.000Z");
        assert!(!seen.unread(&key, "2026-10-17T10:05:00.000Z"));
        // Priming again after a refresh doesn't overwrite what you have (not) seen.
        state.projects[0].summary.last_activity_at = serde_json::from_value(serde_json::json!("2026-10-17T11:00:00.000Z")).unwrap();
        seen.prime(&state);
        assert!(seen.unread(&key, "2026-10-17T11:00:00.000Z"));
    }
}
