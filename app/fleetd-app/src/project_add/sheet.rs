//! The Add project sheet: one field (paste a GitHub URL, type a folder's path, or filter), the repos the hub found,
//! the machine it goes to, then the clone's progress, the ready state with what the lead will need, or the error and
//! its fix. Up/Down or the mouse pick, Enter or a click adds, Esc or a click outside closes (a clone carries on).

use std::path::PathBuf;

use fleetd_contracts::projects::{AddSource, add_source};
use gpui::{
    App, Context, Div, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding, PathPromptOptions, ScrollStrategy, SharedString, Stateful,
    Subscription, UniformListScrollHandle, Window, actions, div, prelude::*, px, relative, uniform_list,
};

use super::{Discovery, FailAction, Failure, Found, FoundKind, Ready, Request, Step, Update, Worker, other_host, tilde};
use crate::input::{InputEvent, TextInput};
use crate::state::ProjectKey;
use crate::theme::{STRONG, Theme, metric, radius, size, theme};
use crate::ui::{self, Variant};

actions!(project_add, [SelectPrev, SelectNext]);

const CONTEXT: &str = "AddProject";
const WIDTH: f32 = 640.;
const VISIBLE_ROWS: usize = 8;

/// Up/Down move the selection instead of the caret. Call after `input::bind_keys`.
pub fn bind_keys(cx: &mut App) {
    let ctx = Some("AddProject > TextInput");
    cx.bind_keys([
        KeyBinding::new("up", SelectPrev, ctx),
        KeyBinding::new("down", SelectNext, ctx),
        KeyBinding::new("ctrl-p", SelectPrev, ctx),
        KeyBinding::new("ctrl-n", SelectNext, ctx),
    ]);
}

pub enum AddEvent {
    Start(Request),
    Open(ProjectKey),
    Dismiss,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    /// "acme/storefront", or a folder's name.
    pub what: String,
    pub machine: String,
    pub path: String,
    pub clone: bool,
    pub step: Step,
    pub detail: String,
    pub fraction: Option<f32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Pick,
    Working(Job),
    Ready(Ready),
    Failed { what: String, failure: Failure },
}

#[derive(Clone, Debug, PartialEq)]
enum Row {
    /// A pasted GitHub repo, "owner/repo".
    Clone(String),
    /// A typed or dropped folder path.
    Folder(String),
    Found(usize),
}

/// What Enter or the primary button does for the selected row.
enum Plan {
    Clone { repo: String },
    Folder { machine_id: String, path: String, fixed: bool },
    Open(ProjectKey),
    Nothing,
}

pub struct AddSheet {
    input: Entity<TextInput>,
    /// None while the hub is looking.
    discovery: Option<Discovery>,
    pub phase: Phase,
    rows: Vec<Row>,
    selected: usize,
    /// The machine picked for a clone or a typed path; None: the hub's suggestion.
    machine: Option<String>,
    /// This computer's machine id, when it is one of the workers: Browse… and dropped folders use it.
    local: Option<String>,
    /// Said under the field, e.g. why a dropped folder will be cloned instead; true when it's a problem.
    note: Option<(String, bool)>,
    copied: bool,
    scroll: UniformListScrollHandle,
    _sub: Subscription,
}

impl EventEmitter<AddEvent> for AddSheet {}

impl Focusable for AddSheet {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl AddSheet {
    pub fn new(local: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextInput::new(cx).placeholder("Paste a GitHub URL, type a folder's path, or filter the list").borderless());
        window.focus(&input.focus_handle(cx), cx);
        let sub = cx.subscribe(&input, |this, _, event: &InputEvent, cx| match event {
            InputEvent::Changed => {
                this.note = None;
                this.refilter(cx);
            }
            InputEvent::Submit => this.submit(cx),
            InputEvent::Cancel => cx.emit(AddEvent::Dismiss),
            InputEvent::TooLong => {}
        });
        Self {
            input,
            discovery: None,
            phase: Phase::Pick,
            rows: Vec::new(),
            selected: 0,
            machine: None,
            local,
            note: None,
            copied: false,
            scroll: UniformListScrollHandle::new(),
            _sub: sub,
        }
    }

    pub fn working(&self) -> bool {
        matches!(self.phase, Phase::Working(_))
    }

    /// Fills the field (a pasted or dropped URL or path) with a line on where it came from.
    pub fn prefill(&mut self, text: &str, note: Option<(String, bool)>, cx: &mut Context<Self>) {
        self.input.update(cx, |i, cx| i.set_text(text, cx));
        if let (Some(local), Some(AddSource::Path(_))) = (&self.local, add_source(text)) {
            self.machine = Some(local.clone());
        }
        self.refilter(cx);
        self.note = note;
        cx.notify();
    }

    pub fn apply(&mut self, update: Update, cx: &mut Context<Self>) {
        match update {
            Update::Discovered(d) => {
                self.discovery = Some(d);
                self.refilter(cx);
            }
            Update::Progress { step, detail, fraction } => {
                if let Phase::Working(job) = &mut self.phase {
                    job.step = step;
                    job.detail = detail;
                    job.fraction = fraction;
                }
            }
            Update::Waiting(why) => {
                if let Phase::Working(job) = &mut self.phase {
                    job.detail = why;
                    job.fraction = None;
                }
            }
            Update::Ready(r) => self.phase = Phase::Ready(r),
            Update::Failed(failure) => {
                let what = match &self.phase {
                    Phase::Working(job) => job.what.clone(),
                    _ => self.input.read(cx).text().trim().to_string(),
                };
                self.copied = false;
                self.phase = Phase::Failed { what, failure };
            }
        }
        cx.notify();
    }

    fn workers(&self) -> &[Worker] {
        self.discovery.as_ref().map_or(&[], |d| d.workers.as_slice())
    }

    fn worker(&self, machine_id: &str) -> Option<&Worker> {
        self.workers().iter().find(|w| w.machine_id == machine_id)
    }

    fn machine_name(&self, machine_id: &str) -> String {
        self.worker(machine_id).map_or_else(|| machine_id.to_string(), |w| w.name.clone())
    }

    /// The machine a clone or a typed path goes to: the one picked, else the hub's suggestion, else the first online.
    fn target(&self) -> Option<&Worker> {
        let d = self.discovery.as_ref()?;
        let pick = self.machine.as_deref().or(d.best.as_deref());
        pick.and_then(|id| self.worker(id)).filter(|w| w.online).or_else(|| d.workers.iter().find(|w| w.online))
    }

    fn refilter(&mut self, cx: &mut Context<Self>) {
        let text = self.input.read(cx).text().trim().to_string();
        let found = self.discovery.as_ref().map_or(&[][..], |d| d.found.as_slice());
        let mut rows = Vec::new();
        match add_source(&text) {
            Some(AddSource::GitHub(repo)) => {
                let repo = repo.to_string();
                // What's already here of it: its checkouts and whether it's a project.
                let same = |f: &Found| f.name.eq_ignore_ascii_case(&repo) || f.detail.eq_ignore_ascii_case(&repo);
                rows.push(Row::Clone(repo.clone()));
                rows.extend(found.iter().enumerate().filter(|(_, f)| same(f)).map(|(i, _)| Row::Found(i)));
            }
            Some(AddSource::Path(path)) => rows.push(Row::Folder(path)),
            None if text.is_empty() => rows.extend((0..found.len()).map(Row::Found)),
            None => {
                let mut scored: Vec<(i32, usize)> = found
                    .iter()
                    .enumerate()
                    .filter_map(|(i, f)| {
                        let s = crate::palette::score(&text, &f.name).max(crate::palette::score(&text, &f.detail).map(|s| s / 2));
                        s.filter(|&s| s >= 2 * text.chars().filter(|c| !c.is_whitespace()).count() as i32).map(|s| (s, i))
                    })
                    .collect();
                scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
                rows.extend(scored.into_iter().map(|(_, i)| Row::Found(i)));
            }
        }
        // A pasted repo that is already a project starts on that project (Enter opens it, not a second clone);
        // otherwise start on something that adds, not on a row that is already a project.
        let is_project = |r: &Row| matches!(r, Row::Found(i) if found[*i].project.is_some());
        let pasted_project = matches!(rows.first(), Some(Row::Clone(_)))
            .then(|| rows.iter().position(|r| matches!(r, Row::Found(i) if found[*i].project.is_some() && found[*i].kind == FoundKind::GitHub)))
            .flatten();
        self.selected = pasted_project.or_else(|| rows.iter().position(|r| !is_project(r))).unwrap_or(0);
        self.rows = rows;
        self.scroll.scroll_to_item(self.selected, ScrollStrategy::Nearest);
        cx.notify();
    }

    fn plan(&self) -> Plan {
        let Some(row) = self.rows.get(self.selected) else { return Plan::Nothing };
        match row {
            Row::Clone(repo) => Plan::Clone { repo: repo.clone() },
            Row::Folder(path) => match self.target() {
                Some(w) => Plan::Folder { machine_id: w.machine_id.clone(), path: path.clone(), fixed: false },
                None => Plan::Nothing,
            },
            Row::Found(i) => {
                let Some(f) = self.discovery.as_ref().and_then(|d| d.found.get(*i)) else { return Plan::Nothing };
                match (&f.project, &f.kind) {
                    (Some(key), _) => Plan::Open(key.clone()),
                    (None, FoundKind::Checkout { machine_id, path }) => {
                        Plan::Folder { machine_id: machine_id.clone(), path: path.clone(), fixed: true }
                    }
                    (None, FoundKind::GitHub) => Plan::Clone { repo: f.name.clone() },
                }
            }
        }
    }

    pub(crate) fn submit(&mut self, cx: &mut Context<Self>) {
        if self.phase != Phase::Pick {
            return;
        }
        let request = match self.plan() {
            Plan::Open(key) => return cx.emit(AddEvent::Open(key)),
            Plan::Nothing => return,
            Plan::Clone { repo } => match self.target() {
                Some(w) => Request::Clone { repo, machine_id: w.machine_id.clone(), use_existing: false },
                None => return,
            },
            Plan::Folder { machine_id, path, .. } => Request::Folder { machine_id, path },
        };
        self.start(request, cx);
    }

    fn start(&mut self, request: Request, cx: &mut Context<Self>) {
        let machine = self.machine_name(request.machine_id());
        let job = match &request {
            Request::Clone { repo, machine_id, .. } => Job {
                what: repo.clone(),
                path: self.clone_path(machine_id, repo).unwrap_or_default(),
                machine,
                clone: true,
                step: Step::Clone,
                detail: "Asking the hub".into(),
                fraction: None,
            },
            Request::Folder { path, .. } => Job {
                what: path.rsplit('/').next().unwrap_or(path).to_string(),
                path: path.clone(),
                machine,
                clone: false,
                step: Step::Inspect,
                detail: "Reading the default branch, CI and merge rules".into(),
                fraction: None,
            },
        };
        self.phase = Phase::Working(job);
        cx.emit(AddEvent::Start(request));
        cx.notify();
    }

    fn clone_path(&self, machine_id: &str, repo: &str) -> Option<String> {
        let root = self.worker(machine_id)?.clone_root.as_deref()?;
        Some(format!("{}/{}", root.trim_end_matches('/'), repo.rsplit('/').next().unwrap_or(repo)))
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        if self.rows.is_empty() {
            return;
        }
        self.selected = (self.selected as isize + by).rem_euclid(self.rows.len() as isize) as usize;
        self.scroll.scroll_to_item(self.selected, ScrollStrategy::Nearest);
        cx.notify();
    }

    fn back(&mut self, cx: &mut Context<Self>) {
        self.phase = Phase::Pick;
        cx.notify();
    }

    fn browse(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Add".into()) });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await
                && let Some(path) = paths.into_iter().next()
            {
                this.update(cx, |this, cx| this.prefill(&path.to_string_lossy(), None, cx)).ok();
            }
        })
        .detach();
    }

    /// A folder or link dropped on the window: a folder on this computer is added as it is when this computer is a
    /// worker, else cloned from its GitHub origin.
    pub fn dropped(&mut self, path: PathBuf, origin: Option<String>, link: Option<String>, cx: &mut Context<Self>) {
        let shown = path.to_string_lossy().to_string();
        if let Some(url) = link {
            return self.prefill(
                &url,
                Some((format!("From {}.", path.file_name().map_or(shown.clone(), |n| n.to_string_lossy().to_string())), false)),
                cx,
            );
        }
        if let Some(local) = self.local.clone() {
            let name = self.machine_name(&local);
            return self.prefill(&shown, Some((format!("A folder on this computer, which is {name}."), false)), cx);
        }
        match origin.as_deref().and_then(fleetd_contracts::projects::github_repo) {
            Some(repo) => self.prefill(
                repo.as_ref(),
                Some((format!("This computer isn't one of your machines, so the fleet clones {repo} from GitHub instead."), false)),
                cx,
            ),
            None => {
                self.prefill("", None, cx);
                self.note = Some((
                    format!(
                        "{} is on this computer, which isn't one of your machines, and it has no GitHub remote. Push it to GitHub and paste its URL, or add this computer with fleetd machine add.",
                        tilde(&shown)
                    ),
                    true,
                ));
            }
        }
    }

    // ---- render ---------------------------------------------------------------------------

    fn header(&self, t: &Theme, title: String, close: &'static str, cx: &mut Context<Self>) -> Div {
        div()
            .flex_none()
            .h(px(metric::BAR))
            .pl_4()
            .pr_2()
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(t.hairline)
            .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().font_weight(STRONG).child(title))
            .child(ui::button(t, "add-close", close, Variant::Ghost, true).on_click(cx.listener(|_, _, _, cx| cx.emit(AddEvent::Dismiss))))
    }

    fn row(&self, ix: usize, cx: &mut Context<Self>) -> Stateful<Div> {
        let t = theme(cx);
        let found = self.discovery.as_ref().map_or(&[][..], |d| d.found.as_slice());
        let group = |r: &Row| -> String {
            match r {
                Row::Clone(_) => "Paste".into(),
                Row::Folder(_) => "Folder".into(),
                Row::Found(i) => match &found[*i].kind {
                    FoundKind::Checkout { machine_id, .. } => self.machine_name(machine_id),
                    FoundKind::GitHub => "GitHub".into(),
                },
            }
        };
        let label = group(&self.rows[ix]);
        let first = ix == 0 || group(&self.rows[ix - 1]) != label;
        let (title, middle, right, added) = match &self.rows[ix] {
            Row::Clone(repo) => (format!("Clone {repo}"), "from GitHub".to_string(), String::new(), false),
            Row::Folder(path) => {
                let on = self.target().map_or_else(|| "no machine online".into(), |w| format!("a folder on {}", w.name));
                (path.clone(), on, String::new(), false)
            }
            Row::Found(i) => {
                let f = &found[*i];
                let middle = match &f.kind {
                    FoundKind::Checkout { path, .. } => tilde(path),
                    FoundKind::GitHub if f.private => "private".into(),
                    FoundKind::GitHub => String::new(),
                };
                (f.name.clone(), middle, f.detail.clone(), f.project.is_some())
            }
        };
        let mono = matches!(&self.rows[ix], Row::Folder(_) | Row::Found(_))
            && !matches!(&self.rows[ix], Row::Found(i) if found[*i].kind == FoundKind::GitHub);
        ui::row(t, ("add-row", ix), ix == self.selected)
            .child(div().w(px(76.)).flex_none().overflow_hidden().text_ellipsis().text_size(px(size::XS)).text_color(t.quiet).child(if first {
                label
            } else {
                String::new()
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_baseline()
                    .gap_2()
                    .overflow_hidden()
                    .child(div().flex_none().max_w(px(260.)).overflow_hidden().text_ellipsis().child(title))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(t.quiet)
                            .when(mono, |d| d.font_family(t.mono_font.clone()).text_size(px(size::SM)))
                            .when(!mono, |d| d.text_size(px(size::XS)))
                            .child(middle),
                    ),
            )
            .child(div().flex_none().max_w(px(200.)).overflow_hidden().text_ellipsis().text_size(px(size::XS)).text_color(t.quiet).child(right))
            .when(added, |d| d.child(div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child("· added")))
            .on_click(cx.listener(move |this, e: &gpui::ClickEvent, _, cx| {
                this.selected = ix;
                if e.click_count() > 1 {
                    this.submit(cx);
                }
                cx.notify();
            }))
    }

    fn list(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let text = self.input.read(cx).text().trim().to_string();
        let body = div().flex().flex_col();
        let Some(d) = &self.discovery else {
            return body.child(ui::loading(t, "Looking for repos on your machines and on GitHub…"));
        };
        if self.rows.is_empty() {
            if let Some(hint) = other_host(&text) {
                return body.child(div().px_4().py_3().text_color(t.warning).whitespace_normal().child(hint));
            }
            if !text.is_empty() {
                return body.child(
                    div()
                        .px_4()
                        .py_3()
                        .text_color(t.quiet)
                        .whitespace_normal()
                        .child("Nothing matches. Paste a GitHub URL, or type a folder's full path on one of your machines."),
                );
            }
            return body.child(self.empty(t, d));
        }
        let list_h = metric::ROW * self.rows.len().min(VISIBLE_ROWS) as f32 + 8.;
        body.child(
            uniform_list(
                "add-list",
                self.rows.len(),
                cx.processor(|this, range: std::ops::Range<usize>, _, cx| range.map(|ix| this.row(ix, cx)).collect::<Vec<_>>()),
            )
            .track_scroll(&self.scroll)
            .h(px(list_h))
            .p_1(),
        )
        .children(self.problems(t, d))
    }

    fn empty(&self, t: &Theme, d: &Discovery) -> Div {
        let names: Vec<&str> = d.workers.iter().map(|w| w.name.as_str()).collect();
        let on = match names.as_slice() {
            [] => "your machines".to_string(),
            [one] => (*one).to_string(),
            [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
        };
        // gh's own trouble, when the hub reports one, is listed below with its fix.
        let gh = match (&d.gh_on, d.problems.is_empty()) {
            (Some(on), _) => format!("gh on {on} listed nothing for you or your orgs."),
            (None, true) => "GitHub repos aren't listed: gh isn't logged in on the hub or a worker (run gh auth login there).".to_string(),
            (None, false) => String::new(),
        };
        div()
            .px_4()
            .py_3()
            .flex()
            .flex_col()
            .gap_1()
            .child(div().font_weight(STRONG).child(format!("No repos found on {on}.")))
            .child(
                div()
                    .text_color(t.quiet)
                    .whitespace_normal()
                    .child(format!("Looked for git checkouts in ~/src, ~/code, ~/projects and ~/dev, two folders deep. {gh}")),
            )
            .child(div().text_color(t.quiet).whitespace_normal().child(if self.local.is_some() {
                "Paste a GitHub URL above, type a folder's full path, or Browse… for a folder on this computer."
            } else {
                "Paste a GitHub URL above, or type a folder's full path on one of your machines."
            }))
            .children(self.problems(t, d))
    }

    fn problems(&self, t: &Theme, d: &Discovery) -> Option<Div> {
        if d.problems.is_empty() {
            return None;
        }
        let mut col = div().px_4().pb_2().flex().flex_col().gap_1().text_size(px(size::XS));
        for (message, fix) in &d.problems {
            let line = match fix {
                Some(fix) => format!("{message} {fix}"),
                None => message.clone(),
            };
            col = col.child(
                div()
                    .flex()
                    .items_start()
                    .gap_2()
                    .child(ui::dot(t.warning))
                    .child(div().flex_1().min_w_0().whitespace_normal().text_color(t.quiet).child(line)),
            );
        }
        Some(col)
    }

    fn chips(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let chosen = self.target().map(|w| w.machine_id.clone());
        let best = self.discovery.as_ref().and_then(|d| d.best.clone());
        let mut row = div().flex().flex_wrap().items_center().gap_1p5();
        for (i, w) in self.workers().iter().enumerate() {
            let selected = chosen.as_deref() == Some(w.machine_id.as_str());
            let mut label = w.name.clone();
            if !w.online {
                label.push_str(" · offline");
            } else if best.as_deref() == Some(w.machine_id.as_str()) {
                label.push_str(" · suggested");
            }
            let chip = div()
                .id(("add-machine", i))
                .h(px(metric::CONTROL))
                .px_2()
                .flex()
                .items_center()
                .rounded(px(radius::SM))
                .border_1()
                .text_size(px(size::SM))
                .child(label);
            let chip = if !w.online {
                chip.border_color(t.hairline).text_color(t.quiet)
            } else if selected {
                chip.border_color(t.accent).bg(t.selected).text_color(t.text).font_weight(STRONG)
            } else {
                let id = w.machine_id.clone();
                let hover = t.hover;
                ui::clickable(t, chip).border_color(t.border).text_color(t.text).hover(move |s| s.bg(hover)).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.machine = Some(id.clone());
                        cx.notify();
                    },
                ))
            };
            row = row.child(chip);
        }
        row
    }

    fn footer(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let plan = self.plan();
        let target = self.target().cloned();
        let caption = |text: &'static str| div().w(px(76.)).flex_none().text_size(px(size::XS)).text_color(t.quiet).child(text);
        let (line_a, line_b, label, enabled): (Option<Div>, String, &'static str, bool) = match &plan {
            Plan::Clone { repo } => match &target {
                Some(w) => {
                    let into = self
                        .clone_path(&w.machine_id, repo)
                        .map_or_else(|| format!("into its clone folder on {}", w.name), |p| format!("{} on {}", tilde(&p), w.name));
                    (Some(div().flex().items_center().child(caption("Clone onto")).child(self.chips(t, cx))), into, "Clone and add", true)
                }
                None => (None, "No machine is online to clone onto.".into(), "Clone and add", false),
            },
            Plan::Folder { machine_id, path, fixed: true } => {
                (None, format!("{} on {}, as it is: nothing is cloned", tilde(path), self.machine_name(machine_id)), "Add project", true)
            }
            Plan::Folder { path, .. } => {
                let ok = path.starts_with('/');
                let line = if ok {
                    format!("{path} on {}", target.as_ref().map_or("", |w| w.name.as_str()))
                } else {
                    "Type the full path, starting with /.".into()
                };
                (Some(div().flex().items_center().child(caption("On")).child(self.chips(t, cx))), line, "Add project", ok)
            }
            Plan::Open(key) => (None, format!("Already a project on {}.", self.machine_name(&key.0)), "Open project", true),
            Plan::Nothing => (None, String::new(), "Add project", false),
        };
        let primary = ui::button(t, "add-go", label, Variant::Primary, enabled);
        let primary = if enabled { primary.on_click(cx.listener(|this, _, _, cx| this.submit(cx))) } else { primary };
        let browse = self
            .local
            .is_some()
            .then(|| ui::button(t, "add-browse", "Browse…", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| this.browse(cx))));
        div().flex_none().px_4().py_3().flex().flex_col().gap_2().border_t_1().border_color(t.hairline).children(line_a).child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .font_family(t.mono_font.clone())
                        .text_size(px(size::SM))
                        .text_color(t.quiet)
                        .child(line_b),
                )
                .children(browse)
                .child(primary),
        )
    }

    fn pick_view(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let note = self.note.clone().map(|(text, problem)| {
            div().px_4().pt_2().text_size(px(size::XS)).whitespace_normal().text_color(if problem { t.warning } else { t.quiet }).child(text)
        });
        div()
            .flex()
            .flex_col()
            .child(self.header(t, "Add a project".into(), "Close", cx))
            .child(div().h(px(metric::BAR + 4.)).px_2().flex().items_center().border_b_1().border_color(t.hairline).child(self.input.clone()))
            .children(note)
            .child(self.list(t, cx))
            .child(self.footer(t, cx))
    }

    fn working_view(&self, t: &Theme, job: &Job, cx: &mut Context<Self>) -> Div {
        let steps: &[(Step, &str, &str)] = &[
            (Step::Clone, "Clone", "git clone on the machine"),
            (Step::Inspect, "Inspect", "default branch, CI and merge rules"),
            (Step::Register, "Register", "a project, with its own lead"),
        ];
        let mut list = div().px_4().py_3().flex().flex_col().gap_3();
        for (step, name, idle) in steps.iter().filter(|(s, ..)| job.clone || *s != Step::Clone) {
            let done = *step < job.step;
            let now = *step == job.step;
            let mark = if done {
                ui::dot(t.success)
            } else if now {
                ui::dot(t.accent)
            } else {
                ui::ring(t.quiet)
            };
            let detail = if now {
                job.detail.clone()
            } else if done {
                "done".into()
            } else {
                (*idle).to_string()
            };
            let bar = (now && job.fraction.is_some()).then(|| {
                let f = job.fraction.unwrap_or(0.).clamp(0., 1.);
                // Drawn at each event's value: it moves when git reports, never on its own.
                div().mt_1p5().h(px(4.)).w_full().rounded_full().bg(t.hairline).child(div().h_full().w(relative(f)).rounded_full().bg(t.accent_fill))
            });
            list = list.child(
                div().flex().items_start().gap_3().child(mark).child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .flex()
                                .items_baseline()
                                .gap_3()
                                .child(
                                    div()
                                        .w(px(64.))
                                        .flex_none()
                                        .when(now, |d| d.font_weight(STRONG))
                                        .when(!now && !done, |d| d.text_color(t.quiet))
                                        .child(*name),
                                )
                                .child(div().flex_1().min_w_0().whitespace_normal().text_size(px(size::XS)).text_color(t.quiet).child(detail)),
                        )
                        .children(bar),
                ),
            );
        }
        div()
            .flex()
            .flex_col()
            .child(self.header(t, format!("Adding {}", job.what), "Hide", cx))
            .child(div().px_4().pt_3().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(format!(
                "{} on {}",
                tilde(&job.path),
                job.machine
            )))
            .child(list)
            .child(
                div()
                    .px_4()
                    .pb_3()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .whitespace_normal()
                    .child("Hide this and carry on; the add keeps going, and the line at the bottom says when it's ready."),
            )
    }

    fn ready_view(&self, t: &Theme, r: &Ready, cx: &mut Context<Self>) -> Div {
        let mut facts = div().px_4().py_3().flex().flex_col().gap_1p5();
        for (label, value) in &r.facts {
            facts = facts.child(
                div()
                    .flex()
                    .items_baseline()
                    .gap_3()
                    .child(div().w(px(112.)).flex_none().text_size(px(size::XS)).text_color(t.quiet).child(*label))
                    .child(div().flex_1().min_w_0().whitespace_normal().child(value.clone())),
            );
        }
        let lead = div()
            .mx_4()
            .px_3()
            .py_2()
            .rounded(px(radius::MD))
            .bg(t.selected)
            .flex()
            .items_start()
            .gap_2()
            .child(ui::dot(if r.lead_ok { t.success } else { t.warning }))
            .child(div().flex_1().min_w_0().whitespace_normal().child(r.lead_line.clone()));
        let notes = (!r.notes.is_empty())
            .then(|| div().px_4().pt_2().text_size(px(size::XS)).text_color(t.quiet).whitespace_normal().child(r.notes.join(" ")));
        let key = r.key.clone();
        div()
            .flex()
            .flex_col()
            .child(self.header(t, format!("{} is ready", r.title), "Close", cx))
            .child(div().px_4().pt_3().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(format!(
                "{} on {}",
                tilde(&r.path),
                r.machine
            )))
            .child(facts)
            .child(lead)
            .children(notes)
            .child(
                div()
                    .px_4()
                    .py_3()
                    .mt_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .border_t_1()
                    .border_color(t.hairline)
                    .child(div().flex_1().text_size(px(size::XS)).text_color(t.quiet).child("Its lead starts with the first order you send it."))
                    .child(ui::button(t, "add-another", "Add another", Variant::Secondary, true).on_click(cx.listener(|this, _, window, cx| {
                        this.phase = Phase::Pick;
                        this.input.update(cx, |i, cx| i.clear(cx));
                        window.focus(&this.input.focus_handle(cx), cx);
                        cx.notify();
                    })))
                    .child(
                        ui::button(t, "add-open", "Open project", Variant::Primary, true)
                            .on_click(cx.listener(move |_, _, _, cx| cx.emit(AddEvent::Open(key.clone())))),
                    ),
            )
    }

    fn failed_view(&self, t: &Theme, what: &str, f: &Failure, cx: &mut Context<Self>) -> Div {
        let all = match &f.fix {
            Some(fix) => format!("{}\n{fix}", f.message),
            None => f.message.clone(),
        };
        let copy = ui::copy_button(t, "add-copy", self.copied).on_click(cx.listener(move |this, _, _, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(all.clone()));
            this.copied = true;
            cx.notify();
        }));
        let retry = f.action.clone().map(|action| {
            let label = match &action {
                FailAction::UseExisting(_) => "Add the existing folder",
                FailAction::Retry(_) => "Send it again",
                FailAction::Open(_) => "Open project",
            };
            ui::button(t, "add-retry", label, Variant::Primary, true).on_click(cx.listener(move |this, _, _, cx| match &action {
                FailAction::UseExisting(request) | FailAction::Retry(request) => this.start(request.clone(), cx),
                FailAction::Open(key) => cx.emit(AddEvent::Open(key.clone())),
            }))
        });
        div()
            .flex()
            .flex_col()
            .child(self.header(t, format!("Couldn't add {what}"), "Close", cx))
            .child(div().px_4().py_4().child(ui::error(t, f.message.clone(), f.fix.clone().map(SharedString::from), copy)))
            .child(
                div()
                    .px_4()
                    .py_3()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap_2()
                    .border_t_1()
                    .border_color(t.hairline)
                    .child(ui::button(t, "add-back", "Back", Variant::Secondary, true).on_click(cx.listener(|this, _, _, cx| this.back(cx))))
                    .children(retry),
            )
    }
}

impl Render for AddSheet {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let body = match self.phase.clone() {
            Phase::Pick => self.pick_view(t, cx),
            Phase::Working(job) => self.working_view(t, &job, cx),
            Phase::Ready(r) => self.ready_view(t, &r, cx),
            Phase::Failed { what, failure } => self.failed_view(t, &what, &failure, cx),
        };
        ui::floating(t)
            .key_context(CONTEXT)
            .on_action(cx.listener(|this, _: &SelectPrev, _, cx| this.step(-1, cx)))
            .on_action(cx.listener(|this, _: &SelectNext, _, cx| this.step(1, cx)))
            .w(px(WIDTH))
            .flex()
            .flex_col()
            .text_size(px(size::MD))
            .text_color(t.text)
            .child(body)
    }
}
