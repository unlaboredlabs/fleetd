//! Settings → Prompts: every prompt fleetd sends a model, grouped by who it is for, each editable hub-wide or for
//! one project. Warnings (a dropped placeholder, a safety rule the text no longer states, too long) come from the
//! hub's dry run as you type and never block a save. A running session keeps the text it started with.
//!
//! The reducer half (`impl State`) is pure and tested below; the screen is an `impl Shell` block like the others.

use std::collections::{HashMap, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::time::Duration;

use fleetd_contracts::app::AppClientMessage;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::mcp::{
    PromptGetInput, PromptGetOutput, PromptResetInput, PromptSetInput, PromptSetOutput, PromptsListInput, PromptsListOutput, SessionPromptGetInput,
    SessionPromptGetOutput,
};
use fleetd_contracts::prompts::{
    Enforcement, PromptDetail, PromptGroup, PromptId, PromptRef, PromptScope, PromptSummary, PromptWarning, PromptWarningCode, SessionPrompt,
};
use gpui::{AnyElement, Context, Div, Entity, Focusable, SharedString, Stateful, Subscription, Task, anchored, deferred, div, prelude::*, px};

use crate::client::Incoming;
use crate::diffview::DiffView;
use crate::input::{InputEvent, TextInput};
use crate::shell::Shell;
use crate::state::{Conn, Echo, Out, ProjectKey, Purpose, State, parse};
use crate::theme::{STRONG, Theme, metric, radius, size, theme};
use crate::ui::{self, Variant};

/// The registry id of the human's custom instructions; they have their own page, not a row in the list.
pub const INSTRUCTIONS: &str = "instructions";
/// The dry run waits for a pause in typing this long (spec 2h).
const CHECK_AFTER: Duration = Duration::from_millis(300);

// ---- state ------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Load<T> {
    #[default]
    Idle,
    Loading,
    Ready(T),
    Failed(String),
}

impl<T> Load<T> {
    pub fn ready(&self) -> Option<&T> {
        match self {
            Load::Ready(v) => Some(v),
            _ => None,
        }
    }

    fn from(parsed: Result<T, String>) -> Self {
        parsed.map_or_else(Load::Failed, Load::Ready)
    }
}

/// Which prompt call an answer is for. Reads carry the sequence number they were sent with: an answer for a project
/// or prompt no longer on screen is dropped.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Call {
    List(u64),
    Get(u64),
    Check(u64),
    Save,
    Reset,
    Told(ThreadRef),
    Instructions(u64),
    InstructionsSave(PromptScope),
}

/// "What this agent was told": one session's pinned first message.
pub struct Told {
    pub thread: ThreadRef,
    /// "the lead", "T31".
    pub who: String,
    pub prompt: Load<SessionPrompt>,
}

#[derive(Default)]
pub struct Prompts {
    /// Whose texts the Prompts page shows; `None` is hub-wide.
    pub project: Option<ProjectKey>,
    pub list: Load<Vec<PromptSummary>>,
    pub selected: Option<PromptId>,
    pub detail: Load<PromptDetail>,
    /// The latest warnings and the exact text they are for.
    pub checked: Option<(String, Vec<PromptWarning>)>,
    checking: Option<(u64, String)>,
    /// A save or reset is out.
    pub busy: bool,
    saving: Option<String>,
    pub echo: Option<Echo>,
    pub told: Option<Told>,
    /// The project the Instructions page's second field is for.
    pub instructions_for: Option<ProjectKey>,
    pub instructions: Load<PromptDetail>,
    pub instructions_busy: Option<PromptScope>,
    pub instructions_echo: Option<Echo>,
    seq: u64,
    want_list: u64,
    want_detail: u64,
    want_instructions: u64,
    /// The connection dropped with something loaded: fetch it again on the next snapshot.
    dropped: bool,
}

impl Prompts {
    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    pub(crate) fn reset_calls(&mut self) {
        self.busy = false;
        self.saving = None;
        self.checking = None;
        self.instructions_busy = None;
        if let Some(told) = self.told.as_mut().filter(|t| t.prompt == Load::Loading) {
            told.prompt = Load::Failed("The hub connection dropped; open it again.".into());
        }
        self.dropped = self.list != Load::Idle || self.instructions != Load::Idle;
    }
}

pub fn project_ref(key: &ProjectKey) -> ProjectRef {
    ProjectRef { machine_id: MachineId::unchecked(key.0.as_str()), project_id: ProjectId::unchecked(key.1.as_str()) }
}

/// The level a save lands on: the picked project's own text, or hub-wide for prompts that have only that level.
pub fn edit_scope(detail: &PromptDetail, project: Option<&ProjectKey>) -> PromptScope {
    if project.is_some() && detail.per_project { PromptScope::Project } else { PromptScope::Global }
}

pub fn has_override(detail: &PromptDetail, scope: PromptScope) -> bool {
    match scope {
        PromptScope::Project => detail.project.is_some(),
        PromptScope::Global => detail.global.is_some(),
        PromptScope::Default => false,
    }
}

impl State {
    /// Opens (or refreshes) the Prompts page for `project`, or hub-wide.
    pub fn prompts_open(&mut self, project: Option<ProjectKey>) -> Out {
        if self.prompts.project != project {
            self.prompts.project = project;
            self.prompts.list = Load::Loading;
            self.prompts.echo = None;
            if self.prompts.detail != Load::Idle {
                self.prompts.detail = Load::Loading;
            }
        }
        let mut out: Out = self.prompts_list_call().into_iter().collect();
        out.extend(self.prompts.selected.clone().and_then(|id| self.prompt_get_call(id)));
        out
    }

    pub fn prompt_select(&mut self, id: PromptId) -> Out {
        if self.prompts.selected.as_ref() != Some(&id) {
            self.prompts.selected = Some(id.clone());
            self.prompts.detail = Load::Loading;
            self.prompts.checked = None;
            self.prompts.echo = None;
        }
        self.prompt_get_call(id).into_iter().collect()
    }

    /// Asks the hub what saving `text` would warn about, without saving it.
    pub fn prompt_check(&mut self, text: &str) -> Out {
        let Some(input) = self.prompt_set_input(text, Some(true)) else { return Vec::new() };
        let seq = self.prompts.next();
        self.prompts.checking = Some((seq, text.to_string()));
        vec![self.call(Purpose::Prompt(Call::Check(seq)), &input)]
    }

    pub fn prompt_save(&mut self, text: &str) -> Out {
        if self.prompts.busy {
            return Vec::new();
        }
        if !self.live_prompts() {
            self.prompts.echo = Some(Echo { text: "Not connected to the hub; nothing was saved.".into(), ok: false });
            return Vec::new();
        }
        let Some(input) = self.prompt_set_input(text, None) else { return Vec::new() };
        self.prompts.busy = true;
        self.prompts.saving = Some(text.to_string());
        self.prompts.echo = None;
        vec![self.call(Purpose::Prompt(Call::Save), &input)]
    }

    /// Drops the override at the level a save would land on.
    pub fn prompt_reset(&mut self) -> Out {
        let Some(detail) = self.prompts.detail.ready() else { return Vec::new() };
        if self.prompts.busy || !self.live_prompts() {
            return Vec::new();
        }
        let scope = edit_scope(detail, self.prompts.project.as_ref());
        let input = PromptResetInput {
            id: detail.id.clone(),
            scope,
            project_ref: (scope == PromptScope::Project).then(|| self.prompts.project.as_ref().map(project_ref)).flatten(),
        };
        self.prompts.busy = true;
        self.prompts.echo = None;
        vec![self.call(Purpose::Prompt(Call::Reset), &input)]
    }

    /// Opens the "what this agent was told" sheet for one session.
    pub fn session_prompt(&mut self, thread: ThreadRef, who: String) -> Out {
        if !self.live_prompts() {
            self.prompts.told = Some(Told { thread, who, prompt: Load::Failed("Not connected to the hub.".into()) });
            return Vec::new();
        }
        let input = SessionPromptGetInput { machine_id: thread.machine_id.clone(), thread_id: thread.thread_id.clone() };
        self.prompts.told = Some(Told { thread: thread.clone(), who, prompt: Load::Loading });
        vec![self.call(Purpose::Prompt(Call::Told(thread)), &input)]
    }

    pub fn instructions_open(&mut self, project: Option<ProjectKey>) -> Out {
        if self.prompts.instructions_for != project {
            self.prompts.instructions_for = project;
            self.prompts.instructions = Load::Loading;
            self.prompts.instructions_echo = None;
        }
        if !self.live_prompts() {
            self.prompts.instructions = Load::Failed("Not connected to the hub.".into());
            self.prompts.dropped = true;
            return Vec::new();
        }
        if self.prompts.instructions == Load::Idle {
            self.prompts.instructions = Load::Loading;
        }
        let seq = self.prompts.next();
        self.prompts.want_instructions = seq;
        let input = PromptGetInput { id: PromptId::unchecked(INSTRUCTIONS), project_ref: self.prompts.instructions_for.as_ref().map(project_ref) };
        vec![self.call(Purpose::Prompt(Call::Instructions(seq)), &input)]
    }

    /// Saves hub-wide (`Global`) or the picked project's instructions. Empty text is allowed: it clears them.
    pub fn instructions_save(&mut self, scope: PromptScope, text: &str) -> Out {
        let Some(detail) = self.prompts.instructions.ready() else { return Vec::new() };
        if self.prompts.instructions_busy.is_some() || !self.live_prompts() {
            return Vec::new();
        }
        let project_ref = match scope {
            PromptScope::Project => match self.prompts.instructions_for.as_ref() {
                Some(key) => Some(project_ref(key)),
                None => return Vec::new(),
            },
            _ => None,
        };
        let input = PromptSetInput {
            id: detail.id.clone(),
            scope,
            project_ref,
            text: text.to_string(),
            base: Some(detail.default.r#ref.clone()),
            dry_run: None,
        };
        self.prompts.instructions_busy = Some(scope);
        self.prompts.instructions_echo = None;
        vec![self.call(Purpose::Prompt(Call::InstructionsSave(scope)), &input)]
    }

    pub(crate) fn on_prompt_event(&mut self) -> Out {
        let mut out = Vec::new();
        if self.prompts.list != Load::Idle {
            out.extend(self.prompts_list_call());
        }
        if !self.prompts.busy
            && let Some(id) = self.prompts.selected.clone()
        {
            out.extend(self.prompt_get_call(id));
        }
        if self.prompts.instructions.ready().is_some() && self.prompts.instructions_busy.is_none() {
            out.extend(self.instructions_open(self.prompts.instructions_for.clone()));
        }
        out
    }

    /// After a reconnect, refetches what the dropped connection had loaded.
    pub(crate) fn prompts_reconnected(&mut self) -> Out {
        if !std::mem::take(&mut self.prompts.dropped) {
            return Vec::new();
        }
        let mut out = Vec::new();
        if self.prompts.list != Load::Idle {
            out.extend(self.prompts_open(self.prompts.project.clone()));
        }
        if self.prompts.instructions != Load::Idle {
            out.extend(self.instructions_open(self.prompts.instructions_for.clone()));
        }
        out
    }

    pub(crate) fn on_prompt_result(&mut self, call: &Call, output: serde_json::Value) -> Out {
        let p = &mut self.prompts;
        match call {
            Call::List(seq) if *seq == p.want_list => p.list = Load::from(parse::<PromptsListOutput>(output).map(|o| o.prompts)),
            Call::Get(seq) if *seq == p.want_detail => {
                let detail = Load::from(parse::<PromptGetOutput>(output).map(|o| o.prompt));
                if let Load::Ready(d) = &detail {
                    p.checked = Some((d.effective.text.clone(), d.warnings.clone()));
                }
                p.detail = detail;
            }
            Call::Check(seq) => {
                if let (Some((_, text)), Ok(o)) = (p.checking.take_if(|(s, _)| s == seq), parse::<PromptSetOutput>(output)) {
                    p.checked = Some((text, o.warnings));
                }
            }
            Call::Save => {
                p.busy = false;
                let text = p.saving.take();
                match parse::<PromptSetOutput>(output) {
                    Ok(o) => {
                        p.echo = Some(Echo { text: saved_line(&o), ok: true });
                        p.checked = text.map(|t| (t, o.warnings));
                        return self.refresh_page();
                    }
                    Err(e) => p.echo = Some(Echo { text: e, ok: false }),
                }
            }
            Call::Reset => {
                p.busy = false;
                p.echo = Some(Echo { text: "Back to fleetd's default. New sessions get it; running ones keep their text.".into(), ok: true });
                return self.refresh_page();
            }
            Call::Told(thread) => {
                if let Some(told) = p.told.as_mut().filter(|t| &t.thread == thread) {
                    told.prompt = Load::from(parse::<SessionPromptGetOutput>(output).map(|o| o.session));
                }
            }
            Call::Instructions(seq) if *seq == p.want_instructions => p.instructions = Load::from(parse::<PromptGetOutput>(output).map(|o| o.prompt)),
            Call::InstructionsSave(scope) => {
                p.instructions_busy = None;
                let whose = match (scope, &p.instructions_for) {
                    (PromptScope::Project, Some(key)) => format!("for {}", key.1),
                    _ => "for every project".to_string(),
                };
                p.instructions_echo = Some(match parse::<PromptSetOutput>(output) {
                    Ok(_) => Echo { text: format!("Saved {whose}. New sessions get them; a lead gets them at its next restart."), ok: true },
                    Err(e) => Echo { text: e, ok: false },
                });
                return self.instructions_open(self.prompts.instructions_for.clone());
            }
            _ => {}
        }
        Vec::new()
    }

    pub(crate) fn on_prompt_error(&mut self, call: &Call, text: String) {
        let p = &mut self.prompts;
        match call {
            Call::List(seq) if *seq == p.want_list => p.list = Load::Failed(text),
            Call::Get(seq) if *seq == p.want_detail => p.detail = Load::Failed(text),
            // No live warnings from a hub without a dry run; the save still works and answers with them.
            Call::Check(_) => p.checking = None,
            Call::Save | Call::Reset => {
                p.busy = false;
                p.saving = None;
                p.echo = Some(Echo { text, ok: false });
            }
            Call::Told(thread) => {
                if let Some(told) = p.told.as_mut().filter(|t| &t.thread == thread) {
                    told.prompt = Load::Failed(text);
                }
            }
            Call::Instructions(seq) if *seq == p.want_instructions => p.instructions = Load::Failed(text),
            Call::InstructionsSave(_) => {
                p.instructions_busy = None;
                p.instructions_echo = Some(Echo { text, ok: false });
            }
            _ => {}
        }
    }

    fn live_prompts(&self) -> bool {
        self.conn == Conn::Live
    }

    fn prompts_list_call(&mut self) -> Option<AppClientMessage> {
        if !self.live_prompts() {
            self.prompts.list = Load::Failed("Not connected to the hub.".into());
            self.prompts.dropped = true;
            return None;
        }
        if self.prompts.list == Load::Idle {
            self.prompts.list = Load::Loading;
        }
        let seq = self.prompts.next();
        self.prompts.want_list = seq;
        let input = PromptsListInput { project_ref: self.prompts.project.as_ref().map(project_ref) };
        Some(self.call(Purpose::Prompt(Call::List(seq)), &input))
    }

    fn prompt_get_call(&mut self, id: PromptId) -> Option<AppClientMessage> {
        if !self.live_prompts() {
            self.prompts.detail = Load::Failed("Not connected to the hub.".into());
            return None;
        }
        let seq = self.prompts.next();
        self.prompts.want_detail = seq;
        let input = PromptGetInput { id, project_ref: self.prompts.project.as_ref().map(project_ref) };
        Some(self.call(Purpose::Prompt(Call::Get(seq)), &input))
    }

    fn prompt_set_input(&self, text: &str, dry_run: Option<bool>) -> Option<PromptSetInput> {
        let detail = self.prompts.detail.ready()?;
        let scope = edit_scope(detail, self.prompts.project.as_ref());
        Some(PromptSetInput {
            id: detail.id.clone(),
            scope,
            project_ref: (scope == PromptScope::Project).then(|| self.prompts.project.as_ref().map(project_ref)).flatten(),
            text: text.to_string(),
            base: Some(detail.default.r#ref.clone()),
            dry_run,
        })
    }

    fn refresh_page(&mut self) -> Out {
        let mut out: Out = self.prompts_list_call().into_iter().collect();
        out.extend(self.prompts.selected.clone().and_then(|id| self.prompt_get_call(id)));
        out
    }
}

fn saved_line(o: &PromptSetOutput) -> String {
    let warned = match o.warnings.len() {
        0 => String::new(),
        1 => " with 1 warning".into(),
        n => format!(" with {n} warnings"),
    };
    format!("Saved as {}{warned}. New sessions get it; running ones keep the text they started with.", o.r#ref)
}

/// The hunks of a unified diff of `old` → `new`, with no file header: [`DiffView`]'s list sizes every row from
/// the first, and a header row is taller than a line. The captions around it name the two sides instead.
pub fn unified(old: &str, new: &str) -> String {
    let patch = diffy::create_patch(old, new).to_string();
    patch.lines().skip_while(|l| !l.starts_with("@@")).flat_map(|l| [l, "\n"]).collect()
}

/// (lines added, lines removed) in a diff from [`unified`].
fn counts(diff: &str) -> (usize, usize) {
    crate::diff::parse_unified(diff).iter().fold((0, 0), |(a, r), l| match l.kind {
        crate::diff::DiffKind::Added => (a + 1, r),
        crate::diff::DiffKind::Removed => (a, r + 1),
        _ => (a, r),
    })
}

pub fn group_label(g: PromptGroup) -> &'static str {
    match g {
        PromptGroup::Lead => "Lead",
        PromptGroup::Tasks => "Tasks",
        PromptGroup::ReviewsAndChecks => "Reviews and checks",
        PromptGroup::WakesAndMessages => "Wakes and messages",
        PromptGroup::OneShots => "One-shots",
        PromptGroup::Playbooks => "Playbooks",
        PromptGroup::Instructions => "Instructions",
    }
}

const GROUPS: [PromptGroup; 6] = [
    PromptGroup::Lead,
    PromptGroup::Tasks,
    PromptGroup::ReviewsAndChecks,
    PromptGroup::WakesAndMessages,
    PromptGroup::OneShots,
    PromptGroup::Playbooks,
];

/// A warning as one line: what is wrong, and for a safety rule, who still keeps it.
pub fn warning_line(w: &PromptWarning) -> String {
    match (w.code, w.enforced) {
        (PromptWarningCode::SafetyRuleMissing, Some(Enforcement::Code)) if !w.message.contains("enforces") => {
            format!("{} fleetd still enforces this; agents will hit refusals they were not warned about.", w.message)
        }
        (PromptWarningCode::SafetyRuleMissing, Some(Enforcement::Prompt)) if !w.message.contains("enforces") => {
            format!("{} Nothing else enforces this.", w.message)
        }
        _ => w.message.clone(),
    }
}

// ---- screen -----------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Edit,
    Compare,
    Update,
}

/// A diff view, the hash of the two texts it shows, and its (added, removed) counts.
type CachedDiff = (u64, Entity<DiffView>, (usize, usize));

/// The Prompts and Instructions pages' fields and view state, kept on the shell.
pub struct Ui {
    pub editor: Entity<TextInput>,
    /// The update view's merged text.
    pub merged: Entity<TextInput>,
    pub instr_global: Entity<TextInput>,
    pub instr_project: Entity<TextInput>,
    /// The prompt, effective ref and text the editor was last filled from.
    loaded: Option<(PromptId, PromptRef, String)>,
    merged_for: Option<(PromptId, PromptRef)>,
    /// The instructions the two fields were last filled from: (project, hub-wide text, project text).
    pub(crate) instr_loaded: Option<(Option<ProjectKey>, String, String)>,
    pub tab: Tab,
    /// The open project picker, by id.
    pub picker: Option<&'static str>,
    picker_closed: Option<(&'static str, std::time::Instant)>,
    diffs: HashMap<&'static str, CachedDiff>,
    check: Option<Task<()>>,
    /// The bench's stand-in for the hub's prompt tools.
    pub fake: Option<crate::fake::PromptHub>,
    _subs: Vec<Subscription>,
}

impl Ui {
    pub fn new(cx: &mut Context<Shell>) -> Self {
        let editor = cx.new(|cx| TextInput::new(cx).multi_line(16).mono().enter_newline().placeholder("An empty prompt can't be saved."));
        let merged = cx.new(|cx| TextInput::new(cx).multi_line(14).mono().enter_newline());
        let instr_global = cx.new(|cx| TextInput::new(cx).multi_line(10).enter_newline().placeholder("e.g. Keep pull requests under 400 lines."));
        let instr_project = cx.new(|cx| TextInput::new(cx).multi_line(10).enter_newline().placeholder("e.g. Use pnpm, not npm."));
        let subs = vec![cx.subscribe(&editor, Shell::on_prompt_input), cx.subscribe(&merged, Shell::on_prompt_input)];
        Self {
            editor,
            merged,
            instr_global,
            instr_project,
            loaded: None,
            merged_for: None,
            instr_loaded: None,
            tab: Tab::Edit,
            picker: None,
            picker_closed: None,
            diffs: HashMap::new(),
            check: None,
            fake: None,
            _subs: subs,
        }
    }
}

/// A small label after a row's title: quiet for the default, outlined for an edit, amber for an update.
pub fn chip(t: &Theme, label: &'static str, kind: ChipKind) -> Div {
    let d = div().flex_none().px_1p5().rounded(px(radius::SM)).text_size(px(size::XS)).line_height(px(16.));
    match kind {
        ChipKind::Quiet => d.text_color(t.quiet),
        ChipKind::Edited => d.border_1().border_color(t.border).text_color(t.text),
        ChipKind::Update => d.border_1().border_color(t.warning).text_color(t.warning),
    }
    .child(label)
}

#[derive(Clone, Copy)]
pub enum ChipKind {
    Quiet,
    Edited,
    Update,
}

impl Shell {
    /// Every prompt call goes out here: to the hub, or in the bench to its fake, which answers at once.
    pub(crate) fn send_prompts(&mut self, out: Out, cx: &mut Context<Self>) {
        match self.prompts_ui.fake.as_mut() {
            Some(fake) => {
                let mut queue: VecDeque<AppClientMessage> = out.into();
                while let Some(message) = queue.pop_front() {
                    let Some(reply) = fake.answer(&message) else { continue };
                    queue.extend(self.state.apply(Incoming::Message(reply)));
                }
            }
            None => self.send(out),
        }
        cx.notify();
    }

    fn on_prompt_input(&mut self, input: Entity<TextInput>, event: &InputEvent, cx: &mut Context<Self>) {
        if *event != InputEvent::Changed {
            return;
        }
        let text = input.read(cx).text().to_string();
        if self.state.prompts.checked.as_ref().is_some_and(|(t, _)| *t == text) || text.is_empty() {
            return;
        }
        self.prompts_ui.check = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CHECK_AFTER).await;
            this.update(cx, |this, cx| {
                let out = this.state.prompt_check(&text);
                this.send_prompts(out, cx);
            })
            .ok();
        }));
    }

    pub(crate) fn open_prompts(&mut self, project: Option<ProjectKey>, cx: &mut Context<Self>) {
        self.prompts_ui.picker = None;
        let out = self.state.prompts_open(project);
        self.send_prompts(out, cx);
    }

    pub(crate) fn select_prompt(&mut self, id: PromptId, cx: &mut Context<Self>) {
        if self.state.prompts.selected.as_ref() != Some(&id) {
            self.prompts_ui.tab = Tab::Edit;
        }
        let out = self.state.prompt_select(id);
        self.send_prompts(out, cx);
    }

    /// Fills the editors from what the hub sent, unless you have unsaved edits to the same prompt.
    fn sync_prompt_editors(&mut self, cx: &mut Context<Self>) {
        let Some(d) = self.state.prompts.detail.ready() else { return };
        let now = (d.id.clone(), d.effective.r#ref.clone());
        let fill = match &self.prompts_ui.loaded {
            Some((id, r, _)) if *id == now.0 && *r == now.1 => false,
            Some((id, _, text)) if *id == now.0 => self.prompts_ui.editor.read(cx).text() == text,
            _ => true,
        };
        if fill {
            let text = d.effective.text.clone();
            self.prompts_ui.editor.update(cx, |i, cx| {
                i.set_text(&text, cx);
                i.caret_to_start(cx);
            });
        }
        self.prompts_ui.loaded = Some((now.0.clone(), now.1.clone(), d.effective.text.clone()));
        if let Some(stale) = &d.stale {
            let key = (now.0.clone(), stale.current.r#ref.clone());
            if self.prompts_ui.merged_for.as_ref() != Some(&key) {
                let merged = stale.merged.clone();
                self.prompts_ui.merged.update(cx, |i, cx| {
                    i.set_text(&merged, cx);
                    i.caret_to_start(cx);
                });
                self.prompts_ui.merged_for = Some(key);
            }
        } else if self.prompts_ui.tab == Tab::Update {
            self.prompts_ui.tab = Tab::Edit;
        }
    }

    /// A cached diff view of `old` → `new`; rebuilt only when either side changes.
    fn diff_view(&mut self, slot: &'static str, old: &str, new: &str, cx: &mut Context<Self>) -> (Entity<DiffView>, (usize, usize)) {
        let mut h = DefaultHasher::new();
        (old, new).hash(&mut h);
        let key = h.finish();
        match self.prompts_ui.diffs.get(slot) {
            Some((k, v, n)) if *k == key => (v.clone(), *n),
            _ => {
                let text = unified(old, new);
                let n = counts(&text);
                let v = cx.new(|_| DiffView::new(&text));
                self.prompts_ui.diffs.insert(slot, (key, v.clone(), n));
                (v, n)
            }
        }
    }

    /// The "for" picker both pages share: hub-wide, or one project.
    pub(crate) fn project_picker(
        &self,
        id: &'static str,
        current: Option<&ProjectKey>,
        hub_wide: Option<&'static str>,
        on_pick: fn(&mut Shell, Option<ProjectKey>, &mut Context<Shell>),
        cx: &mut Context<Self>,
    ) -> Div {
        let t = &theme(cx).clone();
        let label = match current {
            Some(key) => self.state.project(key).map_or(key.1.clone(), |r| r.summary.title.to_string()),
            None => hub_wide.unwrap_or("Pick a project").to_string(),
        };
        let open = self.prompts_ui.picker == Some(id);
        let button = ui::button(t, (id, 0usize), format!("{label} ▾"), Variant::Secondary, true).on_click(cx.listener(move |this, _, _, cx| {
            // The press that closed the menu by landing outside it, here on its button, must not open it again.
            let just_closed = this.prompts_ui.picker_closed.is_some_and(|(was, at)| was == id && at.elapsed() < Duration::from_millis(400));
            this.prompts_ui.picker = if this.prompts_ui.picker == Some(id) || just_closed { None } else { Some(id) };
            this.prompts_ui.picker_closed = None;
            cx.notify();
        }));
        let menu = open.then(|| {
            let mut list = div().id((id, 1usize)).max_h(px(320.)).overflow_y_scroll().p_1().flex().flex_col();
            if let Some(hw) = hub_wide {
                list = list.child(
                    ui::row(t, (id, 2usize), current.is_none())
                        .flex_none()
                        .child(hw)
                        .on_click(cx.listener(move |this, _, _, cx| on_pick(this, None, cx))),
                );
            }
            for (ix, row) in self.state.projects.iter().enumerate() {
                let key = row.key();
                let selected = current == Some(&key);
                let machine = key.0.clone();
                list = list.child(
                    ui::row(t, SharedString::from(format!("{id}-p{ix}")), selected)
                        .flex_none()
                        .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().child(row.summary.title.to_string()))
                        .child(div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(machine))
                        .on_click(cx.listener(move |this, _, _, cx| on_pick(this, Some(key.clone()), cx))),
                );
            }
            // Deferred and anchored, so the menu paints over the list below it and is never clipped by a scroll area.
            deferred(anchored().snap_to_window().child(
                ui::floating(t).mt(px(metric::CONTROL + 4.)).w(px(280.)).occlude().child(list).on_mouse_down_out(cx.listener(
                    move |this, _, _, cx| {
                        this.prompts_ui.picker = None;
                        this.prompts_ui.picker_closed = Some((id, std::time::Instant::now()));
                        cx.notify();
                    },
                )),
            ))
            .with_priority(1)
        });
        div().flex_none().child(button).children(menu)
    }

    pub(crate) fn prompts_page(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        if !self.connected() {
            return ui::empty(t, "Not connected", "Connect to a hub to see and edit the prompts it sends its agents.").into_any_element();
        }
        self.sync_prompt_editors(cx);
        let project = self.state.prompts.project.clone();
        let picker = self.project_picker("prompts-for", project.as_ref(), Some("Hub-wide"), |this, key, cx| this.open_prompts(key, cx), cx);
        let top = div()
            .flex_none()
            .px_4()
            .py_2()
            .flex()
            .items_center()
            .gap_3()
            .border_b_1()
            .border_color(t.hairline)
            .child(div().text_color(t.quiet).child("Texts for"))
            .child(picker)
            .child(div().flex_1())
            .child(div().text_size(px(size::XS)).text_color(t.quiet).child("Running sessions keep the text they started with."));
        let list = self.prompt_list(cx);
        let detail = self.prompt_detail(cx);
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(top)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(div().w(px(260.)).flex_none().min_h_0().flex().flex_col().border_r_1().border_color(t.hairline).child(list))
                    .child(div().flex_1().min_w_0().min_h_0().flex().flex_col().child(detail)),
            )
            .into_any_element()
    }

    fn prompt_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let rows = match &self.state.prompts.list {
            Load::Idle | Load::Loading => return ui::loading(t, "Loading prompts…").into_any_element(),
            Load::Failed(e) => {
                let e = e.clone();
                let retry = ui::button(t, "prompts-retry", "Retry", Variant::Secondary, true)
                    .on_click(cx.listener(|this, _, _, cx| this.open_prompts(this.state.prompts.project.clone(), cx)));
                return div()
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.error_line("copy-prompts-error", e, None, cx))
                    .child(div().child(retry))
                    .into_any_element();
            }
            Load::Ready(rows) => rows.clone(),
        };
        let selected = self.state.prompts.selected.clone();
        let mut col = div().id("prompt-list").flex_1().min_h_0().overflow_y_scroll().px_2().pb_4().flex().flex_col();
        for group in GROUPS {
            let items: Vec<&PromptSummary> = rows.iter().filter(|r| r.group == group).collect();
            if items.is_empty() {
                continue;
            }
            col = col.child(div().px_2().pt_4().pb_1().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(group_label(group)));
            for row in items {
                let id = row.id.clone();
                let chips = match (row.stale, row.scope) {
                    (true, _) => chip(t, "update", ChipKind::Update),
                    (_, PromptScope::Project) => chip(t, "project", ChipKind::Edited),
                    (_, PromptScope::Global) => chip(t, "edited", ChipKind::Edited),
                    (_, PromptScope::Default) => chip(t, "default", ChipKind::Quiet),
                };
                col = col.child(
                    ui::row(t, SharedString::from(format!("prompt-{}", row.id)), selected.as_ref() == Some(&row.id))
                        .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().child(row.title.clone()))
                        .child(chips)
                        .on_click(cx.listener(move |this, _, _, cx| this.select_prompt(id.clone(), cx))),
                );
            }
        }
        col.into_any_element()
    }

    fn prompt_detail(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let d = match &self.state.prompts.detail {
            Load::Idle => {
                return ui::empty(t, "Pick a prompt", "Each one says when fleetd sends it. Edit it here; the default stays one click away.")
                    .into_any_element();
            }
            Load::Loading => return ui::loading(t, "Loading…").into_any_element(),
            Load::Failed(e) => {
                let e = e.clone();
                return div().p_4().child(self.error_line("copy-prompt-error", e, None, cx)).into_any_element();
            }
            Load::Ready(d) => d.clone(),
        };
        let project = self.state.prompts.project.clone();
        let project_name = project.as_ref().map(|k| self.state.project(k).map_or(k.1.clone(), |r| r.summary.title.to_string()));
        let scope = edit_scope(&d, project.as_ref());
        let in_effect = match d.scope {
            PromptScope::Default => "In effect: fleetd's default.".to_string(),
            PromptScope::Global => "In effect: your hub-wide edit.".to_string(),
            PromptScope::Project => format!("In effect: your edit for {}.", project_name.clone().unwrap_or_default()),
        };
        let lands = match (scope, &project_name) {
            (PromptScope::Project, Some(name)) => format!("Saving changes it for {name} only."),
            _ if project.is_some() => "This prompt has one hub-wide text: saving changes it for every project.".to_string(),
            _ => "Saving changes it for every project without its own edit.".to_string(),
        };
        let mut tabs: Vec<(Tab, &'static str)> = vec![(Tab::Edit, "Edit"), (Tab::Compare, "Compare with default")];
        if d.stale.is_some() {
            tabs.push((Tab::Update, "Update"));
        }
        let tab = self.prompts_ui.tab;
        let this = cx.entity().downgrade();
        let tabs = crate::settings::segmented(t, "prompt-tab", &tabs, tab, move |tab, _, cx| {
            this.update(cx, |s, cx| {
                s.prompts_ui.tab = tab;
                cx.notify();
            })
            .ok();
        });
        let head = div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap_3()
                    .child(div().font_weight(STRONG).child(d.title.clone()))
                    .child(div().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(d.id.to_string())),
            )
            .child(div().text_color(t.quiet).whitespace_normal().child(format!("Sent {}.", d.sent_when.trim_end_matches('.'))))
            .child(div().text_color(t.quiet).whitespace_normal().child(format!("{in_effect} {lands}")));
        let stale_note = d.stale.as_ref().filter(|_| tab != Tab::Update).map(|_| {
            div()
                .flex()
                .items_start()
                .gap_2()
                .child(ui::dot(t.warning))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .whitespace_normal()
                        .child("fleetd's default changed since you edited this. Your text stays in effect until you save it again."),
                )
                .child(ui::button(t, "prompt-see-update", "Review the update", Variant::Secondary, true).on_click(cx.listener(|this, _, _, cx| {
                    this.prompts_ui.tab = Tab::Update;
                    cx.notify();
                })))
        });
        let body = match tab {
            Tab::Edit => self.prompt_edit(&d, scope, cx),
            Tab::Compare => self.prompt_compare(&d, cx),
            Tab::Update => self.prompt_update(&d, cx),
        };
        div()
            .id("prompt-detail")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px_6()
            .py_4()
            .flex()
            .flex_col()
            .gap_4()
            .child(head)
            .children(stale_note)
            .child(div().flex().child(tabs))
            .child(body)
            .into_any_element()
    }

    fn prompt_edit(&mut self, d: &PromptDetail, scope: PromptScope, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let text = self.prompts_ui.editor.read(cx).text().to_string();
        let mut placeholders = div().flex().flex_col().gap_0p5();
        for p in &d.placeholders {
            let token = format!("{{{{{}}}}}", p.name);
            let insert = token.clone();
            let present = text.contains(&token);
            placeholders = placeholders.child(
                div()
                    .flex()
                    .items_start()
                    .gap_2()
                    .text_size(px(size::XS))
                    .child(
                        ui::clickable(t, div().id(SharedString::from(format!("ph-{}", p.name))))
                            .flex_none()
                            .px_1p5()
                            .rounded(px(radius::SM))
                            .bg(t.selected)
                            .font_family(t.mono_font.clone())
                            .text_size(px(size::SM))
                            .hover(|s| s.underline())
                            .child(token)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let editor = this.prompts_ui.editor.clone();
                                editor.update(cx, |i, cx| i.insert(&insert, cx));
                                window.focus(&editor.read(cx).focus_handle(cx), cx);
                            })),
                    )
                    .child(div().flex_none().text_color(t.quiet).child(match (p.required, present) {
                        (true, false) => "required, missing",
                        (true, true) => "required",
                        (false, _) => "optional",
                    }))
                    .child(div().flex_1().min_w_0().whitespace_normal().text_color(t.quiet).child(p.description.clone())),
            );
        }
        let warnings = self.warnings_block(&text, cx);
        let busy = self.state.prompts.busy;
        let changed = text != d.effective.text;
        let save = ui::button(t, "prompt-save", if busy { "Saving…" } else { "Save" }, Variant::Primary, changed && !text.is_empty() && !busy).when(
            changed && !text.is_empty() && !busy,
            |b| {
                b.on_click(cx.listener(|this, _, _, cx| {
                    let text = this.prompts_ui.editor.read(cx).text().to_string();
                    let out = this.state.prompt_save(&text);
                    this.send_prompts(out, cx);
                }))
            },
        );
        let can_reset = has_override(d, scope) && !busy;
        let reset = ui::button(t, "prompt-reset", "Reset to default", Variant::Secondary, can_reset).when(can_reset, |b| {
            b.on_click(cx.listener(|this, _, _, cx| {
                let out = this.state.prompt_reset();
                this.send_prompts(out, cx);
            }))
        });
        let undo = ui::button(t, "prompt-revert", "Discard changes", Variant::Ghost, changed && !busy).when(changed && !busy, |b| {
            b.on_click(cx.listener(|this, _, _, cx| {
                if let Some(text) = this.state.prompts.detail.ready().map(|d| d.effective.text.clone()) {
                    this.prompts_ui.editor.update(cx, |i, cx| i.set_text(&text, cx));
                }
                cx.notify();
            }))
        });
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.prompts_ui.editor.clone())
            .child(warnings)
            .child(self.prompt_actions(vec![save, reset, undo], self.state.prompts.echo.clone(), cx))
            .when(!d.placeholders.is_empty(), |c| {
                c.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child("Placeholders: click one to insert it"))
                        .child(placeholders),
                )
            })
            .into_any_element()
    }

    fn prompt_actions(&self, buttons: Vec<Stateful<Div>>, echo: Option<Echo>, cx: &mut Context<Self>) -> Div {
        let t = theme(cx);
        div().flex().items_center().gap_2().children(buttons).when_some(echo, |d, e| {
            d.child(
                div().flex_1().min_w_0().whitespace_normal().text_size(px(size::XS)).text_color(if e.ok { t.quiet } else { t.danger }).child(e.text),
            )
        })
    }

    /// The warnings for `text`: from the dry run once it answered for this exact text, else the last ones known.
    fn warnings_block(&self, text: &str, cx: &mut Context<Self>) -> Div {
        let t = theme(cx);
        let (for_text, warnings) = match &self.state.prompts.checked {
            Some((checked, w)) => (checked.as_str() == text, w.clone()),
            None => (false, Vec::new()),
        };
        let mut col = div().flex().flex_col().gap_1();
        if warnings.is_empty() {
            return col.child(div().text_size(px(size::XS)).text_color(t.quiet).child(if for_text { "No warnings." } else { "Checking…" }));
        }
        for w in &warnings {
            col = col.child(
                div()
                    .flex()
                    .items_start()
                    .gap_2()
                    .child(ui::dot(t.warning))
                    .child(div().flex_1().min_w_0().whitespace_normal().child(warning_line(w))),
            );
        }
        col.child(div().pl(px(15.)).text_size(px(size::XS)).text_color(t.quiet).child("Warnings never stop a save."))
    }

    fn prompt_compare(&mut self, d: &PromptDetail, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let text = self.prompts_ui.editor.read(cx).text().to_string();
        if text == d.default.text {
            return div().text_color(t.quiet).child("Same as fleetd's default.").into_any_element();
        }
        let (view, (added, removed)) = self.diff_view("compare", &d.default.text, &text, cx);
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_size(px(size::XS)).text_color(t.quiet).child(format!(
                "fleetd's default ({}) → the text in the editor: {added} line{} added, {removed} removed.",
                d.default.r#ref,
                if added == 1 { "" } else { "s" }
            )))
            .child(diff_box(t, view, 460.))
            .into_any_element()
    }

    fn prompt_update(&mut self, d: &PromptDetail, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let Some(stale) = d.stale.clone() else { return div().into_any_element() };
        let caption = |text: String| div().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(text);
        let mut col = div().flex().flex_col().gap_2();
        match &stale.base {
            Some(base) => {
                let (theirs, _) = self.diff_view("theirs", &base.text, &stale.current.text, cx);
                let (mine, _) = self.diff_view("mine", &base.text, &stale.yours.text, cx);
                col = col
                    .child(caption(format!("What fleetd changed: {} → {}", base.r#ref, stale.current.r#ref)))
                    .child(diff_box(t, theirs, 180.))
                    .child(caption(format!("What you changed: {} → yours", base.r#ref)))
                    .child(diff_box(t, mine, 180.));
            }
            None => {
                let (view, _) = self.diff_view("theirs", &stale.current.text, &stale.yours.text, cx);
                col = col
                    .child(
                        div()
                            .text_color(t.quiet)
                            .whitespace_normal()
                            .child("This edit has no record of the default it started from, so only the new default and yours can be compared."),
                    )
                    .child(caption(format!("New default {} → yours", stale.current.r#ref)))
                    .child(diff_box(t, view, 260.));
            }
        }
        let merged_text = self.prompts_ui.merged.read(cx).text().to_string();
        let conflicts = merged_text.contains("<<<<<<<");
        let busy = self.state.prompts.busy;
        let save = ui::button(t, "update-save", if busy { "Saving…" } else { "Save merged" }, Variant::Primary, !busy && !merged_text.is_empty())
            .when(!busy && !merged_text.is_empty(), |b| {
                b.on_click(cx.listener(|this, _, _, cx| {
                    let text = this.prompts_ui.merged.read(cx).text().to_string();
                    let out = this.state.prompt_save(&text);
                    this.send_prompts(out, cx);
                }))
            });
        let yours = stale.yours.text.clone();
        let keep = ui::button(t, "update-keep", "Keep mine", Variant::Secondary, !busy).when(!busy, |b| {
            b.on_click(cx.listener(move |this, _, _, cx| {
                let out = this.state.prompt_save(&yours);
                this.send_prompts(out, cx);
            }))
        });
        let take = ui::button(t, "update-default", "Use the new default", Variant::Secondary, !busy).when(!busy, |b| {
            b.on_click(cx.listener(|this, _, _, cx| {
                let out = this.state.prompt_reset();
                this.send_prompts(out, cx);
            }))
        });
        col =
            col.child(caption("Merged: both changes, editable".to_string()))
                .when(conflicts, |c| {
                    c.child(div().flex().items_start().gap_2().child(ui::dot(t.warning)).child(
                        div().flex_1().whitespace_normal().child(
                            "Both changed the same lines. Pick between the <<<<<<< and >>>>>>> markers; they are saved as written if left in.",
                        ),
                    ))
                })
                .child(self.prompts_ui.merged.clone())
                .child(self.prompt_actions(vec![save, keep, take], self.state.prompts.echo.clone(), cx))
                .child(self.warnings_block(&merged_text, cx))
                .child(
                    div()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .whitespace_normal()
                        .child("Keep mine marks your text as up to date with this default. Use the new default drops your edit at this level."),
                );
        col.into_any_element()
    }
}

impl Shell {
    /// `FLEETD_SCREEN=prompts[+compare|+update|+project|+picker]` and `instructions`, for screenshots.
    pub(crate) fn bench_prompts(&mut self, base: &str, extra: &str, cx: &mut Context<Self>) {
        let storefront: ProjectKey = ("devbox".into(), "storefront".into());
        self.go(crate::shell::Screen::Settings);
        if base == "instructions" {
            self.settings_section = crate::settings::Section::Instructions;
            return self.open_instructions(Some(storefront), cx);
        }
        self.settings_section = crate::settings::Section::Prompts;
        let project = (extra == "project").then_some(storefront);
        self.open_prompts(project, cx);
        self.select_prompt(PromptId::unchecked(if extra == "project" { "task.brief.write" } else { "lead.start" }), cx);
        self.prompts_ui.tab = match extra {
            "compare" => Tab::Compare,
            "update" => Tab::Update,
            _ => Tab::Edit,
        };
        if extra == "picker" {
            self.prompts_ui.picker = Some("prompts-for");
        }
    }

    /// `FLEETD_SCREEN=order+told` (the lead) and `order+told-task` (T31).
    pub(crate) fn bench_told(&mut self, task: bool, cx: &mut Context<Self>) {
        let (thread, who) = if task { ("s-31", "T31") } else { ("lead-storefront", "the lead") };
        let thread = ThreadRef { machine_id: MachineId::unchecked("devbox"), thread_id: ThreadId::unchecked(thread) };
        self.open_told(thread, who.into(), cx);
    }
}

fn diff_box(t: &Theme, view: Entity<DiffView>, h: f32) -> Div {
    div().h(px(h)).flex_none().rounded(px(radius::SM)).border_1().border_color(t.hairline).overflow_hidden().child(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::PromptHub;

    /// A state connected to the bench's fake hub, which answers prompt calls the way the hub's tools do.
    struct Rig {
        state: State,
        hub: PromptHub,
        sent: Vec<(String, serde_json::Value)>,
    }

    impl Rig {
        fn new() -> Self {
            let mut state = State::default();
            state.conn = Conn::Live;
            Self { state, hub: PromptHub::new(), sent: Vec::new() }
        }

        /// Answers `out` and everything it leads to.
        fn run(&mut self, out: Out) {
            let mut queue: VecDeque<AppClientMessage> = out.into();
            while let Some(m) = queue.pop_front() {
                if let AppClientMessage::Call { tool, input, .. } = &m {
                    self.sent.push((tool.to_string(), input.clone()));
                }
                if let Some(reply) = self.hub.answer(&m) {
                    queue.extend(self.state.apply(Incoming::Message(reply)));
                }
            }
        }

        fn tools(&self) -> Vec<&str> {
            self.sent.iter().map(|(t, _)| t.as_str()).collect()
        }
    }

    fn storefront() -> ProjectKey {
        ("devbox".into(), "storefront".into())
    }

    #[test]
    fn a_project_shows_its_own_edits_and_an_answer_for_the_previous_project_is_dropped() {
        let mut r = Rig::new();
        let hub_wide = r.state.prompts_open(None);
        // Switch before the hub-wide list lands: its answer must not overwrite the project's.
        let project = r.state.prompts_open(Some(storefront()));
        r.run(project);
        r.run(hub_wide);
        let list = r.state.prompts.list.ready().expect("listed");
        let brief = list.iter().find(|p| p.id.as_str() == "task.brief.write").unwrap();
        assert_eq!(brief.scope, PromptScope::Project, "storefront's own brief edit");
        assert_eq!(r.sent[0].1["projectRef"]["projectId"], "storefront");
        assert!(r.sent[1].1.get("projectRef").is_none(), "hub-wide asks without a project");
    }

    #[test]
    fn saving_sends_the_default_it_was_edited_from_keeps_the_warnings_and_refetches() {
        let mut r = Rig::new();
        let out = r.state.prompts_open(Some(storefront()));
        r.run(out);
        let out = r.state.prompt_select(PromptId::unchecked("review.reviewer"));
        r.run(out);
        let d = r.state.prompts.detail.ready().unwrap().clone();
        assert_eq!(edit_scope(&d, Some(&storefront())), PromptScope::Project);
        r.sent.clear();
        // Drops a prompt-only safety rule: the hub warns, and the edit is saved anyway.
        let text = d.effective.text.replace("Do not read the PR description or its comments", "Read the PR description first");
        assert_ne!(text, d.effective.text);
        let out = r.state.prompt_save(&text);
        r.run(out);
        let (tool, input) = &r.sent[0];
        assert_eq!(tool, "prompt_set");
        assert_eq!(input["scope"], "project");
        assert_eq!(input["base"], d.default.r#ref.as_str());
        assert!(input.get("dryRun").is_none());
        assert_eq!(r.tools()[1..], ["prompts_list", "prompt_get"]);
        let (checked, warnings) = r.state.prompts.checked.clone().unwrap();
        assert_eq!(checked, text);
        assert!(warnings.iter().any(|w| w.rule.as_deref() == Some("independent") && w.enforced == Some(Enforcement::Prompt)));
        let after = r.state.prompts.detail.ready().unwrap();
        assert_eq!((after.scope, after.effective.text.as_str()), (PromptScope::Project, text.as_str()));
        assert!(r.state.prompts.echo.as_ref().is_some_and(|e| e.ok && e.text.contains("1 warning")));
    }

    #[test]
    fn a_hub_wide_only_prompt_saves_hub_wide_even_with_a_project_picked() {
        let mut r = Rig::new();
        let out = r.state.prompts_open(Some(storefront()));
        r.run(out);
        let out = r.state.prompt_select(PromptId::unchecked("router"));
        r.run(out);
        r.sent.clear();
        let out = r.state.prompt_save("Pick a project for {{intent}} from {{projects}}.");
        r.run(out);
        assert_eq!(r.sent[0].1["scope"], "global");
        assert!(r.sent[0].1.get("projectRef").is_none());
    }

    #[test]
    fn only_the_latest_dry_run_sets_the_warnings() {
        let mut r = Rig::new();
        let out = r.state.prompt_select(PromptId::unchecked("task.brief.write"));
        r.run(out);
        let first = r.state.prompt_check("no placeholders at all");
        let second = r.state.prompt_check("{{taskId}} {{task}} {{areas}} {{branch}} {{serves}}");
        assert_eq!(second.len(), 1);
        r.run(second);
        r.run(first);
        let (text, warnings) = r.state.prompts.checked.clone().unwrap();
        assert!(text.starts_with("{{taskId}}"));
        assert!(!warnings.iter().any(|w| w.code == PromptWarningCode::PlaceholderMissing));
        let AppClientMessage::Call { input, .. } = &r.state.prompt_check("x")[0] else { panic!() };
        assert_eq!(input["dryRun"], true);
    }

    #[test]
    fn a_dropped_connection_frees_the_save_and_refetches_after_the_next_snapshot() {
        let mut r = Rig::new();
        let out = r.state.prompts_open(None);
        r.run(out);
        let out = r.state.prompt_select(PromptId::unchecked("wake.intent"));
        r.run(out);
        let pending = r.state.prompt_save("- New intent {{workstreamId}}: '{{text}}'.");
        assert!(r.state.prompts.busy && pending.len() == 1);
        r.state.apply(Incoming::Disconnected { reason: "closed".into(), retry_in: Duration::from_secs(1) });
        assert!(!r.state.prompts.busy);
        r.state.conn = Conn::Live;
        let out = r.state.prompts_reconnected();
        let tools: Vec<String> =
            out.iter().filter_map(|m| if let AppClientMessage::Call { tool, .. } = m { Some(tool.to_string()) } else { None }).collect();
        assert_eq!(tools, ["prompts_list", "prompt_get"]);
        assert!(r.state.prompts_reconnected().is_empty(), "once");
    }

    #[test]
    fn a_stale_edit_carries_both_sides_and_saving_the_merge_bases_it_on_the_new_default() {
        let mut r = Rig::new();
        let out = r.state.prompts_open(None);
        r.run(out);
        assert!(r.state.prompts.list.ready().unwrap().iter().any(|p| p.id.as_str() == "lead.start" && p.stale));
        let out = r.state.prompt_select(PromptId::unchecked("lead.start"));
        r.run(out);
        let d = r.state.prompts.detail.ready().unwrap().clone();
        let stale = d.stale.clone().expect("stale");
        assert_eq!(stale.current.r#ref, d.default.r#ref);
        assert!(!stale.merged.contains("<<<<<<<"), "the fixture's two edits touch different lines");
        let out = r.state.prompt_save(&stale.merged);
        r.run(out);
        let list = r.state.prompts.list.ready().unwrap();
        assert!(!list.iter().any(|p| p.id.as_str() == "lead.start" && p.stale), "saved on the new default: no longer stale");
    }

    #[test]
    fn reset_drops_the_edit_at_the_picked_level() {
        let mut r = Rig::new();
        let out = r.state.prompts_open(Some(storefront()));
        r.run(out);
        let out = r.state.prompt_select(PromptId::unchecked("task.brief.write"));
        r.run(out);
        assert_eq!(r.state.prompts.detail.ready().unwrap().scope, PromptScope::Project);
        let out = r.state.prompt_reset();
        r.run(out);
        let d = r.state.prompts.detail.ready().unwrap();
        assert_eq!(d.scope, PromptScope::Default);
        assert_eq!(d.effective.text, d.default.text);
    }

    #[test]
    fn instructions_save_per_level_and_may_be_emptied() {
        let mut r = Rig::new();
        let out = r.state.instructions_open(Some(storefront()));
        r.run(out);
        let d = r.state.prompts.instructions.ready().unwrap();
        assert!(d.global.is_some() && d.project.is_some());
        let out = r.state.instructions_save(PromptScope::Project, "");
        r.run(out);
        let d = r.state.prompts.instructions.ready().unwrap();
        assert_eq!(d.project.as_ref().map(|p| p.text.as_str()), Some(""));
        assert!(r.state.prompts.instructions_echo.as_ref().is_some_and(|e| e.ok && e.text.contains("storefront")));
    }

    #[test]
    fn the_told_sheet_shows_the_session_it_was_opened_for() {
        let mut r = Rig::new();
        let lead = ThreadRef { machine_id: MachineId::unchecked("devbox"), thread_id: ThreadId::unchecked("lead-storefront") };
        let task = ThreadRef { machine_id: MachineId::unchecked("devbox"), thread_id: ThreadId::unchecked("s-31") };
        let first = r.state.session_prompt(lead, "the lead".into());
        let second = r.state.session_prompt(task.clone(), "T31".into());
        r.run(first);
        r.run(second);
        let told = r.state.prompts.told.as_ref().unwrap();
        assert_eq!(told.thread, task);
        let sp = told.prompt.ready().unwrap();
        assert!(sp.text.starts_with("You are fleetd task T31"));
        assert!(sp.refs.iter().any(|r| r.id.as_str() == INSTRUCTIONS));
    }

    #[test]
    fn the_diff_is_hunks_only_with_its_counts() {
        let text = unified("a\nb\nc\n", "a\nB\nc\nd\n");
        assert!(text.starts_with("@@"), "no header row: the view's rows must all be one line tall");
        assert_eq!(counts(&text), (2, 1));
        assert_eq!(unified("same\n", "same\n"), "");
    }

    #[test]
    fn a_prompt_event_refetches_what_is_open() {
        let mut r = Rig::new();
        let out = r.state.prompts_open(None);
        r.run(out);
        let out = r.state.prompt_select(PromptId::unchecked("router"));
        r.run(out);
        r.sent.clear();
        let event = serde_json::json!({ "seq": 9, "type": "prompt.changed", "at": "2026-10-18T10:00:00.000Z", "summary": "lead.start saved",
            "data": { "id": "router", "scope": "global" } });
        let out = r.state.apply(Incoming::Message(fleetd_contracts::app::AppServerMessage::Event(serde_json::from_value(event).unwrap())));
        r.run(out);
        assert_eq!(r.tools(), ["prompts_list", "prompt_get"]);
    }
}
