//! The command palette (⌘K / Ctrl+K): one field that reaches every project, thread, open ask and action.
//! Typing filters by a forgiving subsequence match ("dn" finds "desktop-notify"); Up/Down or the mouse pick,
//! Enter or a click runs, Esc or a click outside closes.

use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding, ScrollStrategy, SharedString, Subscription, UniformListScrollHandle,
    Window, actions, div, prelude::*, px, uniform_list,
};

use crate::input::{InputEvent, TextInput};
use crate::state::{ProjectKey, State};
use crate::theme::{STRONG, metric, size, theme};
use crate::ui;

actions!(palette, [SelectPrev, SelectNext]);

const CONTEXT: &str = "Palette";
const VISIBLE_ROWS: usize = 9;

/// Up/Down move the selection instead of the field's caret. Call after `input::bind_keys`: for the same
/// keys at the same depth, the binding added later wins.
pub fn bind_keys(cx: &mut App) {
    let ctx = Some("Palette > TextInput");
    cx.bind_keys([
        KeyBinding::new("up", SelectPrev, ctx),
        KeyBinding::new("down", SelectNext, ctx),
        KeyBinding::new("ctrl-p", SelectPrev, ctx),
        KeyBinding::new("ctrl-n", SelectNext, ctx),
    ]);
}

/// What running an item does; the shell carries it out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Inbox,
    Projects,
    Machines,
    Project(ProjectKey),
    /// Opens the inbox at this ask.
    Ask(String),
    /// Opens the composer, aimed at a project or (None) letting the hub route it.
    NewOrder(Option<ProjectKey>),
    Settings,
    /// Back to the connect screen, to pair with another hub.
    Connect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Group {
    /// Open asks come first: they are why you opened the app.
    Ask,
    Action,
    Project,
    Thread,
}

impl Group {
    fn label(self) -> &'static str {
        match self {
            Group::Ask => "Needs you",
            Group::Action => "Actions",
            Group::Project => "Projects",
            Group::Thread => "Threads",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Item {
    pub group: Group,
    pub title: SharedString,
    pub detail: SharedString,
    pub keys: Option<String>,
    pub command: Command,
}

fn item(group: Group, title: impl Into<SharedString>, detail: impl Into<SharedString>, keys: Option<String>, command: Command) -> Item {
    Item { group, title: title.into(), detail: detail.into(), keys, command }
}

/// Everything the palette can reach right now.
pub fn items(state: &State) -> Vec<Item> {
    let mut out = Vec::new();
    for entry in state.inbox() {
        let project = entry.ask.project_ref.as_ref().map_or("no project yet".to_string(), |p| p.project_id.to_string());
        out.push(item(
            Group::Ask,
            entry.ask.text.to_string(),
            format!("{} · {project}", label(&entry.ask.class)),
            None,
            Command::Ask(entry.ask.ask_id.to_string()),
        ));
    }
    out.extend([
        item(Group::Action, "New order…", "Send a one-line order to a project", Some(ui::shortcut("N")), Command::NewOrder(None)),
        item(Group::Action, "Inbox", "What needs you", Some(ui::shortcut("1")), Command::Inbox),
        item(Group::Action, "Projects", "Every project and its lead", Some(ui::shortcut("2")), Command::Projects),
        item(Group::Action, "Machines", "Machines and setup checks", Some(ui::shortcut("3")), Command::Machines),
        item(Group::Action, "Settings", "Appearance and hub connection", Some(ui::shortcut(",")), Command::Settings),
        item(Group::Action, "Connect to a hub…", "Pair this app with a fleetd hub", None, Command::Connect),
    ]);
    for row in &state.projects {
        let key = row.key();
        out.push(item(Group::Project, row.summary.title.clone(), row.summary.machine_id.to_string(), None, Command::Project(key.clone())));
        out.push(item(Group::Action, format!("New order in {}", row.summary.title), "", None, Command::NewOrder(Some(key.clone()))));
        for thread in row.outcome.iter().flat_map(|o| o.threads.iter()) {
            out.push(item(
                Group::Thread,
                thread.title.clone(),
                format!("{} · {}", row.summary.title, label(&thread.status)),
                None,
                Command::Project(key.clone()),
            ));
        }
    }
    out
}

/// The items to show for `query`, best first. An empty query shows everything except the per-project
/// "New order in …" shortcuts, grouped.
pub fn rank(query: &str, items: &[Item]) -> Vec<usize> {
    let query = query.trim();
    if query.is_empty() {
        let mut all: Vec<usize> = (0..items.len()).filter(|&i| !matches!(items[i].command, Command::NewOrder(Some(_)))).collect();
        all.sort_by_key(|&i| items[i].group);
        return all;
    }
    // Letters scattered mid-word ("dn" in "New order in fleetd") are noise, not a match.
    let floor = 2 * query.chars().filter(|c| !c.is_whitespace()).count() as i32;
    let mut scored: Vec<(i32, usize)> = items
        .iter()
        .enumerate()
        .filter_map(|(i, it)| {
            let title = score(query, &it.title);
            let detail = score(query, &it.detail).map(|s| s / 2);
            title.max(detail).filter(|&s| s >= floor).map(|s| (s, i))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(items[a.1].group.cmp(&items[b.1].group)).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, i)| i).collect()
}

/// Case-insensitive subsequence match. Higher is better: consecutive letters, letters at word starts and a
/// match at the very start all score; gaps cost. None when some query letter is missing.
pub fn score(query: &str, text: &str) -> Option<i32> {
    let text: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let mut score = 0;
    let mut at = 0;
    let mut prev: Option<usize> = None;
    for q in query.chars().flat_map(char::to_lowercase).filter(|c| !c.is_whitespace()) {
        let found = (at..text.len()).find(|&i| text[i] == q)?;
        let word_start = found == 0 || !text[found - 1].is_alphanumeric();
        score += 1;
        if word_start {
            score += 8;
        }
        match prev {
            Some(p) if p + 1 == found => score += 6,
            Some(p) => score -= (found - p - 1).min(6) as i32,
            None if found == 0 => score += 10,
            None => {}
        }
        prev = Some(found);
        at = found + 1;
    }
    Some(score)
}

pub enum PaletteEvent {
    Run(Command),
    Dismiss,
}

pub struct Palette {
    input: Entity<TextInput>,
    items: Vec<Item>,
    matches: Vec<usize>,
    selected: usize,
    scroll: UniformListScrollHandle,
    _sub: Subscription,
}

impl EventEmitter<PaletteEvent> for Palette {}

impl Focusable for Palette {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Palette {
    pub fn new(items: Vec<Item>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextInput::new(cx).placeholder("Search projects, threads, asks and actions").borderless());
        window.focus(&input.focus_handle(cx), cx);
        let sub = cx.subscribe(&input, |this, input, event: &InputEvent, cx| match event {
            InputEvent::Changed => {
                this.matches = rank(input.read(cx).text(), &this.items);
                this.selected = 0;
                this.scroll.scroll_to_item(0, ScrollStrategy::Top);
                cx.notify();
            }
            InputEvent::Submit => this.run(this.selected, cx),
            InputEvent::Cancel => cx.emit(PaletteEvent::Dismiss),
            InputEvent::TooLong => {}
        });
        let matches = rank("", &items);
        Self { input, items, matches, selected: 0, scroll: UniformListScrollHandle::new(), _sub: sub }
    }

    fn run(&mut self, ix: usize, cx: &mut Context<Self>) {
        if let Some(item) = self.matches.get(ix).and_then(|&i| self.items.get(i)) {
            cx.emit(PaletteEvent::Run(item.command.clone()));
        }
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        if self.matches.is_empty() {
            return;
        }
        self.selected = (self.selected as isize + by).rem_euclid(self.matches.len() as isize) as usize;
        self.scroll.scroll_to_item(self.selected, ScrollStrategy::Nearest);
        cx.notify();
    }

    fn row(&self, ix: usize, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let t = theme(cx);
        let it = &self.items[self.matches[ix]];
        let first_of_group = ix == 0 || self.items[self.matches[ix - 1]].group != it.group;
        let ask = it.group == Group::Ask;
        ui::row(t, ix, ix == self.selected)
            .child(div().w(px(76.)).flex_none().text_size(px(size::XS)).text_color(t.faint).child(if first_of_group { it.group.label() } else { "" }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_baseline()
                    .gap_2()
                    .overflow_hidden()
                    .child(
                        div()
                            .flex_none()
                            .max_w(px(440.))
                            .overflow_hidden()
                            .text_ellipsis()
                            .when(ask, |d| d.font_weight(STRONG))
                            .child(it.title.clone()),
                    )
                    .child(div().min_w_0().overflow_hidden().text_ellipsis().text_size(px(size::XS)).text_color(t.quiet).child(it.detail.clone())),
            )
            .when_some(it.keys.clone(), |d, keys| d.child(ui::kbd(t, keys)))
            .on_click(cx.listener(move |this, _, _, cx| this.run(ix, cx)))
    }
}

impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme(cx);
        let list_h = metric::ROW * self.matches.len().clamp(1, VISIBLE_ROWS) as f32 + 8.;
        let body = if self.matches.is_empty() {
            div().h(px(list_h)).px_4().flex().items_center().text_color(t.quiet).child("Nothing matches.").into_any_element()
        } else {
            uniform_list(
                "palette",
                self.matches.len(),
                cx.processor(|this, range: std::ops::Range<usize>, _, cx| range.map(|ix| this.row(ix, cx)).collect::<Vec<_>>()),
            )
            .track_scroll(&self.scroll)
            .h(px(list_h))
            .p_1()
            .into_any_element()
        };
        ui::floating(t)
            .key_context(CONTEXT)
            .on_action(cx.listener(|this, _: &SelectPrev, _, cx| this.step(-1, cx)))
            .on_action(cx.listener(|this, _: &SelectNext, _, cx| this.step(1, cx)))
            .w(px(640.))
            .flex()
            .flex_col()
            .text_size(px(size::MD))
            .text_color(t.text)
            .child(div().h(px(metric::BAR + 4.)).px_2().flex().items_center().border_b_1().border_color(t.hairline).child(self.input.clone()))
            .child(body)
    }
}

/// A contract enum's wire value, e.g. "irreversible".
fn label<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        _ => "?".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subsequence_matches_and_prefers_word_starts_and_runs() {
        assert!(score("frt", "forge-infra").is_none(), "t is not in forge-infra");
        assert!(score("fi", "forge-infra").is_some());
        assert!(score("xyz", "fleetd").is_none());
        // A run at the start beats the same letters scattered.
        assert!(score("fle", "fleetd").unwrap() > score("fle", "forge-lead-e").unwrap());
        // Word starts beat letters mid-word.
        assert!(score("dn", "desktop-notify").unwrap() > score("dn", "addon").unwrap());
        assert_eq!(score("FLEET", "fleetd"), score("fleet", "fleetd"));
    }

    fn it(group: Group, title: &str, command: Command) -> Item {
        item(group, title, "", None, command)
    }

    #[test]
    fn empty_query_groups_asks_first_and_hides_per_project_orders() {
        let p = ("forge".to_string(), "fleetd".to_string());
        let items = vec![
            it(Group::Action, "Inbox", Command::Inbox),
            it(Group::Project, "fleetd", Command::Project(p.clone())),
            it(Group::Action, "New order in fleetd", Command::NewOrder(Some(p))),
            it(Group::Ask, "Delete the bucket?", Command::Ask("A1".into())),
        ];
        assert_eq!(rank("", &items), vec![3, 0, 1]);
    }

    #[test]
    fn typed_query_ranks_by_score_then_group() {
        let p = ("forge".to_string(), "fleetd".to_string());
        let items = vec![
            it(Group::Action, "Settings", Command::Settings),
            it(Group::Action, "New order in fleetd", Command::NewOrder(Some(p.clone()))),
            it(Group::Project, "fleetd", Command::Project(p)),
        ];
        let ranked = rank("fleetd", &items);
        assert_eq!(ranked[0], 2, "the exact project name wins");
        assert!(ranked.contains(&1));
        assert!(!ranked.contains(&0));
        // Scattered mid-word letters don't count as a match.
        assert!(rank("dn", &items).is_empty());
    }
}
