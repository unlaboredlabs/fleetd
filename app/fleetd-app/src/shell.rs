use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::app::AppClientMessage;
use fleetd_contracts::doctor::{DoctorFixKind, DoctorStatus};
use fleetd_contracts::ledger::{Ask, AskClass, AskKind, AskState, BatchId, CheckSpec, LeadState, Workstream, WorkstreamState};
use fleetd_contracts::mcp::{TailAction, TailItem, TailMessage, TailRole};
use fleetd_contracts::model::MachineStatus;
use futures::StreamExt;
use futures::channel::mpsc::{self, UnboundedSender};
use gpui::{
    AnyElement, App, ClipboardItem, Context, Div, Entity, FocusHandle, Focusable, KeyBinding, KeyDownEvent, Keystroke, MouseButton, ScrollDelta,
    ScrollStrategy, ScrollWheelEvent, SharedString, Stateful, Subscription, SystemNotification, Task, UniformListScrollHandle, Window, actions, div,
    point, prelude::*, px, rgb, transparent_black, uniform_list,
};

use crate::bench::{self, Mode, Probe};
use crate::client;
use crate::fake::{self, LogKind, LogStream};
use crate::input::{InputEvent, TextInput};
use crate::keychain::{self, Saved};
use crate::notify::unix_secs;
use crate::pair::{self, Failure};
use crate::seal;
use crate::state::{Conn, Echo, ProjectKey, ProjectRow, State};

const UI_FONT: &str = "IBM Plex Sans";
const MONO_FONT: &str = "Lilex";
const ROW_H: f32 = 30.;
const LINE_H: f32 = 18.;
const LINES_PER_SEC: u64 = 50;
const SCROLL_PX_PER_SEC: f32 = 2400.;
const POLL_EVERY: Duration = Duration::from_secs(3);
const SHORTCUTS: [&str; 3] = if cfg!(target_os = "macos") { ["⌘1", "⌘2", "⌘3"] } else { ["^1", "^2", "^3"] };

struct Theme;
impl Theme {
    const BG: u32 = 0x1b1c1f;
    const PANEL: u32 = 0x222327;
    const BORDER: u32 = 0x33353a;
    const TEXT: u32 = 0xd6d7da;
    const MUTED: u32 = 0x7d8089;
    const ACCENT: u32 = 0x6ea8fe;
    const GREEN: u32 = 0x7cc47f;
    const RED: u32 = 0xe5737a;
    const YELLOW: u32 = 0xd9b45c;
    const SELECTED: u32 = 0x2d3a52;
    const HOVER: u32 = 0x2a2c31;
    const BUTTON: u32 = 0x2f3238;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Screen {
    /// Reading the keychain.
    Loading,
    Connect,
    Inbox,
    Projects,
    Project,
    Machines,
}

actions!(shell, [FocusNext, FocusPrev]);

/// The app's keys: the text field bindings, and Tab / Shift+Tab between fields, buttons and rows.
pub fn bind_keys(cx: &mut App) {
    crate::input::bind_keys(cx);
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

struct LogRow {
    kind: LogKind,
    text: SharedString,
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
}

impl Shell {
    pub fn new(bench: Option<Mode>, window: &mut Window, cx: &mut Context<Self>) -> Self {
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

    /// Clicking a "needs you" notification brings the window forward on the inbox.
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
                        this.go(Screen::Inbox);
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
        if self.hub.is_none() && self.bench.is_none() {
            return;
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
        !matches!(self.screen, Screen::Connect | Screen::Loading)
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
                    self.push_log(LogRow { kind: LogKind::User, text: format!("› you: {raw}").into() });
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
        button(id.into(), if copied { "Copied" } else { "Copy" }, cx.listener(move |this, _, _, cx| this.copy(text.clone(), cx)))
    }

    /// Error text in red with a Copy button, so it can be pasted into an issue or a search.
    fn error_line(&self, id: impl Into<SharedString>, text: impl Into<String>, cx: &mut Context<Self>) -> Div {
        let text = text.into();
        div()
            .flex()
            .gap_2()
            .items_start()
            .child(div().flex_1().min_w_0().whitespace_normal().text_color(rgb(Theme::RED)).child(text.clone()))
            .child(self.copy_button(id, text, cx))
    }

    /// A command to run elsewhere, in mono, with a Copy button.
    fn command_line(&self, id: impl Into<SharedString>, command: impl Into<String>, cx: &mut Context<Self>) -> Div {
        let command = command.into();
        div()
            .flex()
            .gap_2()
            .items_center()
            .child(div().flex_1().min_w_0().whitespace_normal().font_family(MONO_FONT).text_size(px(12.)).child(command.clone()))
            .child(self.copy_button(id, command, cx))
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

    // ---- screens -------------------------------------------------------------------------

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let inbox = self.state.inbox().len();
        let offline = self.state.machines.iter().filter(|m| m.status != MachineStatus::Online).count();
        let nav = |label: &'static str, count: String, shortcut: &'static str, screen: Screen, cx: &mut Context<Self>| {
            let active = self.screen == screen || (screen == Screen::Projects && self.screen == Screen::Project);
            clickable(div().id(label))
                .h(px(30.))
                .px_3()
                .flex()
                .items_center()
                .gap_2()
                .when(active, |d| d.bg(rgb(Theme::SELECTED)))
                .hover(|d| d.bg(rgb(Theme::HOVER)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.go(screen);
                    cx.notify();
                }))
                .child(div().flex_1().child(label))
                .child(muted(count))
                .child(muted(shortcut))
        };
        let (dot, status) = match (&self.state.conn, self.bench.is_some()) {
            (_, true) => (Theme::YELLOW, "bench fixture, no hub".to_string()),
            (Conn::Live, _) => (Theme::GREEN, "live".to_string()),
            (Conn::Connecting { reason: None, .. }, _) => (Theme::YELLOW, "connecting…".to_string()),
            (Conn::Connecting { reason: Some(r), retry_in }, _) => {
                (Theme::RED, format!("retrying in {}s: {r}", retry_in.map_or(0, |d| d.as_secs_f32().ceil() as u64)))
            }
            (Conn::Refused(_), _) => (Theme::RED, "key refused".to_string()),
        };
        let bench_status = status.clone();
        pane(px(220.))
            .child(header("fleetd", String::new()))
            .when_some(self.update.clone(), |d, text| {
                d.child(
                    div()
                        .px_3()
                        .py_1()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().whitespace_normal().text_color(rgb(Theme::ACCENT)).child(text))
                        .child(self.command_line("copy-update", "fleetd update", cx)),
                )
            })
            .child(nav("Inbox", if inbox > 0 { inbox.to_string() } else { String::new() }, SHORTCUTS[0], Screen::Inbox, cx))
            .child(nav("Projects", self.state.projects.len().to_string(), SHORTCUTS[1], Screen::Projects, cx))
            .child(nav(
                "Machines",
                if offline > 0 { format!("{offline} down") } else { self.state.machines.len().to_string() },
                SHORTCUTS[2],
                Screen::Machines,
                cx,
            ))
            .child(div().flex_1())
            .when(self.hub.is_some(), |d| {
                d.child(
                    div()
                        .p_3()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .border_t_1()
                        .border_color(rgb(Theme::BORDER))
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .child(div().text_color(rgb(dot)).child("●"))
                                .child(div().flex_1().min_w_0().whitespace_normal().child(muted(status))),
                        )
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .items_center()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(muted(self.hub.as_ref().map(|h| h.url.clone()).unwrap_or_default())),
                                )
                                .child(self.copy_button("copy-hub-url", self.hub.as_ref().map(|h| h.url.clone()).unwrap_or_default(), cx)),
                        )
                        .child(button("disconnect", "Disconnect and forget key", cx.listener(|this, _, _, cx| this.disconnect(cx)))),
                )
            })
            .when(self.bench.is_some(), |d| d.child(div().p_3().child(muted(bench_status))))
    }

    fn connect_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let form = &self.form;
        let field = |label: &'static str, input: &Entity<TextInput>| div().flex().flex_col().gap_1().child(muted(label)).child(input.clone());
        let mut card = div()
            .w(px(500.))
            .p_5()
            .flex()
            .flex_col()
            .gap_4()
            .bg(rgb(Theme::PANEL))
            .border_1()
            .border_color(rgb(Theme::BORDER))
            .rounded_md()
            .child(div().text_size(px(16.)).child("Connect to your fleetd hub"))
            .when_some(form.status.clone(), |d, status| d.child(div().whitespace_normal().text_color(rgb(Theme::MUTED)).child(status)))
            .child(field("Hub address", &form.hub));
        if !form.use_key {
            card = card
                .child(field("Pairing code", &form.code))
                .child(div().flex().child(primary_button(
                    "pair",
                    if form.busy { "Connecting…" } else { "Connect" },
                    cx.listener(|this, _, _, cx| this.submit_code(cx)),
                )))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(muted("No code yet? On the hub, run this and type the code it prints:"))
                        .child(self.command_line("copy-pair", "fleetd pair", cx)),
                );
        }
        if let Some(error) = &form.error {
            let text = match &error.fix {
                Some(fix) => format!("{}\n{fix}", error.message),
                None => error.message.clone(),
            };
            card = card.child(self.error_line("copy-connect-error", text, cx));
        }
        card = card.child(
            clickable(div().id("use-key"))
                .flex()
                .gap_1()
                .items_center()
                .text_color(rgb(Theme::ACCENT))
                .hover(|d| d.text_color(rgb(Theme::TEXT)))
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
            card = card
                .child(field("Key", &form.key))
                .child(div().flex().child(primary_button("connect-key", "Connect with key", cx.listener(|this, _, _, cx| this.submit_key(cx)))))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(muted("On the hub, create a key for this device, so your answers are recorded as yours:"))
                        .child(self.command_line("copy-key-create", "fleetd hub key create --human --name <device>", cx)),
                );
        }
        card = card.child(muted("The key is kept in the OS keychain, never in a file."));
        div()
            .id("connect")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .items_center()
            .py_8()
            .child(div().flex_1())
            .child(card)
            .child(div().flex_1())
            .into_any_element()
    }

    fn inbox_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let items = self.state.inbox();
        let mut body = div().id("inbox").flex_1().min_h_0().overflow_y_scroll().p_3().flex().flex_col().gap_2();
        if let Some(echo) = &self.state.echo {
            body = body.child(
                div()
                    .flex()
                    .gap_2()
                    .items_start()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .whitespace_normal()
                            .text_color(rgb(if echo.ok { Theme::GREEN } else { Theme::YELLOW }))
                            .child(echo.text.clone()),
                    )
                    .when(!echo.ok, |d| d.child(self.copy_button("copy-echo", echo.text.clone(), cx))),
            );
        }
        if let Some(e) = &self.state.asks_error {
            body = body.child(self.error_line("copy-asks-error", e.clone(), cx));
        }
        if items.is_empty() && self.state.asks_error.is_none() {
            body = body.child(muted("Nothing needs you. Leads decide everything that isn't a product, money, credential or irreversible call."));
        }
        let mut batch = "";
        let (routed, unrouted): (Vec<_>, Vec<_>) = items.into_iter().partition(|item| item.ask.project_ref.is_some());
        for item in routed {
            if item.batch_id != batch {
                batch = item.batch_id;
                body = body.child(div().pt_2().text_color(rgb(Theme::MUTED)).child(format!("Batch {batch}")));
            }
            body = body.child(self.ask_card(item.batch_id, item.number, item.ask, cx));
        }
        // Intents the router could not place: answering one picks the project.
        if !unrouted.is_empty() {
            body = body.child(div().pt_2().text_color(rgb(Theme::MUTED)).child("Unrouted"));
            for item in unrouted {
                body = body.child(self.ask_card(item.batch_id, item.number, item.ask, cx));
            }
        }
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(header("Inbox", "reply below: 1 go 2 nvm 3 b · recs fine".into()))
            .child(body)
            .into_any_element()
    }

    fn ask_card(&self, batch_id: &BatchId, number: i64, ask: &Ask, cx: &mut Context<Self>) -> impl IntoElement {
        let project = match &ask.project_ref {
            Some(p) => format!("{}/{}", p.machine_id, p.project_id),
            None => format!("{batch_id} · no project yet"),
        };
        let class_color = match ask.class {
            AskClass::Product => Theme::ACCENT,
            AskClass::Money | AskClass::Irreversible => Theme::RED,
            _ => Theme::YELLOW,
        };
        let reply = |label: String, raw: String, cx: &mut Context<Self>| {
            let batch_id = batch_id.clone();
            button(
                SharedString::from(format!("{}-{number}-{raw}", ask.ask_id)),
                label,
                cx.listener(move |this, _, _, cx| this.quick_reply(batch_id.clone(), raw.clone(), cx)),
            )
        };
        let mut buttons = div().flex().flex_wrap().gap_2().pt_1();
        match ask.kind {
            AskKind::Approve => {
                buttons =
                    buttons.child(reply("Approve".into(), format!("{number} go"), cx)).child(reply("Reject".into(), format!("{number} no"), cx));
            }
            AskKind::Secret => buttons = buttons.child(reply("decline".into(), format!("{number} no"), cx)),
            _ => {
                if ask.kind == AskKind::Do {
                    buttons = buttons.child(reply("✓ done".into(), format!("{number} done"), cx));
                } else if let Some(rec) = &ask.recommendation {
                    buttons = buttons.child(reply(format!("go: {}", clip(rec, 40)), format!("{number} go"), cx));
                }
                for (i, option) in ask.options.iter().flatten().enumerate().take(6) {
                    let letter = (b'a' + i as u8) as char;
                    buttons = buttons.child(reply(format!("{letter}: {}", clip(option, 40)), format!("{number} {letter}"), cx));
                }
                buttons = buttons.child(reply("no".into(), format!("{number} no"), cx));
            }
        }
        let mut card = div()
            .p_3()
            .flex()
            .flex_col()
            .gap_1()
            .bg(rgb(Theme::PANEL))
            .border_1()
            .border_color(rgb(Theme::BORDER))
            .rounded_md()
            .child(
                div()
                    .flex()
                    .gap_2()
                    .items_center()
                    .child(div().text_color(rgb(Theme::ACCENT)).child(format!("{number}")))
                    .child(div().text_color(rgb(class_color)).text_size(px(11.5)).child(label(&ask.class)))
                    .child(muted(project))
                    .when(ask.proceeded_on_rec, |d| d.child(muted("· went ahead on the recommendation")))
                    .when(ask.blocks != "nothing", |d| {
                        d.child(div().text_color(rgb(Theme::YELLOW)).text_size(px(11.5)).child(format!("blocks: {}", ask.blocks)))
                    }),
            )
            .child(div().whitespace_normal().child(ask.text.to_string()));
        for (i, step) in ask.steps.iter().flatten().enumerate() {
            card =
                card.child(div().whitespace_normal().child(format!("{}. {}", i + 1, step.text)).child(muted(format!("on {}", label(&step.r#where)))));
            if let Some(command) = &step.command {
                card = card.child(div().pl_4().child(self.command_line(format!("{}-copy-{i}", ask.ask_id), command.to_string(), cx)));
            }
            if let Some(expect) = &step.expect {
                card = card.child(div().pl_4().child(muted(format!("expect: {expect}"))));
            }
        }
        if let Some(gated) = &ask.gated {
            // The exact stored argv, as JSON so spaces and quotes stay visible.
            let argv = serde_json::to_string(&gated.argv).unwrap_or_default();
            card = card
                .child(self.command_line(format!("{}-copy-argv", ask.ask_id), argv, cx))
                .child(muted(format!("in {}", gated.cwd.as_deref().unwrap_or("the project workspace"))))
                .child(muted(format!("{} · {} · up to {} min", label(&gated.class), gated.reason, (gated.timeout_sec.get() + 59) / 60)));
            let env: Vec<String> = gated.secret_env.iter().flat_map(|e| e.0.iter()).map(|e| format!("{} ← {}", e.name, e.secret_key)).collect();
            if !env.is_empty() {
                card = card.child(muted(format!("secret env: {}", env.join(", "))));
            }
        }
        if ask.kind == AskKind::Secret {
            card = card.child(self.secret_entry(ask, cx));
        }
        if let Some(evidence) = &ask.evidence {
            card = card.child(muted(evidence.to_string()));
        }
        card.child(buttons)
    }

    /// Masked entry: the value lives only in the field's self-wiping buffer, and is sealed to the sink machine's
    /// key here before anything is sent.
    fn secret_entry(&self, ask: &Ask, cx: &mut Context<Self>) -> Div {
        let col = div().flex().flex_col().gap_1().child(muted(format!("{} → {}", ask.key, ask.sink.as_deref().unwrap_or("?"))));
        let machine = match self.state.secret_target(ask) {
            Ok((machine, _)) => machine,
            Err(reason) => return col.child(div().text_color(rgb(Theme::YELLOW)).whitespace_normal().child(reason)),
        };
        let Some((input, _)) = self.secrets.get(ask.ask_id.as_str()) else { return col };
        let typed = !input.read(cx).is_empty();
        let sending = self.state.secret_submitting(&ask.ask_id);
        let id = ask.ask_id.to_string();
        let send = button(
            SharedString::from(format!("{}-seal", ask.ask_id)),
            if sending { "Sending…" } else { "Seal & send" },
            cx.listener(move |this, _, _, cx| this.submit_secret(&id, cx)),
        );
        col.child(div().flex().gap_2().items_center().child(div().flex_1().child(input.clone())).when(typed, |d| d.child(send)))
            .child(muted(format!("Encrypted here to {machine}'s key; the hub never sees the value.")))
    }

    fn projects_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(header("Projects", "click to open · ↑↓ Enter".into()))
            .child(
                uniform_list(
                    "projects",
                    self.state.projects.len(),
                    cx.processor(|this, range: std::ops::Range<usize>, _, cx| range.map(|ix| this.project_row(ix, cx)).collect::<Vec<_>>()),
                )
                .track_scroll(&self.projects_scroll)
                .flex_1(),
            )
            .into_any_element()
    }

    fn project_row(&self, ix: usize, cx: &mut Context<Self>) -> Stateful<Div> {
        let row = &self.state.projects[ix];
        let (lead_color, lead_label) = lead_badge(row);
        let open = row.workstreams().len();
        let headline = row.error.clone().or_else(|| row.headline().map(str::to_string)).unwrap_or_default();
        let key = row.key();
        clickable(div().id(ix))
            .w_full()
            .h(px(ROW_H))
            .px_3()
            .flex()
            .items_center()
            .gap_3()
            .whitespace_nowrap()
            .overflow_hidden()
            .when(ix == self.selected, |d| d.bg(rgb(Theme::SELECTED)))
            .hover(|d| d.bg(rgb(Theme::HOVER)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected = ix;
                this.open_project(key.clone());
                cx.notify();
            }))
            .child(
                div()
                    .w(px(90.))
                    .flex_none()
                    .flex()
                    .gap_1()
                    .items_center()
                    .child(div().text_color(rgb(lead_color)).child("●"))
                    .child(muted(lead_label)),
            )
            .child(div().w(px(180.)).flex_none().overflow_hidden().text_ellipsis().child(row.summary.title.clone()))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_color(rgb(if row.error.is_some() { Theme::RED } else { Theme::MUTED }))
                    .child(headline),
            )
            .child(muted(if open == 0 { "no open work".to_string() } else { format!("{open} open") }))
            .child(self.machine_chip(&row.summary.machine_id))
            .when(row.stale(), |d| d.child(div().text_color(rgb(Theme::YELLOW)).text_size(px(11.5)).child("stale")))
    }

    fn machine_chip(&self, machine_id: &str) -> Div {
        let color = match self.state.machine(machine_id).map(|m| m.status) {
            Some(MachineStatus::Online) => Theme::GREEN,
            Some(MachineStatus::Degraded) => Theme::YELLOW,
            _ => Theme::RED,
        };
        div()
            .px_2()
            .rounded_sm()
            .bg(rgb(Theme::BUTTON))
            .flex()
            .gap_1()
            .items_center()
            .text_size(px(11.5))
            .child(div().text_color(rgb(color)).child("●"))
            .child(machine_id.to_string())
    }

    fn project_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(key) = self.state.detail.as_ref().map(|d| d.key.clone()) else { return self.projects_screen(cx) };
        let row = self.state.project(&key);
        let title = row.map_or(key.1.clone(), |r| r.summary.title.clone());
        let mut left = div().id("workstreams").flex_1().min_h_0().overflow_y_scroll().p_3().flex().flex_col().gap_3();
        if let Some(row) = row {
            if let Some(e) = &row.error {
                left = left.child(self.error_line("copy-project-error", e.clone(), cx));
            }
            if row.workstreams().is_empty() && row.outcome.is_some() {
                left = left.child(muted("No open workstreams."));
            }
            for w in row.workstreams() {
                left = left.child(workstream_card(w));
            }
        }
        let (lead_color, lead_label) = row.map_or((Theme::MUTED, "no lead"), lead_badge);
        let tail_error = self.state.detail.as_ref().and_then(|d| d.tail_error.clone());
        let log_title = match row.and_then(|r| r.lead()) {
            Some(lead) => format!("lead · {} · session {}", lead.thread_id, lead.session_generation),
            None => "lead".into(),
        };
        div()
            .flex_1()
            .flex()
            .min_w_0()
            .child(
                pane(px(440.))
                    .child(header_el(
                        div()
                            .flex()
                            .gap_2()
                            .items_center()
                            .child(button(
                                "back",
                                "‹ Projects",
                                cx.listener(|this, _, _, cx| {
                                    this.go(Screen::Projects);
                                    cx.notify();
                                }),
                            ))
                            .child(title)
                            .child(self.machine_chip(&key.0))
                            .when(row.is_some_and(ProjectRow::stale), |d| {
                                d.child(div().text_color(rgb(Theme::YELLOW)).text_size(px(11.5)).child("stale"))
                            }),
                        muted("Esc"),
                    ))
                    .child(left),
            )
            .child(self.log_pane(log_title, lead_color, lead_label, tail_error, window, cx))
            .into_any_element()
    }

    fn log_pane(
        &mut self,
        title: String,
        lead_color: u32,
        lead_label: &'static str,
        error: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.drive_scroll_bench(window);
        if !self.follow && self.scroll_bench_idle() && self.log_scroll.is_scrolled_to_end() == Some(true) {
            self.follow = true;
        }
        let status = if self.follow { "following" } else { "paused" };
        let empty = self.log.is_empty();
        let jump = (!self.follow).then(|| {
            button(
                "jump-latest",
                "Jump to latest",
                cx.listener(|this, _, _, cx| {
                    this.follow = true;
                    if !this.log.is_empty() {
                        this.log_scroll.scroll_to_item(this.log.len() - 1, ScrollStrategy::Bottom);
                    }
                    cx.notify();
                }),
            )
        });
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .bg(rgb(Theme::BG))
            .child(header_el(
                div().flex().gap_2().items_center().child(div().text_color(rgb(lead_color)).child("●")).child(muted(lead_label)).child(title),
                div().flex().gap_2().items_center().child(muted(format!("{} lines · {status}", self.log.len()))).children(jump),
            ))
            .when_some(error, |d, e| d.child(div().px_3().py_1().child(self.error_line("copy-tail-error", e, cx))))
            .when(empty, |d| d.child(div().p_3().child(muted("The lead's latest messages and actions show here."))))
            .child(
                uniform_list(
                    "log",
                    self.log.len(),
                    cx.processor(|this, range: std::ops::Range<usize>, _, _| {
                        range
                            .map(|ix| {
                                let line = &this.log[ix];
                                text_row().text_color(rgb(log_color(line.kind))).child(line.text.clone())
                            })
                            .collect::<Vec<_>>()
                    }),
                )
                .track_scroll(&self.log_scroll)
                .on_scroll_wheel(cx.listener(Self::on_log_wheel))
                .flex_1()
                .font_family(MONO_FONT)
                .text_size(px(12.5)),
            )
    }

    fn machines_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut list = div().id("machines").flex_1().min_h_0().overflow_y_scroll().flex().flex_col();
        if self.state.machines.is_empty() {
            list = list.child(div().p_3().child(muted("No machines have joined this hub yet (fleetd machine add).")));
        }
        for (ix, m) in self.state.machines.iter().enumerate() {
            let (color, label) = match m.status {
                MachineStatus::Online => (Theme::GREEN, "online"),
                MachineStatus::Degraded => (Theme::YELLOW, "degraded"),
                MachineStatus::Offline => (Theme::RED, "offline"),
            };
            let detail = match (&m.degraded_reason, m.status) {
                (Some(reason), _) => reason.clone(),
                (None, MachineStatus::Offline) => format!("last seen {}", ago(m.last_seen_at.as_str())),
                _ => String::new(),
            };
            list = list.child(
                clickable(div().id(SharedString::from(format!("machine-{}", m.name))))
                    .min_h(px(ROW_H))
                    .px_3()
                    .py_1()
                    .flex()
                    .items_center()
                    .gap_3()
                    .hover(|d| d.bg(rgb(Theme::HOVER)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected = ix;
                        cx.notify();
                    }))
                    .when(ix == self.selected, |d| d.bg(rgb(Theme::SELECTED)))
                    .child(
                        div()
                            .w(px(110.))
                            .flex_none()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(div().text_color(rgb(color)).child("●"))
                            .child(muted(label)),
                    )
                    .child(div().w(px(160.)).flex_none().child(m.name.clone()))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .whitespace_normal()
                            .text_color(rgb(if m.degraded_reason.is_some() { Theme::YELLOW } else { Theme::MUTED }))
                            .child(detail),
                    )
                    .child(muted(format!("node {}", m.node_version)))
                    .child(muted(ago(m.last_seen_at.as_str()))),
            );
        }
        list = list.child(self.doctor_section(cx));
        div().flex_1().flex().flex_col().min_w_0().child(header("Machines", String::new())).child(list).into_any_element()
    }

    fn doctor_section(&self, cx: &mut Context<Self>) -> Div {
        let doctor = self.state.doctor.as_ref();
        let rerunning = self.state.doctor_rerunning();
        let checked = match doctor.and_then(|d| d.checked_at.as_ref().map(|t| t.as_str())) {
            Some(at) => format!("checked {}", ago(at)),
            None => "checking…".into(),
        };
        let rerun = button(
            "doctor-rerun",
            if rerunning { "Re-running…" } else { "Re-run" },
            cx.listener(|this, _, _, cx| {
                let out = this.state.rerun_doctor();
                this.send(out);
                cx.notify();
            }),
        );
        let mut section = div()
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .border_t_1()
            .border_color(rgb(Theme::BORDER))
            .child(div().flex().gap_3().items_center().child("Doctor").child(muted(checked)).child(div().flex_1()).child(rerun));
        if let Some(e) = doctor.and_then(|d| d.error.clone()) {
            section = section.child(self.error_line("copy-doctor-error", e, cx));
        }
        for check in doctor.map(|d| d.checks.as_slice()).unwrap_or_default() {
            let color = match check.status {
                DoctorStatus::Ok => Theme::GREEN,
                DoctorStatus::Warn => Theme::YELLOW,
                DoctorStatus::Fail => Theme::RED,
                _ => Theme::MUTED,
            };
            let mut row = div()
                .flex()
                .gap_3()
                .items_start()
                .child(div().text_color(rgb(color)).child("●"))
                .child(div().w(px(180.)).flex_none().font_family(MONO_FONT).text_size(px(12.)).child(check.id.to_string()))
                .child(div().flex_1().min_w_0().whitespace_normal().child(check.message.to_string()));
            if let Some(fix) = check.fix.as_ref().filter(|_| check.status != DoctorStatus::Ok) {
                let mut fix_col = div().w(px(320.)).flex_none().flex().flex_col().gap_1().child(muted(fix.label.to_string()));
                if let Some(command) = fix.command.as_ref().filter(|_| fix.kind == DoctorFixKind::Manual) {
                    fix_col = fix_col.child(self.command_line(format!("copy-fix-{}", check.id), command.to_string(), cx));
                }
                if fix.kind == DoctorFixKind::Auto {
                    let id = check.id.clone();
                    let label = if self.state.doctor_fixing(&id) { "Fixing…" } else { "Fix" };
                    fix_col = fix_col.child(div().flex().child(button(
                        SharedString::from(format!("fix-{id}")),
                        label,
                        cx.listener(move |this, _, _, cx| {
                            let out = this.state.fix_doctor(&id);
                            this.send(out);
                            cx.notify();
                        }),
                    )));
                }
                row = row.child(fix_col);
            }
            section = section.child(row);
        }
        section
    }

    fn reply_bar(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.reply.focus_handle(cx).is_focused(window);
        let echo = self.state.echo.as_ref().filter(|_| self.screen != Screen::Inbox);
        let has_text = !self.reply.read(cx).is_empty();
        div()
            .min_h(px(40.))
            .flex_none()
            .px_3()
            .py_1()
            .flex()
            .items_center()
            .gap_2()
            .border_t_1()
            .border_color(rgb(if focused { Theme::ACCENT } else { Theme::BORDER }))
            .bg(rgb(Theme::PANEL))
            .font_family(MONO_FONT)
            .text_size(px(13.))
            .child(div().text_color(rgb(Theme::ACCENT)).child("›"))
            .child(div().flex_1().min_w_0().child(self.reply.clone()))
            .when_some(echo, |d, e| {
                d.child(
                    div()
                        .max_w(px(600.))
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_color(rgb(if e.ok { Theme::GREEN } else { Theme::YELLOW }))
                        .font_family(UI_FONT)
                        .child(e.text.clone()),
                )
            })
            .when(has_text, |d| {
                d.child(div().font_family(UI_FONT).child(button("send-reply", "Send", cx.listener(|this, _, _, cx| this.send_reply(cx)))))
            })
    }

    // ---- bench -----------------------------------------------------------------------------

    fn start_bench(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        let history: usize = env_num("FLEETD_HISTORY", 20_000);
        let mut stream = LogStream::new(1);
        self.log = (0..history).map(|_| to_row(stream.next_line())).collect();
        self.state = fake::fixture_state();
        self.screen = Screen::Project;
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
        };
        let banner = self.note.clone().or_else(|| self.state.notice.clone());
        let main = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .when_some(banner, |d, text| {
                d.child(
                    div()
                        .px_3()
                        .py_1()
                        .flex()
                        .gap_2()
                        .items_center()
                        .bg(rgb(0x3a3220))
                        .child(div().flex_1().min_w_0().whitespace_normal().text_color(rgb(Theme::YELLOW)).child(text.clone()))
                        .child(self.copy_button("copy-banner", text, cx)),
                )
            })
            .child(div().flex_1().min_h_0().flex().child(screen));
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(Theme::BG))
            .text_color(rgb(Theme::TEXT))
            .text_size(px(13.))
            .font_family(UI_FONT)
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .on_action(cx.listener(|_, _: &FocusNext, window, cx| window.focus_next(cx)))
            .on_action(cx.listener(|_, _: &FocusPrev, window, cx| window.focus_prev(cx)))
            .child(crate::titlebar::TitleBar::new())
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .when(self.screen != Screen::Connect && self.screen != Screen::Loading, |d| d.child(self.sidebar(cx)))
                    .child(main),
            )
            .when(self.has_reply_bar(), |d| d.child(self.reply_bar(window, cx)))
    }
}

fn workstream_card(w: &Workstream) -> impl IntoElement {
    let state_color = match w.state {
        WorkstreamState::Done => Theme::GREEN,
        WorkstreamState::Failed | WorkstreamState::Stopped => Theme::RED,
        WorkstreamState::Draft | WorkstreamState::Idle => Theme::MUTED,
        _ => Theme::ACCENT,
    };
    let mut card = div()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .flex()
                .gap_2()
                .items_center()
                .child(muted(w.workstream_id.to_string()))
                .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(w.title.to_string()))
                .child(div().text_color(rgb(state_color)).text_size(px(11.5)).child(label(&w.state))),
        )
        .when_some(w.headline.clone(), |d, h| d.child(div().text_color(rgb(Theme::MUTED)).whitespace_normal().child(format!("lead says: {h}"))));
    match &w.brief {
        // ✓ comes only from checks the hub ran (M6); until then every item is open.
        Some(brief) => {
            for check in &brief.done_when {
                card = card
                    .child(div().pl_3().flex().gap_2().child(muted("○")).child(div().whitespace_normal().text_size(px(12.)).child(describe(check))));
            }
        }
        None => card = card.child(div().pl_3().child(muted("draft: the lead hasn't written the brief yet"))),
    }
    card
}

fn lead_badge(row: &ProjectRow) -> (u32, &'static str) {
    match row.lead().map(|l| l.state) {
        None if row.outcome.is_none() => (Theme::MUTED, "…"),
        None => (Theme::MUTED, "no lead"),
        Some(LeadState::Working) => (Theme::ACCENT, "working"),
        Some(LeadState::Idle) => (Theme::GREEN, "idle"),
        Some(LeadState::Starting) => (Theme::YELLOW, "starting"),
        Some(LeadState::Stalled) => (Theme::RED, "stalled"),
        Some(LeadState::Stopped) => (Theme::MUTED, "stopped"),
    }
}

/// Log rows for a tail: one per line, a timestamp on the first line of each item.
fn tail_rows(items: &[TailItem]) -> Vec<LogRow> {
    let mut rows = Vec::new();
    let mut push = |kind, text: String| rows.push(LogRow { kind, text: text.into() });
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
                for line in action.output_tail.iter().flat_map(|o| o.lines()) {
                    push(if action.failed { LogKind::Error } else { LogKind::Output }, format!("            {line}"));
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
    LogRow { kind: line.kind, text: line.text.into() }
}

fn env_num(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn pane(width: gpui::Pixels) -> Div {
    div().w(width).flex_none().flex().flex_col().bg(rgb(Theme::PANEL)).border_color(rgb(Theme::BORDER)).border_r_1()
}

fn header(title: &str, detail: String) -> Div {
    header_el(div().text_color(rgb(Theme::TEXT)).child(title.to_string()), muted(detail))
}

fn header_el(title: impl IntoElement, detail: impl IntoElement) -> Div {
    div()
        .h(px(32.))
        .flex_none()
        .px_3()
        .flex()
        .items_center()
        .justify_between()
        .gap_2()
        .border_b_1()
        .border_color(rgb(Theme::BORDER))
        .font_family(UI_FONT)
        .child(title)
        .child(detail)
}

fn muted(text: impl Into<SharedString>) -> Div {
    div().text_color(rgb(Theme::MUTED)).text_size(px(11.5)).child(text.into())
}

/// Anything you click: pointer cursor, a focus ring when reached with Tab (Enter/Space then click it), and a
/// click that leaves keyboard focus where it was, so typing in a field carries on.
fn clickable(el: Stateful<Div>) -> Stateful<Div> {
    el.tab_index(0)
        .cursor_pointer()
        .border_1()
        .border_color(transparent_black())
        .focus_visible(|d| d.border_color(rgb(Theme::ACCENT)))
        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
}

fn button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    clickable(div().id(id))
        .flex_none()
        .px_2()
        .py_0p5()
        .rounded_sm()
        .bg(rgb(Theme::BUTTON))
        .text_size(px(12.))
        .hover(|d| d.bg(rgb(Theme::SELECTED)))
        .on_click(on_click)
        .child(label.into())
}

/// The one main action on a screen.
fn primary_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    clickable(div().id(id))
        .px_4()
        .py_1()
        .rounded_sm()
        .bg(rgb(Theme::SELECTED))
        .text_color(rgb(Theme::TEXT))
        .hover(|d| d.bg(rgb(0x3a4c6b)))
        .on_click(on_click)
        .child(label.into())
}

fn text_row() -> Div {
    div().h(px(LINE_H)).px_3().flex().items_center().whitespace_nowrap().overflow_hidden()
}

fn log_color(kind: LogKind) -> u32 {
    match kind {
        LogKind::Tool => Theme::ACCENT,
        LogKind::Output => Theme::MUTED,
        LogKind::Thought => Theme::TEXT,
        LogKind::Ok => Theme::GREEN,
        LogKind::Error => Theme::RED,
        LogKind::User => Theme::YELLOW,
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
        let rows: Vec<(LogKind, String)> = tail_rows(&items).into_iter().map(|r| (r.kind, r.text.to_string())).collect();
        assert_eq!(rows[0], (LogKind::Thought, "10:04:05  assistant: Plan:".into()));
        assert_eq!(rows[1].1.trim(), "1. read");
        assert_eq!(rows[2], (LogKind::Error, "10:04:06  ● pnpm test [failed]".into()));
        assert_eq!((rows[3].0, rows[3].1.trim()), (LogKind::Error, "1 failed"));
    }
}
