//! The composer (spec 2.3): one component, three placements. Docked at the top of the board for new orders
//! (focused on launch and by ⌘N), floating over the order view for a new order without losing your place, and
//! the order view's follow-up box. Where above the box (project, type), what inside, how below (attach,
//! mention, keys). Enter sends and keeps focus; Shift+Enter adds a line; in the follow-up, ⌘Enter steers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use fleetd_contracts::ledger::PlaybookName;
use gpui::{
    App, ClipboardEntry, Context, Entity, EventEmitter, ExternalPaths, FocusHandle, Focusable, KeyBinding, Modifiers, ModifiersChangedEvent,
    PathPromptOptions, SharedString, Subscription, Task, Window, actions, div, prelude::*, px,
};

use crate::input::{InputEvent, TextInput};
use crate::state::{ProjectKey, Upload};
use crate::theme::{STRONG, Theme, metric, size, theme};
use crate::ui::{self, Variant};
use fleetd_contracts::mcp::IntakeRef;

/// The hub's limit on an order's text (IntakeText).
pub const MAX_BYTES: usize = 4000;
/// A paste longer than this becomes a `pasted-N.txt` attachment (T3's large-paste rule, under the 4000 limit).
pub const PASTE_AS_FILE: usize = 3500;
pub const MAX_ATTACHMENTS: usize = 8;
pub const MAX_ATTACHMENT_BYTES: u64 = 5 * 1024 * 1024;
/// The router guess runs after this pause, for text this long that changed this much since the last guess.
const PREVIEW_PAUSE: Duration = Duration::from_millis(600);
const PREVIEW_MIN_CHARS: usize = 12;
const PREVIEW_MIN_CHANGE: usize = 8;
const FILES_PAUSE: Duration = Duration::from_millis(120);
const MENU_ROWS: usize = 8;

actions!(composer, [MenuPrev, MenuNext, MenuPick, MenuClose, Steer, PasteRich, PickProject, PickTemplate, Attach]);

const CONTEXT: &str = "Composer";
const MENU_CONTEXT: &str = "ComposerMenu";

/// Call after `input::bind_keys`: for the same keys at the same depth, the binding added later wins.
pub fn bind_keys(cx: &mut App) {
    let menu = Some("ComposerMenu > TextInput");
    let field = Some("Composer > TextInput");
    cx.bind_keys([
        KeyBinding::new("up", MenuPrev, menu),
        KeyBinding::new("down", MenuNext, menu),
        KeyBinding::new("enter", MenuPick, menu),
        KeyBinding::new("tab", MenuPick, menu),
        KeyBinding::new("escape", MenuClose, menu),
        KeyBinding::new("secondary-enter", Steer, field),
        KeyBinding::new("secondary-v", PasteRich, field),
        KeyBinding::new("secondary-shift-p", PickProject, Some(CONTEXT)),
        KeyBinding::new("secondary-shift-t", PickTemplate, Some(CONTEXT)),
        KeyBinding::new("secondary-shift-a", Attach, Some(CONTEXT)),
    ]);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    /// New orders, at the top of the board.
    Docked,
    /// New orders, over the order view.
    Floating,
    /// Notes to one order, at the bottom of its view.
    FollowUp,
}

/// What a send carries.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub target: Option<ProjectKey>,
    pub template: Option<PlaybookName>,
    pub text: String,
    pub attachments: Vec<String>,
    pub refs: Vec<IntakeRef>,
}

pub enum ComposerEvent {
    Send(Draft),
    Note {
        draft: Draft,
        urgent: bool,
    },
    /// Esc with nothing open: the docked box blurs, the floating one closes.
    Dismiss,
    /// Wants the router's guess for this text.
    Preview(String),
    /// Wants file paths in this project for the @ menu.
    Files {
        key: ProjectKey,
        query: String,
    },
    Upload {
        local: u64,
        name: String,
        mime: String,
        data_b64: String,
    },
    /// "Add project…" in the project picker, or a folder dropped on the composer.
    AddProject(Option<PathBuf>),
}

/// A project the order can go to.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub key: ProjectKey,
    pub title: SharedString,
    pub machine: SharedString,
    pub machine_offline: bool,
}

/// What the shell tells the composer after every state change.
#[derive(Clone, Debug, Default)]
pub struct Sync {
    pub targets: Vec<Target>,
    /// The project selected on the board or open: the default target.
    pub selected: Option<ProjectKey>,
    pub last_used: Option<ProjectKey>,
    /// The router's guess: the text it was for and where it would go.
    pub guess: Option<(String, Option<ProjectKey>)>,
    pub guessing: bool,
    /// Why Send is off, e.g. "Not connected; retrying in 4 s".
    pub offline: Option<String>,
    pub uploads: HashMap<u64, Upload>,
    /// Mention candidates: open orders (id, title) and PRs (number, url, title).
    pub orders: Vec<(String, String)>,
    pub prs: Vec<(u64, String, String)>,
    pub files: Option<(String, Vec<String>)>,
}

/// Where the project picker's choice came from; the label says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Chosen,
    Prefix,
    Selected,
    Guess,
    LastUsed,
    Any,
}

#[derive(Clone, Debug, PartialEq)]
enum Menu {
    Project {
        selected: usize,
    },
    Template {
        selected: usize,
    },
    /// `start` is the byte offset of the `@`.
    Mention {
        start: usize,
        query: String,
        selected: usize,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum MentionItem {
    File(String),
    Order(String, String),
    Pr(u64, String, String),
}

impl MentionItem {
    fn readable(&self) -> String {
        match self {
            MentionItem::File(path) => format!("`{path}`"),
            MentionItem::Order(id, _) => id.clone(),
            MentionItem::Pr(n, ..) => format!("#{n}"),
        }
    }

    fn chip(&self) -> String {
        match self {
            MentionItem::File(path) => path.rsplit('/').next().unwrap_or(path).to_string(),
            MentionItem::Order(id, _) => id.clone(),
            MentionItem::Pr(n, ..) => format!("#{n}"),
        }
    }

    fn to_ref(&self) -> Option<IntakeRef> {
        Some(match self {
            MentionItem::File(path) => IntakeRef::File { path: fleetd_contracts::prim::Text::new(path.as_str()).ok()? },
            MentionItem::Order(id, _) => IntakeRef::Order { workstream_id: fleetd_contracts::ledger::WorkstreamId::new(id).ok()? },
            MentionItem::Pr(_, url, _) => IntakeRef::Pr { url: fleetd_contracts::train::GitHubPrUrl::new(url.as_str()).ok()? },
        })
    }
}

struct Attached {
    local: u64,
    name: String,
    bytes: u64,
}

const TEMPLATES: [PlaybookName; 4] = [PlaybookName::Feature, PlaybookName::Bugfix, PlaybookName::Research, PlaybookName::FinishAll];

pub fn template_label(t: PlaybookName) -> &'static str {
    match t {
        PlaybookName::Feature => "Feature",
        PlaybookName::Bugfix => "Bug",
        PlaybookName::Research => "Research",
        PlaybookName::FinishAll => "Finish everything",
    }
}

/// The type a `fix:`/`bug:`/`research:`/`finish:` prefix asks for (the prefix stays in the text; the hub reads
/// it the same way, `intake/prefix.rs`).
pub fn template_from_prefix(text: &str) -> Option<PlaybookName> {
    let head = text.trim_start().split_once(':')?.0.trim().to_ascii_lowercase();
    match head.as_str() {
        "fix" | "bug" | "bugfix" => Some(PlaybookName::Bugfix),
        "research" => Some(PlaybookName::Research),
        "finish" => Some(PlaybookName::FinishAll),
        "feature" | "feat" => Some(PlaybookName::Feature),
        _ => None,
    }
}

/// The `@query` the caret is in, if any: an `@` at the start or after whitespace, then no whitespace up to the
/// caret. Returns the `@`'s offset and the query.
pub fn mention_at(text: &str, caret: usize) -> Option<(usize, &str)> {
    let before = text.get(..caret)?;
    let at = before.rfind('@')?;
    let query = &before[at + 1..];
    let starts_word = at == 0 || before[..at].ends_with(char::is_whitespace);
    (starts_word && !query.contains(char::is_whitespace)).then_some((at, query))
}

/// A leading `@<project> ` picks the project, as the hub's prefix parser does.
pub fn project_prefix<'a>(text: &str, targets: &'a [Target]) -> Option<&'a Target> {
    let rest = text.strip_prefix('@')?;
    let (name, _) = rest.split_once(char::is_whitespace)?;
    targets.iter().find(|t| t.key.1 == name || t.title == name)
}

/// How many characters differ between two texts, ignoring their common start and end.
pub fn changed_chars(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..].iter().rev().zip(b[prefix..].iter().rev()).take_while(|(x, y)| x == y).count();
    a.len().max(b.len()) - prefix - suffix
}

/// Why an order can't be sent as typed, if it can't.
pub fn check(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write the order first.".into());
    }
    if text.len() > MAX_BYTES {
        return Err(format!("Orders are at most {MAX_BYTES} bytes; this one is {}. Attach the detail as a file.", text.len()));
    }
    Ok(text)
}

/// The mime type the hub takes for a file, from its name and first bytes; None when it isn't an image, text or PDF.
pub fn mime_for(name: &str, head: &[u8]) -> Option<&'static str> {
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "pdf" => Some("application/pdf"),
        _ if std::str::from_utf8(head).is_ok() || std::str::from_utf8(&head[..head.len().saturating_sub(3)]).is_ok() => Some("text/plain"),
        _ => None,
    }
}

pub fn fmt_bytes(n: u64) -> String {
    match n {
        0..1024 => format!("{n} B"),
        1024..1_048_576 => format!("{} KB", n / 1024),
        _ => format!("{:.1} MB", n as f64 / 1_048_576.),
    }
}

pub struct Composer {
    placement: Placement,
    input: Entity<TextInput>,
    sync: Sync,
    /// The user picked a project (None = "Any project: the hub picks"); otherwise it follows `Source`'s order.
    chosen: Option<Option<ProjectKey>>,
    template: Option<PlaybookName>,
    menu: Option<Menu>,
    attached: Vec<Attached>,
    refs: Vec<(IntakeRef, String)>,
    error: Option<String>,
    steer_held: bool,
    /// The follow-up's order id, for its placeholder.
    order: Option<SharedString>,
    next_local: u64,
    last_preview: String,
    pasted: usize,
    _preview: Option<Task<()>>,
    _files: Option<Task<()>>,
    _sub: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Composer {
    pub fn new(placement: Placement, cx: &mut Context<Self>) -> Self {
        let placeholder = match placement {
            Placement::FollowUp => "Add to this order: the lead reads it at its next wake.",
            _ => "What should the fleet do?",
        };
        let input = cx.new(|cx| TextInput::new(cx).placeholder(placeholder).multi_line(8).borderless());
        let sub = cx.subscribe(&input, |this, _, event: &InputEvent, cx| match event {
            InputEvent::Submit => this.send(false, cx),
            InputEvent::Cancel if this.menu.is_some() => {
                this.menu = None;
                cx.notify();
            }
            InputEvent::Cancel => cx.emit(ComposerEvent::Dismiss),
            InputEvent::Changed => this.on_changed(cx),
            InputEvent::TooLong => {}
        });
        Self {
            placement,
            input,
            sync: Sync::default(),
            chosen: None,
            template: None,
            menu: None,
            attached: Vec::new(),
            refs: Vec::new(),
            error: None,
            steer_held: false,
            order: None,
            next_local: 0,
            last_preview: String::new(),
            pasted: 0,
            _preview: None,
            _files: None,
            _sub: sub,
        }
    }

    /// Aims a follow-up composer at an order: its placeholder names it.
    pub fn set_order(&mut self, workstream_id: &str, cx: &mut Context<Self>) {
        if self.order.as_deref() == Some(workstream_id) {
            return;
        }
        self.order = Some(workstream_id.to_string().into());
        let placeholder = format!("Add to {workstream_id}: the lead reads it at its next wake. {} to interrupt it now.", steer_keys());
        self.input.update(cx, |i, cx| {
            *i = std::mem::replace(i, TextInput::new(cx)).placeholder(placeholder);
            cx.notify();
        });
    }

    pub fn set_sync(&mut self, sync: Sync, cx: &mut Context<Self>) {
        self.sync = sync;
        cx.notify();
    }

    /// Picks a project explicitly (the palette's "New order in …", or Reorder).
    pub fn choose(&mut self, key: Option<ProjectKey>, cx: &mut Context<Self>) {
        self.chosen = Some(key);
        cx.notify();
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.input.update(cx, |i, cx| i.set_text(text, cx));
    }

    /// The project the order goes to, and why.
    pub fn target(&self, cx: &App) -> (Option<ProjectKey>, Source) {
        if let Some(chosen) = &self.chosen {
            return (chosen.clone(), if chosen.is_some() { Source::Chosen } else { Source::Any });
        }
        if let Some(t) = project_prefix(self.input.read(cx).text(), &self.sync.targets) {
            return (Some(t.key.clone()), Source::Prefix);
        }
        if let Some(key) = &self.sync.selected {
            return (Some(key.clone()), Source::Selected);
        }
        if let Some((_, Some(key))) = &self.sync.guess {
            return (Some(key.clone()), Source::Guess);
        }
        match &self.sync.last_used {
            Some(key) => (Some(key.clone()), Source::LastUsed),
            None => (None, Source::Any),
        }
    }

    fn template_now(&self, cx: &App) -> PlaybookName {
        self.template.or_else(|| template_from_prefix(self.input.read(cx).text())).unwrap_or(PlaybookName::Feature)
    }

    fn on_changed(&mut self, cx: &mut Context<Self>) {
        self.error = None;
        let (text, caret) = {
            let i = self.input.read(cx);
            (i.text().to_string(), i.caret())
        };
        // The @ menu follows the caret.
        match mention_at(&text, caret) {
            Some((start, query)) => {
                let query = query.to_string();
                let fresh = !matches!(&self.menu, Some(Menu::Mention { start: s, query: q, .. }) if *s == start && *q == query);
                if fresh {
                    self.menu = Some(Menu::Mention { start, query: query.clone(), selected: 0 });
                    self.want_files(query, cx);
                }
            }
            None if matches!(self.menu, Some(Menu::Mention { .. })) => self.menu = None,
            None => {}
        }
        self.maybe_preview(&text, cx);
        cx.notify();
    }

    /// Asks for the router's guess after a pause, only while the picker is on a guess.
    fn maybe_preview(&mut self, text: &str, cx: &mut Context<Self>) {
        if self.placement == Placement::FollowUp || self.chosen.is_some() || self.sync.selected.is_some() {
            return;
        }
        let trimmed = text.trim();
        if trimmed.chars().count() < PREVIEW_MIN_CHARS
            || changed_chars(trimmed, &self.last_preview) < PREVIEW_MIN_CHANGE
            || project_prefix(text, &self.sync.targets).is_some()
        {
            return;
        }
        let text = trimmed.to_string();
        self._preview = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PREVIEW_PAUSE).await;
            this.update(cx, |this, cx| {
                this.last_preview = text.clone();
                cx.emit(ComposerEvent::Preview(text));
            })
            .ok();
        }));
    }

    fn want_files(&mut self, query: String, cx: &mut Context<Self>) {
        let Some(key) = self.target(cx).0 else { return };
        self._files = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(FILES_PAUSE).await;
            this.update(cx, |_, cx| cx.emit(ComposerEvent::Files { key, query })).ok();
        }));
    }

    fn mention_items(&self) -> Vec<(&'static str, MentionItem)> {
        let Some(Menu::Mention { query, .. }) = &self.menu else { return Vec::new() };
        let matches = |s: &str| query.is_empty() || crate::palette::score(query, s).is_some();
        let mut out = Vec::new();
        if let Some((q, paths)) = &self.sync.files
            && q == query
        {
            out.extend(paths.iter().take(5).map(|p| ("Files", MentionItem::File(p.clone()))));
        }
        out.extend(
            self.sync
                .orders
                .iter()
                .filter(|(id, title)| matches(&format!("{id} {title}")))
                .take(4)
                .map(|(id, t)| ("Orders", MentionItem::Order(id.clone(), t.clone()))),
        );
        out.extend(
            self.sync
                .prs
                .iter()
                .filter(|(n, _, title)| matches(&format!("#{n} {title}")))
                .take(4)
                .map(|(n, url, t)| ("PRs", MentionItem::Pr(*n, url.clone(), t.clone()))),
        );
        out
    }

    fn menu_len(&self) -> usize {
        match &self.menu {
            Some(Menu::Project { .. }) => self.sync.targets.len() + 2,
            Some(Menu::Template { .. }) => TEMPLATES.len(),
            Some(Menu::Mention { .. }) => self.mention_items().len(),
            None => 0,
        }
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let len = self.menu_len();
        if let Some(Menu::Project { selected } | Menu::Template { selected } | Menu::Mention { selected, .. }) = &mut self.menu
            && len > 0
        {
            *selected = (*selected as isize + by).rem_euclid(len as isize) as usize;
        }
        cx.notify();
    }

    fn pick(&mut self, ix: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        match self.menu.clone() {
            Some(Menu::Project { selected }) => {
                let ix = ix.unwrap_or(selected);
                if ix == self.sync.targets.len() + 1 {
                    self.menu = None;
                    cx.emit(ComposerEvent::AddProject(None));
                    return cx.notify();
                }
                self.chosen = Some(if ix == 0 { None } else { self.sync.targets.get(ix - 1).map(|t| t.key.clone()) });
            }
            Some(Menu::Template { selected }) => self.template = TEMPLATES.get(ix.unwrap_or(selected)).copied(),
            Some(Menu::Mention { start, selected, .. }) => {
                let items = self.mention_items();
                let Some((_, item)) = items.get(ix.unwrap_or(selected)).cloned() else {
                    self.menu = None;
                    return cx.notify();
                };
                let caret = self.input.read(cx).caret();
                let readable = format!("{} ", item.readable());
                self.input.update(cx, |i, cx| i.replace_range(start..caret, &readable, cx));
                if let Some(r) = item.to_ref()
                    && !self.refs.iter().any(|(x, _)| x == &r)
                {
                    self.refs.push((r, item.chip()));
                }
            }
            None => return,
        }
        self.menu = None;
        window.focus(&self.input.focus_handle(cx), cx);
        cx.notify();
    }

    fn open_menu(&mut self, menu: Menu, window: &mut Window, cx: &mut Context<Self>) {
        let same = std::mem::discriminant(&menu)
            == self.menu.as_ref().map_or(std::mem::discriminant(&Menu::Template { selected: 0 }), std::mem::discriminant)
            && self.menu.is_some();
        self.menu = if same { None } else { Some(menu) };
        window.focus(&self.input.focus_handle(cx), cx);
        cx.notify();
    }

    fn send(&mut self, urgent: bool, cx: &mut Context<Self>) {
        if self.sync.offline.is_some() {
            return;
        }
        let text = self.input.read(cx).text().to_string();
        let text = match check(&text) {
            Ok(text) => text.to_string(),
            Err(e) => {
                self.error = Some(e);
                return cx.notify();
            }
        };
        let mut attachments = Vec::new();
        for a in &self.attached {
            match self.sync.uploads.get(&a.local) {
                Some(Upload::Done { attachment_id }) => attachments.push(attachment_id.clone()),
                Some(Upload::Failed(e)) => {
                    self.error = Some(format!("{} didn't upload: {e} Remove it to send.", a.name));
                    return cx.notify();
                }
                _ => {
                    self.error = Some(format!("{} is still uploading.", a.name));
                    return cx.notify();
                }
            }
        }
        let draft = Draft {
            target: self.target(cx).0,
            template: Some(self.template_now(cx)),
            text: text.clone(),
            attachments,
            refs: self.refs.iter().map(|(r, _)| r.clone()).collect(),
        };
        self.input.update(cx, |i, cx| {
            i.remember(&text);
            i.clear(cx);
        });
        self.attached.clear();
        self.refs.clear();
        self.template = None;
        self.menu = None;
        self.last_preview.clear();
        cx.emit(match self.placement {
            Placement::FollowUp => ComposerEvent::Note { draft, urgent },
            _ => ComposerEvent::Send(draft),
        });
        cx.notify();
    }

    // ---- attachments -------------------------------------------------------------------------

    /// Where its text field was last painted, in window coordinates (the bench watches it for echoes).
    pub fn field_bounds(&self, cx: &App) -> Option<gpui::Bounds<gpui::Pixels>> {
        self.input.read(cx).bounds()
    }

    /// Types text at the caret, as if from the keyboard (keys pressed while nothing had focus).
    pub fn type_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.input.update(cx, |i, cx| i.insert(text, cx));
    }

    /// Whether `@name` would pick a project yet (the hub has sent the project list).
    pub fn knows_project(&self, name: &str) -> bool {
        self.sync.targets.iter().any(|t| t.key.1 == name || t.title == name)
    }

    /// Sends what is typed, as Enter does.
    pub fn submit(&mut self, cx: &mut Context<Self>) {
        self.send(false, cx);
    }

    /// Attaches dropped files (onto the composer, or onto an order card for its follow-up).
    pub fn attach_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        self.attach_files(paths, cx);
    }

    fn attach_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        for path in paths {
            // A folder isn't an attachment: dropped here, it adds a project.
            if path.is_dir() {
                cx.emit(ComposerEvent::AddProject(Some(path)));
                continue;
            }
            let name = path.file_name().map_or_else(|| "file".into(), |n| n.to_string_lossy().to_string());
            if self.attached.len() >= MAX_ATTACHMENTS {
                self.error = Some(format!("At most {MAX_ATTACHMENTS} attachments per order."));
                break;
            }
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if size > MAX_ATTACHMENT_BYTES {
                self.error = Some(format!("{name} is {}; attachments are at most 5 MB.", fmt_bytes(size)));
                continue;
            }
            let local = self.reserve(&name, size);
            cx.spawn(async move |this, cx| {
                let read = cx.background_executor().spawn(async move { std::fs::read(&path) }).await;
                this.update(cx, |this, cx| match read {
                    Ok(bytes) => this.upload(local, name, bytes, cx),
                    Err(e) => {
                        this.attached.retain(|a| a.local != local);
                        this.error = Some(format!("Couldn't read {name}: {e}."));
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
        cx.notify();
    }

    fn reserve(&mut self, name: &str, bytes: u64) -> u64 {
        self.next_local += 1;
        self.attached.push(Attached { local: self.next_local, name: name.to_string(), bytes });
        self.next_local
    }

    fn upload(&mut self, local: u64, name: String, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let Some(mime) = mime_for(&name, &bytes[..bytes.len().min(1024)]) else {
            self.attached.retain(|a| a.local != local);
            self.error = Some(format!("{name}: only images, text and PDF files attach."));
            return cx.notify();
        };
        let data_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        cx.emit(ComposerEvent::Upload { local, name, mime: mime.to_string(), data_b64 });
        cx.notify();
    }

    fn prompt_attach(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: Some("Attach".into()) });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                this.update(cx, |this, cx| this.attach_files(paths, cx)).ok();
            }
        })
        .detach();
    }

    /// ⌘V: images and files attach, a long text becomes `pasted-N.txt`, anything else is typed.
    fn paste(&mut self, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else { return };
        for entry in item.entries() {
            match entry {
                ClipboardEntry::Image(image) => {
                    let ext = match image.format {
                        gpui::ImageFormat::Jpeg => "jpg",
                        gpui::ImageFormat::Webp => "webp",
                        gpui::ImageFormat::Gif => "gif",
                        _ => "png",
                    };
                    self.pasted += 1;
                    let name = format!("pasted-{}.{ext}", self.pasted);
                    let local = self.reserve(&name, image.bytes.len() as u64);
                    self.upload(local, name, image.bytes.clone(), cx);
                    return;
                }
                ClipboardEntry::ExternalPaths(paths) => return self.attach_files(paths.paths().to_vec(), cx),
                ClipboardEntry::String(_) => {}
            }
        }
        let Some(text) = item.text() else { return };
        if text.len() > PASTE_AS_FILE {
            self.pasted += 1;
            let name = format!("pasted-{}.txt", self.pasted);
            let local = self.reserve(&name, text.len() as u64);
            self.upload(local, name, text.into_bytes(), cx);
        } else {
            self.input.update(cx, |i, cx| i.insert(&text, cx));
        }
    }

    // ---- render --------------------------------------------------------------------------------

    fn target_line(&self, t: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let (key, source) = self.target(cx);
        let target = key.as_ref().and_then(|k| self.sync.targets.iter().find(|tg| &tg.key == k));
        let title = match (&key, target) {
            (None, _) => "Any project".to_string(),
            (Some(_), Some(tg)) => tg.title.to_string(),
            (Some(k), None) => k.1.clone(),
        };
        let why = match source {
            Source::Guess => Some("guess"),
            Source::LastUsed => Some("last used"),
            Source::Any if self.chosen.is_none() => Some("the hub picks"),
            _ => None,
        };
        let guessing = self.sync.guessing && self.chosen.is_none() && self.sync.selected.is_none();
        let machine = target.map(|tg| {
            if tg.machine_offline {
                div().text_color(t.warning).child(format!("{} offline: queued until it's back", tg.machine))
            } else {
                div().flex().items_center().gap_1().child(format!("on {}", tg.machine))
            }
        });
        let template = self.template_now(cx);
        div()
            .flex()
            .items_center()
            .gap_2()
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .child("to")
            .child(picker(t, "pick-project", format!("{title} ▾")).on_click(cx.listener(|this, _, window, cx| {
                let selected = this.target(cx).0.and_then(|k| this.sync.targets.iter().position(|t| t.key == k)).map_or(0, |i| i + 1);
                this.open_menu(Menu::Project { selected }, window, cx);
            })))
            .children(machine)
            .when_some(why, |d, why| d.child(format!("· {why}")))
            .when(guessing, |d| d.child("· guessing…"))
            .child(div().w(px(24.)))
            .child(picker(t, "pick-template", format!("{} ▾", template_label(template))).on_click(cx.listener(|this, _, window, cx| {
                let selected = TEMPLATES.iter().position(|x| Some(*x) == this.template).unwrap_or(0);
                this.open_menu(Menu::Template { selected }, window, cx);
            })))
            .child(div().flex_1())
            .child(ui::kbd(t, format!("{} project · {} type", ui::shortcut("⇧P"), ui::shortcut("⇧T"))))
    }

    fn menu_list(&self, t: &Theme, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let menu = self.menu.as_ref()?;
        let mut list = div().id("composer-menu").max_h(px(metric::ROW * MENU_ROWS as f32 + 8.)).overflow_y_scroll().p_1().flex().flex_col();
        let row = |ix: usize, selected: bool, label: String, detail: String, cx: &mut Context<Self>| {
            ui::row(t, ("composer-menu-row", ix), selected)
                // Rows keep their height in a long list; the menu scrolls instead of squashing them.
                .flex_none()
                .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().child(label))
                .child(div().text_size(px(size::XS)).text_color(t.quiet).child(detail))
                .on_click(cx.listener(move |this, _, window, cx| this.pick(Some(ix), window, cx)))
        };
        match menu {
            Menu::Project { selected } => {
                list = list.child(row(0, *selected == 0, "Any project".into(), "the hub picks".into(), cx));
                for (i, tg) in self.sync.targets.iter().enumerate() {
                    let detail = if tg.machine_offline { format!("{} offline", tg.machine) } else { tg.machine.to_string() };
                    list = list.child(row(i + 1, *selected == i + 1, tg.title.to_string(), detail, cx));
                }
                let add = self.sync.targets.len() + 1;
                list = list.child(row(add, *selected == add, "Add project…".into(), "a GitHub repo or a folder".into(), cx));
            }
            Menu::Template { selected } => {
                for (i, tp) in TEMPLATES.iter().enumerate() {
                    let detail = match tp {
                        PlaybookName::Feature => "build something",
                        PlaybookName::Bugfix => "fix: prefix",
                        PlaybookName::Research => "research: prefix",
                        PlaybookName::FinishAll => "finish: prefix",
                    };
                    list = list.child(row(i, *selected == i, template_label(*tp).into(), detail.into(), cx));
                }
            }
            Menu::Mention { selected, .. } => {
                let items = self.mention_items();
                if items.is_empty() {
                    list =
                        list.child(div().h(px(metric::ROW)).px_2().flex().items_center().text_color(t.quiet).child("No files, orders or PRs match."));
                }
                let mut group = "";
                for (i, (g, item)) in items.into_iter().enumerate() {
                    if g != group {
                        group = g;
                        list = list.child(div().px_2().pt_1().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(g));
                    }
                    let (label, detail) = match &item {
                        MentionItem::File(p) => (p.clone(), String::new()),
                        MentionItem::Order(id, title) => (format!("{id} {title}"), String::new()),
                        MentionItem::Pr(n, _, title) => (format!("#{n} {title}"), String::new()),
                    };
                    list = list.child(row(i, *selected == i, label, detail, cx));
                }
            }
        }
        Some(div().mt_1().child(ui::floating(t).child(list)))
    }

    fn chips(&self, t: &Theme, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        if self.attached.is_empty() && self.refs.is_empty() {
            return None;
        }
        let mut row = div().flex().flex_wrap().items_center().gap_3().text_size(px(size::XS)).text_color(t.quiet);
        for a in &self.attached {
            let local = a.local;
            let (label, color) = match self.sync.uploads.get(&local) {
                Some(Upload::Done { .. }) => (format!("{} {}", a.name, fmt_bytes(a.bytes)), t.quiet),
                Some(Upload::Failed(_)) => (format!("{} failed", a.name), t.danger),
                _ => (format!("{} uploading {}", a.name, fmt_bytes(a.bytes)), t.quiet),
            };
            row = row.child(chip(t, ("attached", local as usize), label, color).on_click(cx.listener(move |this, _, _, cx| {
                this.attached.retain(|a| a.local != local);
                cx.notify();
            })));
        }
        for (i, (_, label)) in self.refs.iter().enumerate() {
            row = row.child(chip(t, ("ref", i), label.clone(), t.quiet).on_click(cx.listener(move |this, _, _, cx| {
                if i < this.refs.len() {
                    this.refs.remove(i);
                }
                cx.notify();
            })));
        }
        Some(row)
    }

    fn footer(&self, t: &Theme, can_send: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let follow_up = self.placement == Placement::FollowUp;
        let keys = if follow_up {
            format!("Enter add · {} steer now · {} new order", steer_keys(), ui::shortcut("N"))
        } else {
            "Enter send · ⇧Enter newline".to_string()
        };
        let label = match (follow_up, self.steer_held) {
            (true, true) => "Steer",
            (true, false) => "Add",
            (false, _) => "Send",
        };
        // Steering by mouse too: the lead reads it now instead of at its next wake.
        let steer = follow_up.then(|| {
            let b = ui::button(t, "composer-steer", "Steer now", Variant::Secondary, can_send);
            if can_send { b.on_click(cx.listener(|this, _, _, cx| this.send(true, cx))) } else { b }
        });
        let send = ui::button(t, "composer-send", label, Variant::Primary, can_send);
        let send = if can_send {
            send.on_click(cx.listener(|this, e: &gpui::ClickEvent, _, cx| {
                let urgent = e.modifiers().secondary();
                this.send(urgent, cx)
            }))
        } else {
            send
        };
        div()
            .flex()
            .items_center()
            .gap_3()
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .child(ui::button(t, "composer-attach", "+ attach", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| this.prompt_attach(cx))))
            .child(ui::button(t, "composer-mention", "@ mention", Variant::Ghost, true).on_click(cx.listener(|this, _, window, cx| {
                this.input.update(cx, |i, cx| {
                    let caret = i.caret();
                    let needs_space = caret > 0 && !i.text()[..caret].ends_with(char::is_whitespace);
                    i.insert(if needs_space { " @" } else { "@" }, cx);
                });
                window.focus(&this.input.focus_handle(cx), cx);
            })))
            .child(div().flex_1())
            .child(keys)
            .children(steer)
            .child(send)
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let focused = self.input.focus_handle(cx).is_focused(window);
        let text = self.input.read(cx).text();
        let too_long = (text.trim().len() > MAX_BYTES)
            .then(|| format!("Orders are at most {MAX_BYTES} bytes; this one is {}. Attach the detail as a file.", text.trim().len()));
        let can_send = !text.trim().is_empty() && self.sync.offline.is_none() && too_long.is_none();
        let docked = self.placement == Placement::Docked;
        let follow_up = self.placement == Placement::FollowUp;
        let notice = self.error.clone().or(too_long).map(|e| (e, t.danger)).or_else(|| self.sync.offline.clone().map(|o| (o, t.warning)));
        let menu_open = self.menu.is_some();
        let body = div()
            .key_context(if menu_open { MENU_CONTEXT } else { CONTEXT })
            .on_action(cx.listener(|this, _: &MenuPrev, _, cx| this.step(-1, cx)))
            .on_action(cx.listener(|this, _: &MenuNext, _, cx| this.step(1, cx)))
            .on_action(cx.listener(|this, _: &MenuPick, window, cx| this.pick(None, window, cx)))
            .on_action(cx.listener(|this, _: &MenuClose, _, cx| {
                this.menu = None;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Steer, _, cx| this.send(true, cx)))
            .on_action(cx.listener(|this, _: &PasteRich, _, cx| this.paste(cx)))
            .on_action(cx.listener(|this, _: &Attach, _, cx| this.prompt_attach(cx)))
            .when(!follow_up, |d| {
                d.on_action(cx.listener(|this, _: &PickProject, window, cx| {
                    let selected = this.target(cx).0.and_then(|k| this.sync.targets.iter().position(|t| t.key == k)).map_or(0, |i| i + 1);
                    this.open_menu(Menu::Project { selected }, window, cx)
                }))
                .on_action(cx.listener(|this, _: &PickTemplate, window, cx| {
                    let selected = TEMPLATES.iter().position(|x| Some(*x) == this.template).unwrap_or(0);
                    this.open_menu(Menu::Template { selected }, window, cx)
                }))
            })
            .on_modifiers_changed(cx.listener(|this, e: &ModifiersChangedEvent, _, cx| {
                let held = e.modifiers.secondary() && e.modifiers == Modifiers::secondary_key();
                if held != this.steer_held && this.placement == Placement::FollowUp {
                    this.steer_held = held;
                    cx.notify();
                }
            }))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| this.attach_files(paths.paths().to_vec(), cx)))
            .flex()
            .flex_col()
            .gap_2()
            .when(docked, |d| d.child(div().font_weight(STRONG).child("What should the fleet do?")))
            .when(self.placement == Placement::Floating, |d| d.child(div().font_weight(STRONG).child("New order")))
            .when(!follow_up, |d| d.child(self.target_line(t, cx)))
            .child(ui::field(t, focused).px_1().py_0p5().child(self.input.clone()))
            .children(self.menu_list(t, cx))
            .children(self.chips(t, cx))
            .when_some(notice, |d, (text, color)| d.child(div().text_size(px(size::XS)).text_color(color).whitespace_normal().child(text)))
            .child(self.footer(t, can_send, cx));
        match self.placement {
            Placement::Floating => ui::floating(t).w(px(640.)).p_4().text_size(px(size::MD)).text_color(t.text).child(body).into_any_element(),
            _ => body.into_any_element(),
        }
    }
}

/// "⌘Enter" on macOS, "Ctrl+Enter" elsewhere.
pub fn steer_keys() -> String {
    ui::shortcut("Enter")
}

/// A picker label: quiet text that underlines on hover, a button for clicks and Tab.
fn picker(t: &Theme, id: &'static str, label: String) -> gpui::Stateful<gpui::Div> {
    let text = t.text;
    ui::clickable(t, div().id(id))
        .px_1()
        .rounded(px(crate::theme::radius::SM))
        .text_color(t.text)
        .hover(move |s| s.text_color(text).underline())
        .child(label)
}

/// An attachment or reference under the box; clicking it removes it.
fn chip(t: &Theme, id: impl Into<gpui::ElementId>, label: String, color: gpui::Hsla) -> gpui::Stateful<gpui::Div> {
    let hover = t.hover;
    ui::clickable(t, div().id(id.into()))
        .px_1p5()
        .rounded(px(crate::theme::radius::SM))
        .bg(t.selected)
        .text_color(color)
        .hover(move |s| s.bg(hover))
        .child(format!("{label} ×"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_are_trimmed_and_held_to_the_hub_limit() {
        assert_eq!(check("  ship dark mode for the docs site \n"), Ok("ship dark mode for the docs site"));
        assert!(check(" \n ").is_err());
        assert!(check(&"x".repeat(MAX_BYTES)).is_ok());
        assert!(check(&"x".repeat(MAX_BYTES + 1)).unwrap_err().contains("4001"));
    }

    #[test]
    fn the_type_picker_mirrors_the_hubs_prefixes() {
        assert_eq!(template_from_prefix("fix: the flaky test"), Some(PlaybookName::Bugfix));
        assert_eq!(template_from_prefix("  Research: which queue"), Some(PlaybookName::Research));
        assert_eq!(template_from_prefix("finish: everything in W12"), Some(PlaybookName::FinishAll));
        assert_eq!(template_from_prefix("Harden the digest. Note: soon"), None);
        assert_eq!(template_from_prefix("no prefix"), None);
    }

    #[test]
    fn a_mention_is_an_at_word_ending_at_the_caret() {
        assert_eq!(mention_at("see @tes", 8), Some((4, "tes")));
        assert_eq!(mention_at("@", 1), Some((0, "")));
        assert_eq!(mention_at("mail me@host", 12), None, "an @ inside a word is not a mention");
        assert_eq!(mention_at("see @tests.rs and more", 22), None, "whitespace after it ends the mention");
        assert_eq!(mention_at("see @tests.rs and more", 9), Some((4, "test")));
    }

    #[test]
    fn a_leading_at_project_picks_it() {
        let targets =
            vec![Target { key: ("forge".into(), "fleetd".into()), title: "fleetd".into(), machine: "forge".into(), machine_offline: false }];
        assert_eq!(project_prefix("@fleetd harden it", &targets).map(|t| t.key.1.as_str()), Some("fleetd"));
        assert!(project_prefix("@fleetd", &targets).is_none(), "not until the name is finished");
        assert!(project_prefix("@web harden", &targets).is_none());
        assert!(project_prefix("harden @fleetd it", &targets).is_none());
    }

    #[test]
    fn guess_change_counts_only_the_edited_middle() {
        assert_eq!(changed_chars("harden the digest", "harden the digest"), 0);
        assert_eq!(changed_chars("harden the digest", "harden the lead digest"), 5);
        assert_eq!(changed_chars("", "12345678"), 8);
        assert_eq!(changed_chars("abc", "xbc"), 1);
    }

    #[test]
    fn attachments_are_images_text_or_pdf() {
        assert_eq!(mime_for("shot.PNG", b"\x89PNG"), Some("image/png"));
        assert_eq!(mime_for("report.pdf", b"%PDF"), Some("application/pdf"));
        assert_eq!(mime_for("tests.rs", b"fn main() {}"), Some("text/plain"));
        assert_eq!(mime_for("blob.bin", &[0xff, 0xfe, 0x00, 0x80, 0x81]), None);
        assert_eq!(fmt_bytes(421_888), "412 KB");
        assert_eq!(fmt_bytes(900), "900 B");
    }
}
