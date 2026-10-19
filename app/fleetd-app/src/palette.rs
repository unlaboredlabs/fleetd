//! The command palette (⌘K / Ctrl+K): one field that reaches every order (by its id, `W14`), project, open ask
//! and action. Typing filters by a forgiving subsequence match ("dn" finds "desktop-notify"); Up/Down or the mouse
//! pick, Enter or a click runs, Esc or a click outside closes. Whatever you type can also become a new order: the
//! last row is always "New order: <text>".

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
    Board,
    Inbox,
    Machines,
    Project(ProjectKey),
    Order(String),
    /// Opens the inbox at this ask.
    Ask(String),
    /// Opens the composer, aimed at a project or (None) letting the hub route it.
    NewOrder(Option<ProjectKey>),
    /// Opens the composer with this text in it.
    NewOrderText(String),
    ToggleGroup,
    /// The time inspector: an order's timeline, or the fleet's breakdown.
    Time(Option<String>),
    /// The Status view: the fleet's, or an order's.
    Status(Option<String>),
    Settings,
    /// Back to the connect screen, to pair with another hub.
    Connect,
    /// The Add project sheet.
    AddProject,
    /// Focuses the open order's steer composer.
    SteerLead,
    /// Opens one agent's steer box (its lane id), or (None) lists the open order's agents to pick one.
    SteerAgent(Option<String>),
    /// Withdraws a queued steer.
    Withdraw(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Group {
    /// Open asks come first: they are why you opened the app.
    Ask,
    Order,
    Action,
    Project,
}

impl Group {
    fn label(self) -> &'static str {
        match self {
            Group::Ask => "Needs you",
            Group::Order => "Orders",
            Group::Action => "Actions",
            Group::Project => "Projects",
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
    for row in &state.projects {
        for card in state.live.orders(&row.key()) {
            out.push(item(
                Group::Order,
                format!("{} {}", card.workstream_id, card.title),
                format!(
                    "{} · {}",
                    row.summary.title,
                    card.phase_detail.as_deref().map_or_else(|| label(&card.phase).replace('_', " "), str::to_string)
                ),
                None,
                Command::Order(card.workstream_id.to_string()),
            ));
        }
    }
    out.extend([
        item(Group::Action, "New order…", "Tell the fleet what to do", Some(ui::shortcut("N")), Command::NewOrder(None)),
        item(Group::Action, "Board", "Every open order", Some(ui::shortcut("0")), Command::Board),
        item(Group::Action, "Inbox", "What needs you", Some(ui::shortcut("I")), Command::Inbox),
        item(Group::Action, "Group by project or status", "Regroup the board", Some(ui::shortcut("⇧G")), Command::ToggleGroup),
        item(Group::Action, "Add project…", "Clone a GitHub repo or add a folder on one of your machines", None, Command::AddProject),
        item(Group::Action, "Machines", "Machines and setup checks", None, Command::Machines),
        item(Group::Action, "Time", "Where the fleet's agent time went", None, Command::Time(None)),
        item(Group::Action, "Status", "How far the fleet is, verified, and what is in its way", Some(ui::shortcut(".")), Command::Status(None)),
        item(Group::Action, "Settings", "Appearance, motion and hub connection", Some(ui::shortcut(",")), Command::Settings),
        item(Group::Action, "Connect to a hub…", "Pair this app with a fleetd hub", None, Command::Connect),
    ]);
    if let Some(order) = &state.order {
        let w = order.workstream_id.clone();
        out.push(item(
            Group::Action,
            format!("Time for {w}"),
            "Its timeline: what each agent did and waited on",
            None,
            Command::Time(Some(w.clone())),
        ));
        out.push(item(Group::Action, format!("Status for {w}"), "Its verified progress and what it waits on", None, Command::Status(Some(w))));
        // Steering: every steer is aimed at one of the open order's agents.
        let w = order.workstream_id.as_str();
        out.push(item(
            Group::Action,
            "Steer the lead",
            format!("Enter queues for its next step · {} interrupts", ui::shortcut("Enter")),
            None,
            Command::SteerLead,
        ));
        out.push(item(Group::Action, "Steer an agent…", format!("Pick one of {w}'s agents"), None, Command::SteerAgent(None)));
        for lane in state.live.lanes(&fleetd_contracts::ledger::WorkstreamId::unchecked(w)) {
            if lane.role == fleetd_contracts::live::AgentRole::Lead || crate::live::state::is_final(lane.status) {
                continue;
            }
            let Some(task) = lane.task_id.as_ref() else { continue };
            let doing = crate::live::activity::describe(&lane);
            let doing = doing.machine.map_or(doing.words.clone(), |m| format!("{} {m}", doing.words));
            let role = crate::steer::sheet::role_label(lane.role);
            out.push(item(
                Group::Action,
                format!("Steer {task}"),
                format!("{role} · {doing}"),
                None,
                Command::SteerAgent(Some(lane.lane_id.to_string())),
            ));
        }
        for s in state.steers.iter().filter(|s| crate::steer::receipts::can_withdraw(s)) {
            let to = crate::steer::task_of(&s.target).unwrap_or("the lead");
            out.push(item(
                Group::Action,
                format!("Withdraw {}", s.id),
                format!("to {to}: {}", crate::shell::clip(&s.text, 60)),
                None,
                Command::Withdraw(s.id.to_string()),
            ));
        }
    }
    for row in &state.projects {
        let key = row.key();
        out.push(item(Group::Project, row.summary.title.clone(), row.summary.machine_id.to_string(), None, Command::Project(key.clone())));
        out.push(item(Group::Action, format!("New order in {}", row.summary.title), "", None, Command::NewOrder(Some(key.clone()))));
    }
    out
}

/// The items to show for `query`, best first. An empty query shows everything except the per-project
/// "New order in …" shortcuts, grouped.
pub fn rank(query: &str, items: &[Item]) -> Vec<usize> {
    let query = query.trim();
    if query.is_empty() {
        let mut all: Vec<usize> =
            (0..items.len()).filter(|&i| !matches!(items[i].command, Command::NewOrder(Some(_)) | Command::SteerAgent(Some(_)))).collect();
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
    /// The typed text, offered as "New order: …" in the last row.
    typed: String,
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
        let input = cx.new(|cx| TextInput::new(cx).placeholder("Search orders, projects, asks and actions, or type a new order").borderless());
        window.focus(&input.focus_handle(cx), cx);
        let sub = cx.subscribe(&input, |this, input, event: &InputEvent, cx| match event {
            InputEvent::Changed => {
                this.typed = input.read(cx).text().trim().to_string();
                this.matches = rank(&this.typed, &this.items);
                this.selected = 0;
                this.scroll.scroll_to_item(0, ScrollStrategy::Top);
                cx.notify();
            }
            InputEvent::Submit => this.run(this.selected, cx),
            InputEvent::Cancel => cx.emit(PaletteEvent::Dismiss),
            InputEvent::TooLong => {}
        });
        let matches = rank("", &items);
        Self { input, items, matches, typed: String::new(), selected: 0, scroll: UniformListScrollHandle::new(), _sub: sub }
    }

    /// Starts with `text` typed, e.g. "Steer " to list the agents.
    pub fn set_query(&mut self, text: &str, cx: &mut Context<Self>) {
        self.input.update(cx, |i, cx| i.set_text(text, cx));
    }

    /// Rows: the matches, then "New order: <text>" once something is typed.
    fn len(&self) -> usize {
        self.matches.len() + usize::from(!self.typed.is_empty())
    }

    fn run(&mut self, ix: usize, cx: &mut Context<Self>) {
        if let Some(item) = self.matches.get(ix).and_then(|&i| self.items.get(i)) {
            cx.emit(PaletteEvent::Run(item.command.clone()));
        } else if ix == self.matches.len() && !self.typed.is_empty() {
            cx.emit(PaletteEvent::Run(Command::NewOrderText(self.typed.clone())));
        }
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        if self.len() == 0 {
            return;
        }
        self.selected = (self.selected as isize + by).rem_euclid(self.len() as isize) as usize;
        self.scroll.scroll_to_item(self.selected, ScrollStrategy::Nearest);
        cx.notify();
    }

    fn row(&self, ix: usize, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let t = theme(cx);
        if ix == self.matches.len() {
            return ui::row(t, ix, ix == self.selected)
                .child(div().w(px(76.)).flex_none().text_size(px(size::XS)).text_color(t.quiet).child("New order"))
                .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().child(format!("New order: {}", self.typed)))
                .child(ui::kbd(t, "Enter"))
                .on_click(cx.listener(move |this, _, _, cx| this.run(ix, cx)));
        }
        let it = &self.items[self.matches[ix]];
        let first_of_group = ix == 0 || self.items[self.matches[ix - 1]].group != it.group;
        let ask = it.group == Group::Ask;
        ui::row(t, ix, ix == self.selected)
            .child(div().w(px(76.)).flex_none().text_size(px(size::XS)).text_color(t.quiet).child(if first_of_group { it.group.label() } else { "" }))
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
        let list_h = metric::ROW * self.len().clamp(1, VISIBLE_ROWS) as f32 + 8.;
        let body = if self.len() == 0 {
            div().h(px(list_h)).px_4().flex().items_center().text_color(t.quiet).child("Nothing matches.").into_any_element()
        } else {
            uniform_list(
                "palette",
                self.len(),
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
        assert!(score("frt", "fleet-infra").is_none(), "no t after the r in fleet-infra");
        assert!(score("fi", "fleet-infra").is_some());
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
            it(Group::Order, "W14 Harden lead digest", Command::Order("W14".into())),
        ];
        assert_eq!(rank("", &items), vec![3, 4, 0, 1]);
        assert_eq!(rank("w14", &items), vec![4], "orders are found by their id");
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
