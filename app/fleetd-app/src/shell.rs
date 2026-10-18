use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::app::AppClientMessage;
use fleetd_contracts::doctor::{DoctorFixKind, DoctorStatus};
use fleetd_contracts::ledger::{Ask, AskClass, AskKind, AskState, BatchId, CheckSpec, LeadState, Workstream, WorkstreamState};
use fleetd_contracts::mcp::{TailAction, TailItem, TailMessage, TailRole};
use fleetd_contracts::model::MachineStatus;
use futures::StreamExt;
use futures::channel::mpsc::{self, UnboundedSender};
use gpui::{
    AnyElement, App, ClipboardItem, Context, Div, Entity, FocusHandle, Focusable, Hsla, KeyBinding, KeyDownEvent, Keystroke, MouseButton,
    ScrollDelta, ScrollStrategy, ScrollWheelEvent, SharedString, Stateful, Subscription, SystemNotification, Task, UniformListScrollHandle, Window,
    actions, div, point, prelude::*, px, uniform_list,
};

use crate::actions;
use crate::bench::{self, Mode, Probe};
use crate::client;
use crate::composer::{self, Composer, ComposerEvent};
use crate::diffview;
use crate::fake::{self, LogKind, LogStream};
use crate::input::{InputEvent, TextInput};
use crate::keychain::{self, Saved};
use crate::links;
use crate::notify::{Target, unix_secs};
use crate::pair::{self, Failure};
use crate::palette::{self, Command, Palette, PaletteEvent};
use crate::seal;
use crate::settings::{self, Settings, SettingsEvent};
use crate::sidebar;
use crate::state::{Conn, Echo, ProjectKey, ProjectRow, State};
use crate::theme::{self, STRONG, Theme, metric, size, theme};
use crate::ui::{self, Variant};

const LINES_PER_SEC: u64 = 50;
const SCROLL_PX_PER_SEC: f32 = 2400.;
const POLL_EVERY: Duration = Duration::from_secs(3);
/// Width of a tail line's "10:04:05  " stamp, which the log shows in its own column.
const STAMP_WIDTH: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Screen {
    /// Reading the keychain.
    Loading,
    Connect,
    Inbox,
    Projects,
    Project,
    Machines,
    Settings,
}

actions!(shell, [FocusNext, FocusPrev]);

/// The app's keys: the text field bindings, and Tab / Shift+Tab between fields, buttons and rows.
pub fn bind_keys(cx: &mut App) {
    crate::input::bind_keys(cx);
    palette::bind_keys(cx);
    cx.bind_keys([KeyBinding::new("tab", FocusNext, None), KeyBinding::new("shift-tab", FocusPrev, None)]);
}

/// The first-run screen: a pairing code (primary) or, folded away, a key.
struct ConnectForm {
    hub: Entity<TextInput>,
    code: Entity<TextInput>,
    key: Entity<TextInput>,
    use_key: bool,
    /// What the screen is doing or found, e.g. that a hub answers on this computer.
    status: Option<String>,
    /// A pairing request is out.
    busy: bool,
    error: Option<Failure>,
}

/// One line of the lead log. A long log holds tens of thousands of these, so it keeps one string plus offsets.
struct LogRow {
    kind: LogKind,
    text: SharedString,
    /// `text[..stamp]` is the timestamp, `text[body..]` the line.
    stamp: u8,
    body: u16,
}

impl LogRow {
    fn new(kind: LogKind, text: &str) -> Self {
        let (stamp, body) = split_stamp(text);
        let body_at = (text.len() - body.len()).min(u16::MAX as usize);
        Self { kind, stamp: stamp.len() as u8, body: body_at as u16, text: text.to_string().into() }
    }

    fn stamp(&self) -> &str {
        &self.text[..self.stamp as usize]
    }

    fn body(&self) -> &str {
        &self.text[self.body as usize..]
    }
}

/// The live link to the hub. Dropping it stops the client.
struct HubLink {
    url: String,
    tx: UnboundedSender<AppClientMessage>,
    _tasks: [Task<()>; 3],
}

pub struct Shell {
    state: State,
    screen: Screen,
    selected: usize,
    reply: Entity<TextInput>,
    form: ConnectForm,
    hub: Option<HubLink>,
    /// Shown above the screen, e.g. that the key could not be saved to the keychain.
    note: Option<String>,
    /// A masked field per open secret ask; the value lives only in the field's self-wiping buffer.
    secrets: HashMap<String, (Entity<TextInput>, Subscription)>,
    /// The text last copied, so its button says so.
    copied: Option<String>,
    /// Focus to move to on the next render (e.g. the reply box once connected).
    pending_focus: Option<FocusHandle>,
    _subscriptions: Vec<Subscription>,
    log: Vec<LogRow>,
    log_version: u64,
    log_scroll: UniformListScrollHandle,
    projects_scroll: UniformListScrollHandle,
    follow: bool,
    focus: FocusHandle,
    bench: Option<(LogStream, Probe)>,
    update: Option<String>,
    palette: Option<Entity<Palette>>,
    composer: Option<Entity<Composer>>,
    settings: Entity<Settings>,
    /// Where Settings' Done goes back to.
    before_settings: Screen,
    sidebar_hidden: bool,
    seen: sidebar::Seen,
    /// The ask a notification or the palette pointed at, marked in the inbox.
    focus_ask: Option<String>,
    /// What the notification on screen opens when clicked.
    notified: Option<Target>,
}

impl Shell {
    pub fn new(bench: Option<Mode>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        theme::init(window, cx);
        let settings = cx.new(|_| Settings::default());
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let log_scroll = UniformListScrollHandle::new();
        log_scroll.scroll_to_bottom();
        let reply = cx.new(|cx| TextInput::new(cx).placeholder("Reply to the inbox: 1 go 2 nvm 3 b").multi_line(6).borderless());
        let hub = cx.new(|cx| {
            let mut input = TextInput::new(cx).placeholder(pair::LOCAL_HUB);
            input.set_text(pair::LOCAL_HUB, cx);
            input
        });
        let code = cx.new(|cx| TextInput::new(cx).placeholder("ABCD-2345"));
        let key = cx.new(|cx| TextInput::new(cx).placeholder("fld_…").masked(4096));
        let subscriptions = vec![
            cx.subscribe(&reply, Self::on_reply_event),
            cx.subscribe(&hub, |this, _, e: &InputEvent, cx| {
                if *e == InputEvent::Submit {
                    if this.form.use_key { this.submit_key(cx) } else { this.submit_code(cx) }
                }
            }),
            cx.subscribe(&code, |this, _, e: &InputEvent, cx| {
                if *e == InputEvent::Submit {
                    this.submit_code(cx);
                }
            }),
            cx.subscribe(&key, |this, _, e: &InputEvent, cx| {
                if *e == InputEvent::Submit {
                    this.submit_key(cx);
                }
            }),
            cx.subscribe(&settings, |this, _, event: &SettingsEvent, cx| {
                match event {
                    SettingsEvent::Disconnect => this.disconnect(cx),
                    SettingsEvent::Close => {
                        this.screen = this.before_settings;
                        this.pending_focus = Some(this.reply.focus_handle(cx));
                    }
                }
                cx.notify();
            }),
        ];
        let mut shell = Self {
            state: State::default(),
            screen: Screen::Loading,
            selected: 0,
            pending_focus: Some(reply.focus_handle(cx)),
            reply,
            form: ConnectForm { hub, code, key, use_key: false, status: None, busy: false, error: None },
            hub: None,
            note: None,
            secrets: HashMap::new(),
            copied: None,
            _subscriptions: subscriptions,
            log: Vec::new(),
            log_version: 0,
            log_scroll,
            projects_scroll: UniformListScrollHandle::new(),
            follow: true,
            focus,
            bench: None,
            update: None,
            palette: None,
            composer: None,
            settings,
            before_settings: Screen::Inbox,
            sidebar_hidden: false,
            seen: sidebar::Seen::default(),
            focus_ask: None,
            notified: None,
        };
        match bench {
            Some(mode) => shell.start_bench(mode, window, cx),
            None => {
                shell.on_notification_click(window, cx);
                shell.listen_for_links(cx);
                shell.load_saved(cx);
                crate::update::watch(cx, |shell, text| shell.update = Some(text));
            }
        }
        shell
    }

    /// Clicking a "needs you" notification brings the window forward on what it was about: the ask, else the
    /// inbox, or Machines for a machine's trouble.
    fn on_notification_click(&self, window: &mut Window, cx: &mut Context<Self>) {
        let shell = cx.entity().downgrade();
        let handle = window.window_handle();
        // Called from the notification center's delegate, which can't unwind.
        cx.on_system_notification_response(move |_, cx| {
            crate::crash::guard("notification click", || {
                cx.activate(true);
                handle.update(cx, |_, window, _| window.activate_window()).ok();
                shell
                    .update(cx, |this, cx| {
                        match this.notified.take() {
                            Some(Target::Machines) => this.go(Screen::Machines),
                            Some(Target::Ask(id)) => {
                                this.go(Screen::Inbox);
                                this.focus_ask = Some(id);
                            }
                            Some(Target::Inbox) | None => this.go(Screen::Inbox),
                        }
                        cx.notify();
                    })
                    .ok();
            })
        });
    }

    /// Posts the notification the hub's attention rules and policy allow now, if any.
    fn notify_if_due(&mut self, cx: &mut App) {
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        if let Some(n) = self.state.take_notification(now_ms) {
            self.notified = Some(n.target);
            // One tag: a newer notification replaces an older one still on screen.
            cx.show_system_notification(SystemNotification {
                tag: "fleetd-needs-you".into(),
                title: n.title.into(),
                body: n.body.into(),
                actions: Vec::new(),
            });
        }
    }

    // ---- hub link ------------------------------------------------------------------------

    fn load_saved(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let loaded = match keychain::from_env() {
                Some(saved) => Ok(Some(saved)),
                None => cx.background_executor().spawn(async { keychain::load() }).await,
            };
            this.update(cx, |this, cx| {
                match loaded {
                    Ok(Some(saved)) => this.connect(saved, cx),
                    Ok(None) => this.first_run(cx),
                    Err(e) => {
                        let fix = "You can still connect; without a keychain the key lasts until the app quits.";
                        this.form.error = Some(Failure { code: String::new(), message: e, fix: Some(fix.into()) });
                        this.first_run(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn connect(&mut self, saved: Saved, cx: &mut Context<Self>) {
        let (out_tx, out_rx) = mpsc::unbounded();
        let (in_tx, mut in_rx) = mpsc::unbounded();
        let run = cx.background_executor().spawn(client::run(saved.url.clone(), saved.key, out_rx, in_tx));
        let pump = cx.spawn(async move |this, cx| {
            while let Some(incoming) = in_rx.next().await {
                let ok = this.update(cx, |this, cx| {
                    let out = this.state.apply(incoming);
                    this.send(out);
                    this.after_state_change(cx);
                    this.notify_if_due(cx);
                    cx.notify();
                });
                if ok.is_err() {
                    return;
                }
            }
        });
        let poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL_EVERY).await;
                let ok = this.update(cx, |this, cx| {
                    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
                    let out = this.state.poll(now_ms);
                    this.send(out);
                    this.notify_if_due(cx);
                });
                if ok.is_err() {
                    return;
                }
            }
        });
        self.hub = Some(HubLink { url: saved.url, tx: out_tx, _tasks: [run, pump, poll] });
        self.state = State::default();
        self.screen = Screen::Inbox;
        self.selected = 0;
        self.pending_focus = Some(self.reply.focus_handle(cx));
    }

    fn send(&self, out: Vec<AppClientMessage>) {
        if let Some(hub) = &self.hub {
            for message in out {
                hub.tx.unbounded_send(message).ok();
            }
        }
    }

    /// No saved hub: show the connect screen and try, in order, a `fleetd://pair` link that launched us (handled by
    /// [`Self::listen_for_links`]), the `app-pair.json` that `fleetd init` leaves on the hub machine, and a hub
    /// answering on this computer.
    fn first_run(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::Connect;
        self.pending_focus = Some(self.form.code.focus_handle(cx));
        cx.spawn(async move |this, cx| {
            let file = pair::app_pair_file();
            let read = file.clone();
            let found = cx.background_executor().spawn(async move { read.and_then(|f| std::fs::read_to_string(f).ok()) }).await;
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            let auto = found.as_deref().and_then(pair::read_app_pair);
            let started = this
                .update(cx, |this, cx| {
                    let auto = auto?;
                    this.form.hub.update(cx, |i, cx| i.set_text(&auto.hub, cx));
                    if this.form.busy || auto.expired(now) {
                        return None;
                    }
                    this.form.code.update(cx, |i, cx| i.set_text(&auto.code, cx));
                    this.start_pair(auto.hub, auto.code, file, cx);
                    Some(())
                })
                .ok()
                .flatten();
            if started.is_some() {
                return;
            }
            let hub = this.update(cx, |this, cx| this.form.hub.read(cx).text().trim().to_string()).unwrap_or_default();
            let probe = hub.clone();
            let answers = cx.background_executor().spawn(async move { pair::hub_answers(&probe).await }).await;
            this.update(cx, |this, cx| {
                if this.form.status.is_none() && !this.form.busy {
                    this.form.status = Some(if answers {
                        format!("Found your hub at {hub}. Enter the code from `fleetd pair` to connect.")
                    } else {
                        "No hub answers on this computer. Enter your hub's address and a code from `fleetd pair` run there, or set up a hub with `fleetd init`.".into()
                    });
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// `fleetd://pair?hub=…&code=…` links, from the OS (macOS) or the command line (Linux `.desktop` `%u`).
    fn listen_for_links(&mut self, cx: &mut Context<Self>) {
        let Some(mut links) = cx.try_global::<pair::Links>().and_then(|l| l.0.borrow_mut().take()) else { return };
        cx.spawn(async move |this, cx| {
            while let Some(link) = links.next().await {
                let ok = this.update(cx, |this, cx| {
                    let Some((hub, code)) = pair::parse_deep_link(&link) else {
                        this.note = Some(format!("Ignored a link this app doesn't handle: {link}"));
                        return cx.notify();
                    };
                    this.form.hub.update(cx, |i, cx| i.set_text(&hub, cx));
                    this.form.code.update(cx, |i, cx| i.set_text(&code, cx));
                    if !this.form.busy {
                        this.start_pair(hub, code, None, cx);
                    }
                });
                if ok.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    fn submit_code(&mut self, cx: &mut Context<Self>) {
        if self.form.busy {
            return;
        }
        let hub = self.form.hub.read(cx).text().trim().to_string();
        let code = self.form.code.read(cx).text().to_string();
        self.start_pair(hub, code, None, cx);
    }

    /// Redeems `code` at `hub` (POST /pair), saves the key and connects. `auto_file` is the `app-pair.json` the
    /// code came from, deleted once the hub has taken or refused the code.
    fn start_pair(&mut self, hub: String, code: String, auto_file: Option<std::path::PathBuf>, cx: &mut Context<Self>) {
        if let Err(e) = client::app_url(&hub) {
            self.form.error =
                Some(Failure { code: String::new(), message: e, fix: Some("Use the hub's address, e.g. http://127.0.0.1:4790.".into()) });
            return cx.notify();
        }
        self.form.busy = true;
        self.form.error = None;
        self.form.status = Some(format!("Pairing with {hub}…"));
        if self.hub.is_none() {
            self.screen = Screen::Connect;
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let device = pair::device_name();
            let target = hub.clone();
            let result = cx.background_executor().spawn(async move { pair::pair(&target, &code, &device).await }).await;
            // The hub has used up or refused the code: the file is spent either way.
            if (result.is_ok() || result.as_ref().is_err_and(|f| f.code.starts_with("pair_code_")))
                && let Some(file) = auto_file
            {
                std::fs::remove_file(file).ok();
            }
            this.update(cx, |this, cx| {
                this.form.busy = false;
                match result {
                    Ok(paired) => {
                        this.form.status = None;
                        this.form.code.update(cx, |i, cx| i.clear(cx));
                        this.note = Some(format!("Paired with {}.", paired.hub_name));
                        this.save_and_connect(Saved { url: hub, key: paired.key }, cx);
                    }
                    Err(failure) => {
                        this.form.status = None;
                        if this.hub.is_some() {
                            this.note = Some(format!("Pairing failed: {} {}", failure.message, failure.fix.as_deref().unwrap_or("")));
                        }
                        this.form.error = Some(failure);
                        this.pending_focus = Some(this.form.code.focus_handle(cx));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn submit_key(&mut self, cx: &mut Context<Self>) {
        let url = self.form.hub.read(cx).text().trim().to_string();
        let key = self.form.key.read(cx).text().trim().to_string();
        if let Err(e) = client::app_url(&url) {
            self.form.error =
                Some(Failure { code: String::new(), message: e, fix: Some("Use the hub's address, e.g. http://127.0.0.1:4790.".into()) });
            return cx.notify();
        }
        if key.is_empty() {
            self.form.error = Some(Failure {
                code: String::new(),
                message: "Paste a key for this device.".into(),
                fix: Some("On the hub, run `fleetd hub key create --human --name <device>` and paste the key it prints.".into()),
            });
            self.pending_focus = Some(self.form.key.focus_handle(cx));
            return cx.notify();
        }
        self.form.key.update(cx, |i, cx| i.clear(cx));
        self.form.error = None;
        self.save_and_connect(Saved { url, key }, cx);
        cx.notify();
    }

    fn save_and_connect(&mut self, saved: Saved, cx: &mut Context<Self>) {
        let to_save = saved.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { keychain::save(&to_save) }).await;
            this.update(cx, |this, cx| {
                if let Err(e) = result {
                    this.note = Some(format!("{e} Connected for this session only; the key was not stored anywhere."));
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        self.connect(saved, cx);
    }

    fn disconnect(&mut self, cx: &mut Context<Self>) {
        self.hub = None;
        self.secrets.clear();
        self.state = State::default();
        self.screen = Screen::Connect;
        self.note = None;
        self.form.status = None;
        self.pending_focus = Some(self.form.code.focus_handle(cx));
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async { keychain::clear() }).await;
            this.update(cx, |this, cx| {
                this.form.error = result.err().map(|message| Failure { code: String::new(), message, fix: None });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn after_state_change(&mut self, cx: &mut Context<Self>) {
        self.seen.prime(&self.state);
        if let Some(row) = self.state.detail.as_ref().and_then(|d| self.state.project(&d.key)) {
            self.seen.mark(&row.key(), row.summary.last_activity_at.as_str());
        }
        if let Conn::Refused(message) = &self.state.conn {
            self.form.error = Some(Failure {
                code: String::new(),
                message: message.clone(),
                fix: Some("Pair again with a code from `fleetd pair` on the hub, or use another key.".into()),
            });
            self.hub = None;
            self.secrets.clear();
            self.screen = Screen::Connect;
            self.pending_focus = Some(self.form.code.focus_handle(cx));
        }
        // An ask answered or withdrawn elsewhere drops (and wipes) what was typed for it; a new one gets a field.
        self.secrets.retain(|id, _| self.state.asks.get(id.as_str()).is_some_and(|a| a.state == AskState::Open));
        let open: Vec<String> = self
            .state
            .asks
            .values()
            .filter(|a| a.kind == AskKind::Secret && a.state == AskState::Open && !self.secrets.contains_key(a.ask_id.as_str()))
            .map(|a| a.ask_id.to_string())
            .collect();
        for id in open {
            let input = cx.new(|cx| TextInput::new(cx).placeholder("Type or paste the value; Enter seals and sends").masked(seal::SECRET_MAX_BYTES));
            let ask_id = id.clone();
            let sub = cx.subscribe(&input, move |this, input, e: &InputEvent, cx| match e {
                InputEvent::Submit => this.submit_secret(&ask_id, cx),
                InputEvent::Cancel => input.update(cx, |i, cx| i.clear(cx)),
                InputEvent::TooLong => {
                    this.state.echo = Some(Echo { text: format!("A secret is at most {} bytes.", seal::SECRET_MAX_BYTES), ok: false });
                    cx.notify();
                }
                InputEvent::Changed => cx.notify(),
            });
            self.secrets.insert(id, (input, sub));
        }
        let version = self.state.detail.as_ref().map_or(0, |d| d.version);
        if version != self.log_version {
            self.log_version = version;
            self.log = self.state.detail.as_ref().map(|d| tail_rows(&d.tail)).unwrap_or_default();
            if self.follow && !self.log.is_empty() {
                self.log_scroll.scroll_to_item(self.log.len() - 1, ScrollStrategy::Bottom);
            }
        }
    }

    // ---- navigation and keys ---------------------------------------------------------------

    fn go(&mut self, screen: Screen) {
        // Settings works before connecting too (appearance); everything else needs a hub.
        if !self.connected() && screen != Screen::Settings {
            return;
        }
        if screen == Screen::Settings && self.screen != Screen::Settings {
            self.before_settings = self.screen;
        }
        if screen != Screen::Inbox {
            self.focus_ask = None;
        }
        if screen != Screen::Project {
            self.state.close_project();
        }
        if screen == Screen::Machines && self.screen != Screen::Machines {
            let out = self.state.open_doctor();
            self.send(out);
        }
        self.screen = screen;
        self.selected = 0;
    }

    fn open_project(&mut self, key: ProjectKey) {
        if let Some(row) = self.state.project(&key) {
            self.seen.mark(&key, row.summary.last_activity_at.as_str());
        }
        let out = self.state.open_project(key);
        self.send(out);
        self.log.clear();
        self.log_version = 0;
        self.follow = true;
        self.screen = Screen::Project;
    }

    fn list_len(&self) -> usize {
        match self.screen {
            Screen::Projects => self.state.projects.len(),
            Screen::Machines => self.state.machines.len(),
            _ => 0,
        }
    }

    /// Accelerators only: everything here is also a click away. Text goes to whichever field has focus.
    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        if let Some((_, probe)) = &mut self.bench {
            probe.key_received(Instant::now(), &ks.key);
        }
        let m = &ks.modifiers;
        if m.secondary() && !m.alt && !m.shift {
            match ks.key.as_str() {
                "1" => self.go(Screen::Inbox),
                "2" => self.go(Screen::Projects),
                "3" => self.go(Screen::Machines),
                _ => return,
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if m.control || m.platform || m.alt {
            return;
        }
        let key = ks.key.as_str();
        if matches!(key, "up" | "down") && self.list_len() > 0 {
            self.selected = if key == "up" { self.selected.saturating_sub(1) } else { (self.selected + 1).min(self.list_len() - 1) };
            if self.screen == Screen::Projects {
                self.projects_scroll.scroll_to_item(self.selected, ScrollStrategy::Nearest);
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        // Typing with no field focused (after clicking the background) goes to the reply box.
        if self.focus.is_focused(window)
            && self.has_reply_bar()
            && let Some(text) = printable(ks)
        {
            self.reply.update(cx, |r, cx| r.insert(text, cx));
            self.pending_focus = Some(self.reply.focus_handle(cx));
            cx.stop_propagation();
            cx.notify();
        }
    }

    fn has_reply_bar(&self) -> bool {
        self.connected() && !matches!(self.screen, Screen::Connect | Screen::Loading)
    }

    fn on_reply_event(&mut self, input: Entity<TextInput>, event: &InputEvent, cx: &mut Context<Self>) {
        let raw = input.read(cx).text().to_string();
        match event {
            InputEvent::Submit if !raw.trim().is_empty() => {
                input.update(cx, |i, cx| {
                    i.remember(&raw);
                    i.clear(cx);
                });
                if self.bench.is_some() {
                    // No hub in the bench: echo locally, as typing a reply would.
                    self.push_log(LogRow::new(LogKind::User, &format!("› you: {raw}")));
                } else {
                    let out = self.state.reply(&raw, None);
                    self.send(out);
                }
            }
            // An empty reply box leaves Enter and Esc to the screen: open the selected project, or go back.
            InputEvent::Submit if self.screen == Screen::Projects => {
                if let Some(key) = self.state.projects.get(self.selected).map(ProjectRow::key) {
                    self.open_project(key);
                }
            }
            InputEvent::Cancel if !raw.is_empty() => input.update(cx, |i, cx| i.clear(cx)),
            InputEvent::Cancel if self.screen == Screen::Project => self.go(Screen::Projects),
            _ => return,
        }
        cx.notify();
    }

    fn send_reply(&mut self, cx: &mut Context<Self>) {
        let reply = self.reply.clone();
        self.on_reply_event(reply, &InputEvent::Submit, cx);
    }

    /// Seals the typed value to the sink machine's key and sends only the ciphertext, then wipes the field.
    fn submit_secret(&mut self, ask_id: &str, cx: &mut Context<Self>) {
        let Some((input, _)) = self.secrets.get(ask_id) else { return };
        let input = input.clone();
        let Some(ask) = self.state.asks.get(ask_id) else { return };
        let value = input.read(cx).text();
        if value.is_empty() {
            return;
        }
        match self.state.secret_target(ask).and_then(|(machine, key)| Ok((machine, seal::seal(&key, value.as_bytes())?))) {
            Ok((machine, sealed)) => {
                let out = self.state.submit_secret(ask_id, &machine, sealed);
                self.send(out);
                input.update(cx, |i, cx| i.clear(cx));
            }
            Err(e) => self.state.echo = Some(Echo { text: e, ok: false }),
        }
        cx.notify();
    }

    fn copy(&mut self, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        self.copied = Some(text);
        cx.notify();
    }

    /// A small button that copies `text` and then says so.
    fn copy_button(&self, id: impl Into<SharedString>, text: impl Into<String>, cx: &mut Context<Self>) -> Stateful<Div> {
        let text = text.into();
        let copied = self.copied.as_deref() == Some(text.as_str());
        ui::copy_button(theme(cx), id.into(), copied).on_click(cx.listener(move |this, _, _, cx| this.copy(text.clone(), cx)))
    }

    /// An error and its fix, with a Copy button for both, so they can be pasted into an issue or a search.
    fn error_line(&self, id: impl Into<SharedString>, message: impl Into<String>, fix: Option<String>, cx: &mut Context<Self>) -> Div {
        let message = message.into();
        let all = match &fix {
            Some(fix) => format!("{message}\n{fix}"),
            None => message.clone(),
        };
        let copy = self.copy_button(id, all, cx);
        ui::error(theme(cx), message, fix.map(Into::into), copy)
    }

    /// A command to run elsewhere, in mono, with a Copy button.
    fn command_line(&self, id: impl Into<SharedString>, command: impl Into<String>, cx: &mut Context<Self>) -> Div {
        let command = command.into();
        let copy = self.copy_button(id, command.clone(), cx);
        ui::command(theme(cx), command, copy)
    }

    fn quick_reply(&mut self, batch_id: BatchId, raw: String, cx: &mut Context<Self>) {
        let out = self.state.reply(&raw, Some(&batch_id));
        self.send(out);
        cx.notify();
    }

    fn push_log(&mut self, line: LogRow) {
        self.log.push(line);
        if self.follow {
            self.log_scroll.scroll_to_item(self.log.len() - 1, ScrollStrategy::Bottom);
        }
    }

    fn on_log_wheel(&mut self, event: &ScrollWheelEvent, _: &mut Window, _: &mut Context<Self>) {
        let up = match event.delta {
            ScrollDelta::Pixels(p) => p.y > px(0.),
            ScrollDelta::Lines(l) => l.y > 0.,
        };
        if up {
            self.follow = false;
        }
    }

    // ---- overlays and commands ------------------------------------------------------------

    fn pick(&mut self, pick: sidebar::Pick, cx: &mut Context<Self>) {
        match pick {
            sidebar::Pick::Inbox => self.go(Screen::Inbox),
            sidebar::Pick::Projects => self.go(Screen::Projects),
            sidebar::Pick::Machines => self.go(Screen::Machines),
            sidebar::Pick::Settings => self.go(Screen::Settings),
            sidebar::Pick::Project(key) => self.open_project(key),
        }
        cx.notify();
    }

    /// Runs a palette command. Every one of these is also a click or a menu item away.
    fn run(&mut self, command: Command, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        self.pending_focus = Some(self.reply.focus_handle(cx));
        match command {
            Command::Inbox => self.go(Screen::Inbox),
            Command::Projects => self.go(Screen::Projects),
            Command::Machines => self.go(Screen::Machines),
            Command::Settings => self.go(Screen::Settings),
            Command::Project(key) => self.open_project(key),
            Command::Ask(id) => {
                self.go(Screen::Inbox);
                self.focus_ask = Some(id);
            }
            Command::NewOrder(target) => self.open_composer(target, window, cx),
            Command::Connect => self.disconnect(cx),
        }
        cx.notify();
    }

    fn toggle_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_some() || !self.connected() {
            self.pending_focus = Some(self.reply.focus_handle(cx));
            return cx.notify();
        }
        self.composer = None;
        let items = palette::items(&self.state);
        let palette = cx.new(|cx| Palette::new(items, window, cx));
        cx.subscribe_in(&palette, window, |this, _, event: &PaletteEvent, window, cx| match event {
            PaletteEvent::Run(command) => this.run(command.clone(), window, cx),
            PaletteEvent::Dismiss => this.close_overlays(cx),
        })
        .detach();
        self.palette = Some(palette);
        cx.notify();
    }

    /// The New order composer, aimed at `target`, else at the open project, else at whatever the hub picks.
    fn open_composer(&mut self, target: Option<ProjectKey>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        self.palette = None;
        let target = target.or_else(|| self.state.detail.as_ref().map(|d| d.key.clone()));
        let targets = self.state.projects.iter().map(|r| composer::Target { key: r.key(), title: r.summary.title.clone().into() }).collect();
        let composer = cx.new(|cx| Composer::new(targets, target, window, cx));
        cx.subscribe_in(&composer, window, |this, _, event: &ComposerEvent, _, cx| match event {
            ComposerEvent::Send { target, text } => {
                if this.bench.is_some() {
                    this.state.echo = Some(Echo { text: format!("Order sent: {text}"), ok: true });
                } else {
                    let id = format!("app-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis()));
                    let out = this.state.submit_order(target.as_ref(), text, &id);
                    this.send(out);
                }
                this.close_overlays(cx);
            }
            ComposerEvent::Dismiss => this.close_overlays(cx),
        })
        .detach();
        self.composer = Some(composer);
        cx.notify();
    }

    fn close_overlays(&mut self, cx: &mut Context<Self>) {
        self.palette = None;
        self.composer = None;
        self.pending_focus = Some(self.reply.focus_handle(cx));
        cx.notify();
    }

    fn connected(&self) -> bool {
        self.hub.is_some() || self.bench.is_some()
    }

    // ---- screens -------------------------------------------------------------------------

    fn conn_line(&self, t: &Theme) -> sidebar::Conn {
        let host = self.hub.as_ref().map(|h| h.url.split("://").nth(1).unwrap_or(&h.url).trim_end_matches('/').to_string()).unwrap_or_default();
        let (color, label) = match (&self.state.conn, self.bench.is_some()) {
            (_, true) => (t.warning, "Bench fixture, no hub".to_string()),
            (Conn::Live, _) => (t.success, format!("Connected to {host}")),
            (Conn::Connecting { reason: None, .. }, _) => (t.faint, format!("Connecting to {host}…")),
            (Conn::Connecting { reason: Some(r), retry_in }, _) => {
                (t.warning, format!("Reconnecting in {}s: {r}", retry_in.map_or(0, |d| d.as_secs_f32().ceil() as u64)))
            }
            (Conn::Refused(_), _) => (t.danger, "The hub refused this key".to_string()),
        };
        sidebar::Conn { label: label.into(), color }
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let active = match self.screen {
            Screen::Inbox => sidebar::Active::Inbox,
            Screen::Projects => sidebar::Active::Projects,
            Screen::Machines => sidebar::Active::Machines,
            Screen::Settings => sidebar::Active::Settings,
            Screen::Project => self.state.detail.as_ref().map_or(sidebar::Active::None, |d| sidebar::Active::Project(d.key.clone())),
            Screen::Loading | Screen::Connect => sidebar::Active::None,
        };
        let this = cx.entity().downgrade();
        let on_pick: sidebar::OnPick = Rc::new(move |pick, _, cx| {
            this.update(cx, |this, cx| this.pick(pick, cx)).ok();
        });
        let update = self.update.clone().map(|text| {
            div()
                .px_4()
                .pb_3()
                .flex()
                .flex_col()
                .gap_1()
                .text_size(px(size::XS))
                .child(div().text_color(t.accent).child(text))
                .child(self.command_line("copy-update", "fleetd update", cx))
                .into_any_element()
        });
        sidebar::render(t, &self.state, &self.seen, &active, self.conn_line(t), update, on_pick)
    }

    fn connect_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let form = &self.form;
        let field = |label: &'static str, input: &Entity<TextInput>| {
            div().flex().flex_col().gap_1().child(div().text_size(px(size::XS)).text_color(t.quiet).child(label)).child(input.clone())
        };
        let mut col = div()
            .w(px(440.))
            .flex()
            .flex_col()
            .gap_4()
            .child(div().text_size(px(size::XL)).font_weight(STRONG).child("Connect to your fleetd hub"))
            // The pairing messages mark commands with backticks; the command names read fine without them here.
            .when_some(form.status.clone(), |d, status| d.child(div().whitespace_normal().text_color(t.quiet).child(status.replace('`', ""))))
            .child(field("Hub address", &form.hub));
        if !form.use_key {
            col = col
                .child(field("Pairing code", &form.code))
                .child(
                    div().flex().child(
                        ui::button(t, "pair", if form.busy { "Connecting…" } else { "Connect" }, Variant::Primary, !form.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.submit_code(cx))),
                    ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_color(t.quiet).child("No code yet? On the hub, run this and type the code it prints:"))
                        .child(self.command_line("copy-pair", "fleetd pair", cx)),
                );
        }
        if let Some(error) = &form.error {
            col =
                col.child(self.error_line("copy-connect-error", error.message.replace('`', ""), error.fix.as_ref().map(|f| f.replace('`', "")), cx));
        }
        col = col.child(
            ui::clickable(t, div().id("use-key"))
                .flex()
                .gap_1()
                .items_center()
                .text_color(t.accent)
                .child(if form.use_key { "▾ Use a key instead" } else { "▸ Use a key instead" })
                .on_click(cx.listener(|this, _, _, cx| {
                    this.form.use_key = !this.form.use_key;
                    this.form.error = None;
                    let target = if this.form.use_key { &this.form.key } else { &this.form.code };
                    this.pending_focus = Some(target.focus_handle(cx));
                    cx.notify();
                })),
        );
        if form.use_key {
            col = col
                .child(field("Key", &form.key))
                .child(
                    div().flex().child(
                        ui::button(t, "connect-key", "Connect with key", Variant::Primary, true)
                            .on_click(cx.listener(|this, _, _, cx| this.submit_key(cx))),
                    ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_color(t.quiet)
                                .whitespace_normal()
                                .child("On the hub, create a key for this device, so your answers are recorded as yours:"),
                        )
                        .child(self.command_line("copy-key-create", "fleetd hub key create --human --name <device>", cx)),
                );
        }
        col = col.child(div().text_size(px(size::XS)).text_color(t.faint).child("The key is kept in the OS keychain, never in a file."));
        // Left-aligned at a third of the window, like a document, not a centred card.
        div().id("connect").flex_1().min_h_0().overflow_y_scroll().flex().flex_col().pt(px(96.)).pb_8().pl(px(120.)).child(col).into_any_element()
    }

    fn inbox_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let items = self.state.inbox();
        let open = items.len();
        let mut body = div().id("inbox").flex_1().min_h_0().overflow_y_scroll().px_6().pb_6().flex().flex_col();
        if let Some(e) = &self.state.asks_error {
            body = body.child(div().pt_4().child(self.error_line("copy-asks-error", e.clone(), None, cx)));
        }
        if items.is_empty() && self.state.asks_error.is_none() {
            body = body.child(match self.state.conn {
                Conn::Live => ui::empty(
                    t,
                    "Nothing needs you.",
                    "Leads decide everything that isn't a product, money, credential or irreversible call. When one comes up it lands here and as a notification.",
                ),
                _ => ui::loading(t, "Waiting for the hub…"),
            });
        }
        let mut batch = "";
        let (routed, unrouted): (Vec<_>, Vec<_>) = items.into_iter().partition(|item| item.ask.project_ref.is_some());
        for item in routed {
            if item.batch_id != batch {
                batch = item.batch_id;
                body = body.child(ui::section(t, format!("Batch {batch}")));
            }
            body = body.child(self.ask_block(item.batch_id, item.number, item.ask, cx));
        }
        // Intents the router could not place: answering one picks the project.
        if !unrouted.is_empty() {
            body = body.child(ui::section(t, "Not placed in a project yet"));
            for item in unrouted {
                body = body.child(self.ask_block(item.batch_id, item.number, item.ask, cx));
            }
        }
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(ui::header(
                t,
                "Inbox",
                if open > 0 { format!("{open} open · reply by number below, recommendations are fine") } else { String::new() },
            ))
            .child(body)
            .into_any_element()
    }

    /// Opens a clicked link; a path on another machine is copied instead, and the echo says so.
    fn link_opener(&self, workspace: Option<String>, cx: &mut Context<Self>) -> links::OnOpen {
        let this = cx.entity().downgrade();
        Rc::new(move |link, _, cx| {
            if let links::Opened::Copied(path) = links::open(link, workspace.as_deref(), cx) {
                this.update(cx, |this, cx| {
                    this.state.echo = Some(Echo { text: format!("{path} isn't on this computer; copied its path."), ok: true });
                    cx.notify();
                })
                .ok();
            }
        })
    }

    /// One ask, set loud: the question at full weight, its context quiet, the recommended answer as the one
    /// filled button (outlined red when the call is irreversible).
    fn ask_block(&self, batch_id: &BatchId, number: i64, ask: &Ask, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let project = match &ask.project_ref {
            Some(p) => format!("{} on {}", p.project_id, p.machine_id),
            None => format!("{batch_id} · no project yet"),
        };
        let class_color = match ask.class {
            AskClass::Money | AskClass::Irreversible => t.danger,
            AskClass::Credential => t.warning,
            _ => t.quiet,
        };
        let reply = |label: String, raw: String, variant: Variant, cx: &mut Context<Self>| {
            let batch_id = batch_id.clone();
            ui::button(t, SharedString::from(format!("{}-{number}-{raw}", ask.ask_id)), label, variant, true)
                .on_click(cx.listener(move |this, _, _, cx| this.quick_reply(batch_id.clone(), raw.clone(), cx)))
        };
        let mut buttons = div().flex().flex_wrap().items_center().gap_2().pt_2();
        match ask.kind {
            AskKind::Approve => {
                buttons = buttons.child(reply("Approve".into(), format!("{number} go"), Variant::Primary, cx)).child(reply(
                    "Reject".into(),
                    format!("{number} no"),
                    Variant::Secondary,
                    cx,
                ));
            }
            AskKind::Secret => buttons = buttons.child(reply("Decline".into(), format!("{number} no"), Variant::Ghost, cx)),
            _ => {
                if ask.kind == AskKind::Do {
                    buttons = buttons.child(reply("Done".into(), format!("{number} done"), Variant::Primary, cx));
                } else if let Some(rec) = &ask.recommendation {
                    // An irreversible call is never the filled, easy button.
                    let variant = if ask.class == AskClass::Irreversible { Variant::Danger } else { Variant::Primary };
                    buttons = buttons
                        .child(reply(clip(rec, 48), format!("{number} go"), variant, cx))
                        .child(div().text_size(px(size::XS)).text_color(t.faint).child("recommended"));
                }
                for (i, option) in ask.options.iter().flatten().enumerate().take(6) {
                    if ask.recommendation.as_deref() == Some(option.as_str()) {
                        continue;
                    }
                    let letter = (b'a' + i as u8) as char;
                    buttons = buttons.child(reply(clip(option, 48), format!("{number} {letter}"), Variant::Secondary, cx));
                }
                buttons = buttons.child(reply("No".into(), format!("{number} no"), Variant::Ghost, cx));
            }
        }
        let marked = self.focus_ask.as_deref() == Some(ask.ask_id.as_str());
        let workspace = ask
            .project_ref
            .as_ref()
            .and_then(|p| self.state.project(&(p.machine_id.to_string(), p.project_id.to_string())))
            .map(|r| r.summary.workspace_root.clone());
        let on_open = self.link_opener(workspace, cx);
        let mut block = div()
            .max_w(px(metric::MEASURE))
            .py_4()
            .flex()
            .flex_col()
            .gap_1p5()
            .border_b_1()
            .border_color(t.hairline)
            .child(
                div()
                    .flex()
                    .gap_2()
                    .items_center()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .when(marked, |d| d.child(ui::unread(t)))
                    .child(format!("{number}"))
                    .child(div().text_color(class_color).child(label(&ask.class)))
                    .child(project)
                    .when(ask.proceeded_on_rec, |d| d.child("· went ahead on the recommendation"))
                    .when(ask.blocks != "nothing", |d| d.child(div().text_color(t.warning).child(format!("· blocks {}", ask.blocks)))),
            )
            .child(div().font_weight(STRONG).whitespace_normal().child(links::text(
                t,
                format!("{}-text", ask.ask_id),
                ask.text.to_string(),
                true,
                on_open.clone(),
            )));
        for (i, step) in ask.steps.iter().flatten().enumerate() {
            block = block.child(
                div()
                    .pt_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().whitespace_normal().child(format!("{}. {}", i + 1, step.text)))
                    .child(ui::quiet(t, format!("on {}", label(&step.r#where))))
                    .when_some(step.command.as_ref(), |d, command| {
                        d.child(self.command_line(format!("{}-copy-{i}", ask.ask_id), command.to_string(), cx))
                    })
                    .when_some(step.expect.as_ref(), |d, expect| d.child(ui::quiet(t, format!("Expect: {expect}")))),
            );
        }
        if let Some(gated) = &ask.gated {
            // The exact stored argv, as JSON so spaces and quotes stay visible.
            let argv = serde_json::to_string(&gated.argv).unwrap_or_default();
            block = block
                .child(div().pt_2().child(self.command_line(format!("{}-copy-argv", ask.ask_id), argv, cx)))
                .child(ui::quiet(t, format!("in {}", gated.cwd.as_deref().unwrap_or("the project workspace"))))
                .child(ui::quiet(t, format!("{} · {} · up to {} min", label(&gated.class), gated.reason, (gated.timeout_sec.get() + 59) / 60)));
            let env: Vec<String> = gated.secret_env.iter().flat_map(|e| e.0.iter()).map(|e| format!("{} ← {}", e.name, e.secret_key)).collect();
            if !env.is_empty() {
                block = block.child(ui::quiet(t, format!("Secret env: {}", env.join(", "))));
            }
        }
        if ask.kind == AskKind::Secret {
            block = block.child(self.secret_entry(ask, cx));
        }
        if let Some(evidence) = &ask.evidence {
            block = block.child(div().text_color(t.quiet).whitespace_normal().child(links::text(
                t,
                format!("{}-evidence", ask.ask_id),
                evidence.to_string(),
                true,
                on_open,
            )));
        }
        block.child(buttons)
    }

    /// Masked entry: the value lives only in the field's self-wiping buffer, and is sealed to the sink machine's
    /// key here before anything is sent.
    fn secret_entry(&self, ask: &Ask, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let col = div().pt_2().flex().flex_col().gap_1().child(ui::quiet(t, format!("{} → {}", ask.key, ask.sink.as_deref().unwrap_or("?"))));
        let machine = match self.state.secret_target(ask) {
            Ok((machine, _)) => machine,
            Err(reason) => return col.child(div().text_color(t.warning).whitespace_normal().child(reason)),
        };
        let Some((input, _)) = self.secrets.get(ask.ask_id.as_str()) else { return col };
        let typed = !input.read(cx).is_empty();
        let sending = self.state.secret_submitting(&ask.ask_id);
        let id = ask.ask_id.to_string();
        let send = ui::button(
            t,
            SharedString::from(format!("{}-seal", ask.ask_id)),
            if sending { "Sending…" } else { "Seal and send" },
            Variant::Primary,
            !sending,
        )
        .on_click(cx.listener(move |this, _, _, cx| this.submit_secret(&id, cx)));
        col.child(div().flex().gap_2().items_center().child(div().flex_1().child(input.clone())).when(typed, |d| d.child(send))).child(
            div().text_size(px(size::XS)).text_color(t.quiet).child(format!("Encrypted here to {machine}'s key; the hub never sees the value.")),
        )
    }

    fn projects_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let body = if self.state.projects.is_empty() {
            match self.state.conn {
                Conn::Live => {
                    ui::empty(t, "No projects yet.", "Add one on the hub with fleetd init, which also offers the repos it finds.").into_any_element()
                }
                _ => ui::loading(t, "Loading projects…").into_any_element(),
            }
        } else {
            uniform_list(
                "projects",
                self.state.projects.len(),
                cx.processor(|this, range: std::ops::Range<usize>, _, cx| range.map(|ix| this.project_row(ix, cx)).collect::<Vec<_>>()),
            )
            .track_scroll(&self.projects_scroll)
            .flex_1()
            .p_2()
            .into_any_element()
        };
        let new_order = ui::button(t, "projects-new-order", "New order", Variant::Secondary, true)
            .on_click(cx.listener(|this, _, window, cx| this.open_composer(None, window, cx)));
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(ui::header(t, "Projects", div().flex().items_center().gap_3().child(ui::kbd(t, ui::shortcut("N"))).child(new_order)))
            .child(body)
            .into_any_element()
    }

    fn project_row(&self, ix: usize, cx: &mut Context<Self>) -> Stateful<Div> {
        let t = &theme(cx).clone();
        let row = &self.state.projects[ix];
        let (lead_color, lead_label) = lead_badge(t, row);
        let open = row.workstreams().len();
        let headline = row.error.clone().or_else(|| row.headline().map(str::to_string)).unwrap_or_default();
        let key = row.key();
        let needs = self
            .state
            .inbox()
            .iter()
            .filter(|i| i.ask.project_ref.as_ref().is_some_and(|p| p.machine_id.as_str() == key.0 && p.project_id.as_str() == key.1))
            .count();
        let unread = self.seen.unread(&key, row.summary.last_activity_at.as_str());
        ui::row(t, ix, ix == self.selected)
            .h(px(metric::ROW + 4.))
            .gap_3()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected = ix;
                this.open_project(key.clone());
                cx.notify();
            }))
            .child(div().w(px(6.)).flex_none().when(unread, |d| d.child(ui::unread(t))))
            .child(
                div()
                    .w(px(180.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div().min_w_0().overflow_hidden().text_ellipsis().when(needs > 0, |d| d.font_weight(STRONG)).child(row.summary.title.clone()),
                    )
                    .when(needs > 0, |d| d.child(ui::count(t, needs, true))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_color(if row.error.is_some() { t.danger } else { t.quiet })
                    .child(headline),
            )
            .child(div().w(px(64.)).flex_none().text_size(px(size::XS)).text_color(t.faint).child(if open == 0 {
                String::new()
            } else {
                format!("{open} open")
            }))
            .child(
                div()
                    .w(px(84.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(ui::dot(lead_color))
                    .child(lead_label),
            )
            .child(self.machine_label(t, &row.summary.machine_id, row.stale()))
    }

    /// The machine a project is on: quiet, with a word only when it changes how to read the row.
    fn machine_label(&self, t: &Theme, machine_id: &str, stale: bool) -> Div {
        // Degraded machines are explained on Machines.
        let note = match (self.state.machine(machine_id).map(|m| m.status), stale) {
            (Some(MachineStatus::Offline) | None, _) => Some(("offline", t.warning)),
            (_, true) => Some(("stale", t.faint)),
            _ => None,
        };
        div()
            .w(px(120.))
            .flex_none()
            .flex()
            .gap_1()
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .child(machine_id.to_string())
            .when_some(note, |d, (n, color)| d.child(div().text_color(color).child(n)))
    }

    fn project_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(key) = self.state.detail.as_ref().map(|d| d.key.clone()) else { return self.projects_screen(cx) };
        let t = &theme(cx).clone();
        let row = self.state.project(&key);
        let title = row.map_or(key.1.clone(), |r| r.summary.title.clone());
        let mut left = div().id("workstreams").flex_1().min_h_0().overflow_y_scroll().px_4().pb_4().flex().flex_col();
        match row {
            Some(row) if row.outcome.is_none() && row.error.is_none() => left = left.child(ui::loading(t, "Loading workstreams…")),
            Some(row) => {
                if let Some(e) = &row.error {
                    left = left.child(div().pt_4().child(self.error_line("copy-project-error", e.clone(), None, cx)));
                }
                if row.workstreams().is_empty() && row.outcome.is_some() {
                    left = left.child(ui::empty(t, "No open work.", "Send an order and the lead turns it into a workstream here."));
                }
                for w in row.workstreams() {
                    left = left.child(workstream_block(t, w));
                }
            }
            None => {}
        }
        let (lead_color, lead_label) = row.map_or((t.faint, "no lead"), |r| lead_badge(t, r));
        let tail_error = self.state.detail.as_ref().and_then(|d| d.tail_error.clone());
        let stale = row.is_some_and(ProjectRow::stale);
        let workspace = row.map(|r| r.summary.workspace_root.clone());
        let back = ui::button(t, "back", "‹ Projects", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| {
            this.go(Screen::Projects);
            cx.notify();
        }));
        let new_order = {
            let key = key.clone();
            ui::button(t, "project-new-order", "New order", Variant::Secondary, true)
                .on_click(cx.listener(move |this, _, window, cx| this.open_composer(Some(key.clone()), window, cx)))
        };
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(ui::header(
                t,
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(back)
                    .child(title)
                    .child(div().font_weight(theme::REGULAR).text_color(t.quiet).child(format!("on {}", key.0)))
                    .when(stale, |d| d.child(div().font_weight(theme::REGULAR).text_size(px(size::XS)).text_color(t.warning).child("stale"))),
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().flex().items_center().gap_1p5().child(ui::dot(lead_color)).child(format!("lead {lead_label}")))
                    .child(ui::kbd(t, ui::shortcut("N")))
                    .child(new_order),
            ))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(div().w(px(400.)).flex_none().flex().flex_col().border_r_1().border_color(t.hairline).child(left))
                    .child(self.log_pane(t, tail_error, workspace, window, cx)),
            )
            .into_any_element()
    }

    fn log_pane(
        &mut self,
        t: &Theme,
        error: Option<String>,
        workspace: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.drive_scroll_bench(window);
        if !self.follow && self.scroll_bench_idle() && self.log_scroll.is_scrolled_to_end() == Some(true) {
            self.follow = true;
        }
        let empty = self.log.is_empty();
        let lead = self
            .state
            .detail
            .as_ref()
            .and_then(|d| self.state.project(&d.key))
            .and_then(|r| r.lead())
            .map(|l| (l.thread_id.to_string(), l.session_generation));
        let jump = (!self.follow).then(|| {
            ui::button(t, "jump-latest", "Jump to latest", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| {
                this.follow = true;
                if !this.log.is_empty() {
                    this.log_scroll.scroll_to_item(this.log.len() - 1, ScrollStrategy::Bottom);
                }
                cx.notify();
            }))
        });
        let on_open = self.link_opener(workspace, cx);
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(
                div()
                    .h(px(metric::BAR - 8.))
                    .flex_none()
                    .px_4()
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(lead.map_or("Lead log".to_string(), |(id, generation)| format!("Lead log · {id} · session {generation}")))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(format!("{} lines · {}", self.log.len(), if self.follow { "following" } else { "paused" }))
                            .children(jump),
                    ),
            )
            .when_some(error, |d, e| d.child(div().px_4().pb_2().child(self.error_line("copy-tail-error", e, None, cx))))
            .when(empty, |d| d.child(div().px_4().text_color(t.quiet).child("The lead's latest messages and actions show here.")))
            .child(
                uniform_list(
                    "log",
                    self.log.len(),
                    cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                        let t = theme(cx);
                        range.map(|ix| log_row(t, ix, &this.log[ix], &on_open)).collect::<Vec<_>>()
                    }),
                )
                .track_scroll(&self.log_scroll)
                .on_scroll_wheel(cx.listener(Self::on_log_wheel))
                .flex_1()
                .font_family(t.mono_font.clone())
                .text_size(px(size::SM)),
            )
    }

    fn machines_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let mut list = div().id("machines").flex_1().min_h_0().overflow_y_scroll().p_2().pb_6().flex().flex_col();
        if self.state.machines.is_empty() {
            list = list.child(ui::empty(t, "No machines yet.", "Add one on the hub with fleetd machine add <ssh-host>, or run fleetd init again."));
        }
        for (ix, m) in self.state.machines.iter().enumerate() {
            let (color, status) = match m.status {
                MachineStatus::Online => (t.success, "online"),
                MachineStatus::Degraded => (t.warning, "degraded"),
                MachineStatus::Offline => (t.danger, "offline"),
            };
            let detail = match (&m.degraded_reason, m.status) {
                (Some(reason), _) => reason.clone(),
                (None, MachineStatus::Offline) => format!("Last seen {}", ago(m.last_seen_at.as_str())),
                _ => String::new(),
            };
            let versions = format!("node {}", m.node_version);
            list = list.child(
                ui::row(t, SharedString::from(format!("machine-{}", m.name)), ix == self.selected)
                    .h(px(metric::ROW + 8.))
                    .gap_3()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected = ix;
                        cx.notify();
                    }))
                    .child(
                        div()
                            .w(px(140.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(ui::dot(color))
                            .child(div().font_weight(STRONG).child(m.name.clone())),
                    )
                    .child(div().w(px(72.)).flex_none().text_size(px(size::XS)).text_color(t.quiet).child(status))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(if m.degraded_reason.is_some() { t.warning } else { t.quiet })
                            .child(detail),
                    )
                    .child(div().flex_none().text_size(px(size::XS)).text_color(t.faint).font_family(t.mono_font.clone()).child(versions))
                    .child(
                        div()
                            .w(px(64.))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .text_size(px(size::XS))
                            .text_color(t.faint)
                            .child(ago(m.last_seen_at.as_str())),
                    ),
            );
        }
        list = list.child(self.doctor_section(cx));
        div().flex_1().flex().flex_col().min_w_0().child(ui::header(t, "Machines", String::new())).child(list).into_any_element()
    }

    fn doctor_section(&self, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let doctor = self.state.doctor.as_ref();
        let rerunning = self.state.doctor_rerunning();
        let checked = match doctor.and_then(|d| d.checked_at.as_ref().map(|t| t.as_str())) {
            Some(at) => format!("Checked {}", ago(at)),
            None => "Checking…".into(),
        };
        let rerun = ui::button(t, "doctor-rerun", if rerunning { "Re-running…" } else { "Re-run" }, Variant::Ghost, !rerunning).on_click(
            cx.listener(|this, _, _, cx| {
                let out = this.state.rerun_doctor();
                this.send(out);
                cx.notify();
            }),
        );
        let mut section = div().px_2().flex().flex_col().max_w(px(metric::MEASURE + 340.)).child(
            div()
                .pt_6()
                .pb_2()
                .flex()
                .gap_3()
                .items_center()
                .child(div().font_weight(STRONG).child("Setup checks"))
                .child(div().text_size(px(size::XS)).text_color(t.quiet).child(checked))
                .child(div().flex_1())
                .child(rerun),
        );
        if let Some(e) = doctor.and_then(|d| d.error.clone()) {
            section = section.child(self.error_line("copy-doctor-error", e, None, cx));
        }
        for check in doctor.map(|d| d.checks.as_slice()).unwrap_or_default() {
            let color = match check.status {
                DoctorStatus::Ok => t.success,
                DoctorStatus::Warn => t.warning,
                DoctorStatus::Fail => t.danger,
                _ => t.faint,
            };
            let ok = check.status == DoctorStatus::Ok;
            let mut row = div()
                .py_2()
                .flex()
                .gap_3()
                .items_start()
                .border_b_1()
                .border_color(t.hairline)
                .child(div().pt(px(6.)).child(ui::dot(color)))
                .child(
                    div()
                        .w(px(170.))
                        .flex_none()
                        .pt(px(1.))
                        .font_family(t.mono_font.clone())
                        .text_size(px(size::SM))
                        .text_color(t.quiet)
                        .child(check.id.to_string()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .whitespace_normal()
                        .when(ok, |d| d.text_color(t.quiet))
                        .when(!ok, |d| d.font_weight(STRONG))
                        .child(check.message.to_string()),
                );
            if let Some(fix) = check.fix.as_ref().filter(|_| !ok) {
                let mut fix_col = div().w(px(320.)).flex_none().flex().flex_col().gap_1().child(ui::quiet(t, fix.label.to_string()));
                if let Some(command) = fix.command.as_ref().filter(|_| fix.kind == DoctorFixKind::Manual) {
                    fix_col = fix_col.child(self.command_line(format!("copy-fix-{}", check.id), command.to_string(), cx));
                }
                if fix.kind == DoctorFixKind::Auto {
                    let id = check.id.clone();
                    let fixing = self.state.doctor_fixing(&id);
                    fix_col = fix_col.child(
                        div().flex().child(
                            ui::button(
                                t,
                                SharedString::from(format!("fix-{id}")),
                                if fixing { "Fixing…" } else { "Fix" },
                                Variant::Secondary,
                                !fixing,
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let out = this.state.fix_doctor(&id);
                                this.send(out);
                                cx.notify();
                            })),
                        ),
                    );
                }
                row = row.child(fix_col);
            }
            section = section.child(row);
        }
        section
    }

    /// The reply field: terse inbox replies from any screen ("1 go 2 nvm").
    fn reply_bar(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let focused = self.reply.focus_handle(cx).is_focused(window);
        let has_text = !self.reply.read(cx).is_empty();
        div()
            .flex_none()
            .px_4()
            .py_2()
            .flex()
            .items_end()
            .gap_2()
            .border_t_1()
            .border_color(t.hairline)
            .child(ui::field(t, focused).flex_1().min_w_0().px_1().child(self.reply.clone()))
            .when(has_text, |d| {
                d.child(
                    ui::button(t, "send-reply", "Send", Variant::Primary, true)
                        .mb(px(2.))
                        .on_click(cx.listener(|this, _, _, cx| this.send_reply(cx))),
                )
            })
    }

    /// What the last action did (sent, saved, refused), above the reply field on every screen.
    fn echo_line(&self, cx: &mut Context<Self>) -> Option<Div> {
        let t = &theme(cx).clone();
        let echo = self.state.echo.as_ref()?;
        Some(
            div()
                .min_h(px(metric::ROW + 4.))
                .flex_none()
                .px_4()
                .flex()
                .items_center()
                .gap_2()
                .border_t_1()
                .border_color(t.hairline)
                .text_size(px(size::XS))
                .child(ui::dot(if echo.ok { t.success } else { t.warning }))
                .child(div().flex_1().min_w_0().whitespace_normal().child(echo.text.clone()))
                .when(!echo.ok, |d| d.child(self.copy_button("copy-echo", echo.text.clone(), cx))),
        )
    }

    // ---- bench -----------------------------------------------------------------------------

    fn start_bench(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        let history: usize = env_num("FLEETD_HISTORY", 20_000);
        let mut stream = LogStream::new(1);
        self.log = (0..history).map(|_| to_row(stream.next_line())).collect();
        self.state = fake::fixture_state();
        self.seen.prime(&self.state);
        // Two projects with news since you last looked, so the fixture shows the unread state.
        for row in self.state.projects.iter().skip(3).step_by(4).take(2) {
            self.seen.mark(&row.key(), "2026-10-17T09:00:00.000Z");
        }
        // FLEETD_SCREEN picks the screen the fixture opens on, for screenshots; the speed runs use the project.
        self.screen = match std::env::var("FLEETD_SCREEN").as_deref() {
            Ok("inbox") => Screen::Inbox,
            Ok("projects") => Screen::Projects,
            Ok("machines") => Screen::Machines,
            Ok("settings") => Screen::Settings,
            _ => Screen::Project,
        };
        if self.screen != Screen::Project {
            self.state.close_project();
        }
        self.bench = Some((stream, Probe::new()));
        if env_num("FLEETD_STREAM", 1) == 1 {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(1000 / LINES_PER_SEC)).await;
                    let appended = this.update(cx, |this, cx| {
                        let line = to_row(this.bench.as_mut().unwrap().0.next_line());
                        this.push_log(line);
                        cx.notify();
                    });
                    if appended.is_err() {
                        return;
                    }
                }
            })
            .detach();
        }
        spawn_bench(mode, window, cx);
    }

    fn probe(&mut self) -> &mut Probe {
        &mut self.bench.as_mut().unwrap().1
    }

    fn scroll_bench_idle(&self) -> bool {
        self.bench.as_ref().is_none_or(|(_, p)| p.scroll_started.is_none())
    }

    fn drive_scroll_bench(&mut self, window: &mut Window) {
        let Some(started) = self.bench.as_ref().and_then(|(_, p)| p.scroll_started) else { return };
        self.follow = false;
        let state = self.log_scroll.0.borrow();
        let max = f32::from(state.base_handle.max_offset().y).max(1.);
        let y = (started.elapsed().as_secs_f32() * SCROLL_PX_PER_SEC) % max;
        state.base_handle.set_offset(point(px(0.), px(-y)));
        window.request_animation_frame();
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(focus) = self.pending_focus.take() {
            window.focus(&focus, cx);
        }
        let screen = match self.screen {
            Screen::Loading => div().flex_1().into_any_element(),
            Screen::Connect => self.connect_screen(cx),
            Screen::Inbox => self.inbox_screen(cx),
            Screen::Projects => self.projects_screen(cx),
            Screen::Project => self.project_screen(window, cx),
            Screen::Machines => self.machines_screen(cx),
            Screen::Settings => {
                let hub = settings::Hub {
                    url: self.hub.as_ref().map(|h| h.url.clone().into()),
                    status: self.conn_line(theme(cx)).label,
                    live: self.state.conn == Conn::Live && self.hub.is_some(),
                };
                self.settings.update(cx, |s, _| s.hub = hub);
                self.settings.clone().into_any_element()
            }
        };
        let t = theme(cx).clone();
        let banner = self.note.clone().or_else(|| self.state.notice.clone());
        let chrome = self.has_reply_bar();
        let main = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .when_some(banner, |d, text| {
                d.child(div().px_4().py_2().border_b_1().border_color(t.hairline).child(self.error_line("copy-banner", text, None, cx)))
            })
            .child(div().flex_1().min_h_0().flex().child(screen))
            .when(chrome, |d| d.children(self.echo_line(cx)));
        let overlay = |child: AnyElement, cx: &mut Context<Self>| {
            // A click outside the floating panel closes it; the panel itself stops clicks reaching what's under.
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(88.))
                .occlude()
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| this.close_overlays(cx)))
                .child(div().occlude().child(child))
        };
        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .text_color(t.text)
            .text_size(px(size::MD))
            .font_family(t.ui_font.clone())
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .on_action(cx.listener(|_, _: &FocusNext, window, cx| window.focus_next(cx)))
            .on_action(cx.listener(|_, _: &FocusPrev, window, cx| window.focus_prev(cx)))
            .on_action(cx.listener(|this, _: &actions::OpenSettings, _, cx| {
                this.go(Screen::Settings);
                cx.notify();
            }))
            .when(self.connected(), |d| {
                d.on_action(cx.listener(|this, _: &actions::NewOrder, window, cx| this.open_composer(None, window, cx)))
                    .on_action(cx.listener(|this, _: &actions::ToggleCommandPalette, window, cx| this.toggle_palette(window, cx)))
                    .on_action(cx.listener(|this, _: &actions::ToggleSidebar, _, cx| {
                        this.sidebar_hidden = !this.sidebar_hidden;
                        cx.notify();
                    }))
            })
            .child(crate::titlebar::TitleBar::new())
            .child(div().flex_1().min_h_0().flex().when(chrome && !self.sidebar_hidden, |d| d.child(self.sidebar(cx))).child(main))
            .when(chrome, |d| d.child(self.reply_bar(window, cx)))
            .when_some(self.palette.clone(), |d, p| d.child(overlay(p.into_any_element(), cx)))
            .when_some(self.composer.clone(), |d, c| d.child(overlay(c.into_any_element(), cx)))
    }
}

/// A workstream, quietly: its title, id and state on one line, the lead's status line, and what "done" means.
fn workstream_block(t: &Theme, w: &Workstream) -> impl IntoElement {
    let state_color = match w.state {
        WorkstreamState::Done => t.success,
        WorkstreamState::Failed | WorkstreamState::Stopped => t.danger,
        _ => t.quiet,
    };
    let mut block = div()
        .py_3()
        .flex()
        .flex_col()
        .gap_1()
        .border_b_1()
        .border_color(t.hairline)
        .child(
            div()
                .flex()
                .gap_2()
                .items_baseline()
                .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(w.title.to_string()))
                .child(div().text_size(px(size::XS)).text_color(t.faint).child(w.workstream_id.to_string()))
                .child(div().text_size(px(size::XS)).text_color(state_color).child(label(&w.state))),
        )
        .when_some(w.headline.clone(), |d, h| d.child(div().text_color(t.quiet).whitespace_normal().child(h.to_string())));
    match &w.brief {
        // ✓ comes only from checks the hub ran (M6); until then every item is open.
        Some(brief) => {
            let mut list = div().pt_1().flex().flex_col().gap_0p5();
            for check in &brief.done_when {
                list = list.child(
                    div()
                        .flex()
                        .gap_2()
                        .items_center()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .child(div().size(px(7.)).flex_none().rounded_full().border_1().border_color(t.faint))
                        .child(div().whitespace_normal().child(describe(check))),
                );
            }
            block = block.child(list);
        }
        None => block = block.child(div().text_size(px(size::XS)).text_color(t.faint).child("Draft: the lead hasn't written the brief yet.")),
    }
    block
}

/// Quiet unless it needs a look: working is green, stalled amber, everything else grey.
fn lead_badge(t: &Theme, row: &ProjectRow) -> (Hsla, &'static str) {
    match row.lead().map(|l| l.state) {
        None if row.outcome.is_none() => (t.faint, "…"),
        None => (t.faint, "no lead"),
        Some(LeadState::Working) => (t.success, "working"),
        Some(LeadState::Idle) => (t.faint, "idle"),
        Some(LeadState::Starting) => (t.faint, "starting"),
        Some(LeadState::Stalled) => (t.warning, "stalled"),
        Some(LeadState::Stopped) => (t.faint, "stopped"),
    }
}

/// Log rows for a tail: one per line, a timestamp on the first line of each item.
fn tail_rows(items: &[TailItem]) -> Vec<LogRow> {
    let mut rows = Vec::new();
    let mut push = |kind, text: String| rows.push(LogRow::new(kind, &text));
    for item in items {
        match item {
            TailItem::Message(TailMessage { at, role, text }) => {
                let kind = if *role == TailRole::User { LogKind::User } else { LogKind::Thought };
                let role = label(role);
                for (i, line) in text.lines().enumerate() {
                    push(kind, if i == 0 { format!("{}  {role}: {line}", clock(at.as_str())) } else { format!("          {line}") });
                }
            }
            TailItem::Action(TailAction { at, action }) => {
                let kind = if action.failed { LogKind::Error } else { LogKind::Tool };
                push(kind, format!("{}  ● {} [{}]", clock(at.as_str()), action.summary, label(&action.status)));
                let output = action.output_tail.as_deref().unwrap_or_default();
                // An edit's or `git diff`'s output reads as a diff: added and removed lines tinted.
                let diff = diffview::looks_like_diff(output);
                for line in output.lines() {
                    let kind = match (action.failed, diff, line.as_bytes().first()) {
                        (true, ..) => LogKind::Error,
                        (false, true, Some(b'+')) if !line.starts_with("+++") => LogKind::DiffAdd,
                        (false, true, Some(b'-')) if !line.starts_with("---") => LogKind::DiffDel,
                        _ => LogKind::Output,
                    };
                    push(kind, format!("            {line}"));
                }
            }
        }
    }
    rows
}

/// A contract enum's wire value, e.g. "irreversible".
fn label<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        _ => "?".into(),
    }
}

/// One line for a done-when list.
fn describe(check: &CheckSpec) -> String {
    match check {
        CheckSpec::PrMerged { repo, pr } => match pr {
            Some(pr) => format!("PR #{pr} merged in {repo}"),
            None => format!("PR merged in {repo}"),
        },
        CheckSpec::CiGreen { repo, r#ref } => format!("CI green on {repo}{}", r#ref.as_ref().map(|r| format!(" @ {r}")).unwrap_or_default()),
        CheckSpec::Http { url, status, contains } => {
            format!("GET {url} → {status}{}", contains.as_ref().map(|c| format!(" containing \"{c}\"")).unwrap_or_default())
        }
        CheckSpec::Cmd { machine_id, argv, expect_exit } => format!("`{}` on {machine_id} exits {expect_exit}", argv.join(" ")),
        CheckSpec::Test { repo, test_id } => format!("test {test_id} passes in {repo}"),
        CheckSpec::Judge { criteria } => format!("judge: {criteria}"),
        CheckSpec::Human { question } => format!("you confirm: {question}"),
    }
}

/// "2026-10-17T10:04:05.123Z" → "10:04:05".
fn clock(iso: &str) -> &str {
    iso.get(11..19).unwrap_or(iso)
}

/// "4m ago"-style age; computed at render, which only happens on change, so it never ticks by itself.
fn ago(iso: &str) -> String {
    let Some(then) = unix_secs(iso) else { return iso.to_string() };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let s = (now - then).max(0);
    match s {
        0..60 => "just now".into(),
        60..3600 => format!("{}m ago", s / 60),
        3600..86_400 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86_400),
    }
}

fn printable(ks: &Keystroke) -> Option<&str> {
    ks.key_char.as_deref().filter(|ch| !ch.chars().any(char::is_control))
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_string() } else { format!("{}…", text.chars().take(max - 1).collect::<String>()) }
}

fn spawn_bench(mode: Mode, window: &mut Window, cx: &mut Context<Shell>) {
    let x11_window = x11_window_id(window);
    cx.spawn_in(window, async move |this, cx| {
        let tick = Duration::from_millis(10);
        let wait = async |cx: &mut gpui::AsyncWindowContext, d: Duration| cx.background_executor().timer(d).await;
        // First present.
        loop {
            wait(cx, tick).await;
            let Ok(Some(first)) = this.update(cx, |s, _| {
                let p = s.probe();
                p.poll();
                p.first_present.map(|at| (p.unix_ns(at), p.first_draw.map_or(0, |d| p.unix_ns(d)), p.draws_to_first_present))
            }) else {
                continue;
            };
            let (present, draw, draws) = first;
            let x11 = x11_window.unwrap_or(0);
            this.update(cx, |s, _| {
                s.probe().emit(&format!("event=first_present unix_ns={present} first_draw_unix_ns={draw} draws={draws} x11_window={x11}"))
            })
            .ok();
            break;
        }
        let emit_keys = |s: &mut Shell| {
            let p = s.probe();
            for (key, lat) in p.poll() {
                p.emit(&format!("event=key key={key} latency_ns={}", lat.as_nanos()));
            }
        };
        match mode {
            Mode::Cold => {}
            Mode::Idle => return,
            Mode::KeysInternal => {
                wait(cx, Duration::from_secs(1)).await;
                for i in 0..bench::KEYSTROKES {
                    // Enter every 40 letters keeps the echo on screen; the driver counts letters only.
                    if i > 0 && i % 40 == 0 {
                        cx.update(|window, cx| window.dispatch_keystroke(Keystroke::parse("enter").unwrap(), cx)).ok();
                        wait(cx, Duration::from_millis(50)).await;
                    }
                    let key = ((b'a' + (i % 26) as u8) as char).to_string();
                    // Not inside an entity update: dispatch re-enters Shell's key handler.
                    cx.update(|window, cx| window.dispatch_keystroke(Keystroke::parse(&key).unwrap(), cx)).ok();
                    wait(cx, Duration::from_millis(50)).await;
                    this.update(cx, |s, _| emit_keys(s)).ok();
                }
                wait(cx, Duration::from_millis(300)).await;
                this.update(cx, |s, _| emit_keys(s)).ok();
                this.update_in(cx, |s, window, _| s.probe().emit(&format!("event=keys active={}", window.is_window_active()))).ok();
            }
            Mode::KeysExternal => {
                wait(cx, Duration::from_secs(1)).await;
                this.update(cx, |s, _| s.probe().emit(&format!("event=ready x11_window={}", x11_window.unwrap_or(0)))).ok();
                // The driver quits us after its last key; keep resolving latencies until then.
                loop {
                    wait(cx, Duration::from_millis(20)).await;
                    if this.update(cx, |s, _| emit_keys(s)).is_err() {
                        return;
                    }
                }
            }
            Mode::Scroll => {
                wait(cx, Duration::from_secs(1)).await;
                let start = Instant::now();
                this.update(cx, |s, cx| {
                    s.probe().scroll_started = Some(start);
                    cx.notify();
                })
                .ok();
                wait(cx, bench::SCROLL_FOR).await;
                let end = Instant::now();
                wait(cx, Duration::from_millis(100)).await;
                this.update_in(cx, |s, window, _| {
                    let active = window.is_window_active();
                    let p = s.probe();
                    p.poll();
                    let (fps, worst) = bench::scroll_stats(&p.presents, start, end);
                    p.scroll_started = None;
                    p.emit(&format!("event=scroll fps={fps:.1} worst_frame_us={} active={active}", worst.as_micros()));
                })
                .ok();
            }
        }
        this.update(cx, |s, _| s.probe().emit("event=done")).ok();
        cx.update(|_, cx| cx.quit()).ok();
    })
    .detach();
}

fn x11_window_id(window: &Window) -> Option<u32> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(h) => Some(h.window.get()),
        RawWindowHandle::Xlib(h) => Some(h.window as u32),
        _ => None,
    }
}

fn to_row(line: fake::LogLine) -> LogRow {
    LogRow::new(line.kind, &line.text)
}

fn env_num(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn text_row() -> Div {
    div().h(px(metric::LINE)).px_4().flex().items_center().whitespace_nowrap().overflow_hidden()
}

/// One log line: a faint timestamp column, then the line; links in it are clickable; diff lines are tinted.
fn log_row(t: &Theme, ix: usize, line: &LogRow, on_open: &links::OnOpen) -> Div {
    let bg = match line.kind {
        LogKind::DiffAdd => Some(t.diff_add),
        LogKind::DiffDel => Some(t.diff_del),
        _ => None,
    };
    let text = SharedString::from(line.body().to_string());
    let body = div().min_w_0().text_color(log_color(t, line.kind));
    // Checked per visible row as it's drawn, so a 20k-line log costs nothing up front.
    let body = if links::has_link(&text) { body.child(links::text(t, format!("log-{ix}"), text, false, on_open.clone())) } else { body.child(text) };
    text_row()
        .when_some(bg, |d, bg| d.bg(bg))
        .child(div().w(px(96.)).flex_none().text_color(t.faint).child(SharedString::from(line.stamp().to_string())))
        .child(body)
}

/// Quiet work, loud failures: output and passing checks are grey, errors red, your own words in the accent.
fn log_color(t: &Theme, kind: LogKind) -> Hsla {
    match kind {
        LogKind::Tool | LogKind::Thought | LogKind::DiffAdd | LogKind::DiffDel => t.text,
        LogKind::Output | LogKind::Ok => t.quiet,
        LogKind::Error => t.danger,
        LogKind::User => t.accent,
    }
}

/// "10:04:05.120  ● Read(a.rs)" -> ("10:04:05.120", "● Read(a.rs)"). A line without a stamp loses the stamp
/// column's worth of indent, so continuation lines line up under the text they continue.
fn split_stamp(text: &str) -> (&str, &str) {
    match text.split_once("  ") {
        Some((stamp, rest)) if stamp.len() >= 8 && stamp.as_bytes()[0].is_ascii_digit() && stamp.as_bytes()[2] == b':' => (stamp, rest),
        _ => {
            let indent = text.len() - text.trim_start_matches(' ').len();
            ("", &text[indent.min(STAMP_WIDTH)..])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_rows_split_messages_and_show_action_output() {
        let items: Vec<TailItem> = serde_json::from_value(serde_json::json!([
            { "kind": "message", "at": "2026-10-17T10:04:05.000Z", "role": "assistant", "text": "Plan:\n1. read" },
            { "kind": "action", "at": "2026-10-17T10:04:06.000Z", "action": { "at": "2026-10-17T10:04:06.000Z", "kind": "command",
              "status": "failed", "summary": "pnpm test", "outputTail": "1 failed", "exitCode": 1, "failed": true } },
        ]))
        .unwrap();
        let rows: Vec<(LogKind, String, String)> =
            tail_rows(&items).into_iter().map(|r| (r.kind, r.stamp().to_string(), r.body().to_string())).collect();
        assert_eq!(rows[0], (LogKind::Thought, "10:04:05".into(), "assistant: Plan:".into()));
        assert_eq!((rows[1].1.as_str(), rows[1].2.as_str()), ("", "1. read"));
        assert_eq!(rows[2], (LogKind::Error, "10:04:06".into(), "● pnpm test [failed]".into()));
        assert_eq!((rows[3].0, rows[3].2.as_str()), (LogKind::Error, "  1 failed"));
    }

    #[test]
    fn diff_output_is_tinted_and_paths_are_linked() {
        let items: Vec<TailItem> = serde_json::from_value(serde_json::json!([
            { "kind": "action", "at": "2026-10-17T10:04:06.000Z", "action": { "at": "2026-10-17T10:04:06.000Z", "kind": "file_change",
              "status": "completed", "summary": "Edit src/a.rs", "outputTail": "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-old\n+new", "failed": false } },
        ]))
        .unwrap();
        let rows = tail_rows(&items);
        let kinds: Vec<LogKind> = rows.iter().map(|r| r.kind).collect();
        use LogKind::*;
        assert_eq!(kinds, [Tool, Output, Output, Output, DiffDel, DiffAdd]);
        assert!(links::has_link(rows[0].body()), "the edited file is a link");
    }
}
