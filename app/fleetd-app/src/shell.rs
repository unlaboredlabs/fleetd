use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::app::AppClientMessage;
use fleetd_contracts::doctor::{DoctorFixKind, DoctorStatus};
use fleetd_contracts::ledger::{Ask, AskClass, AskKind, AskState, BatchId, CheckSpec, LeadState, Workstream, WorkstreamState};
use fleetd_contracts::mcp::{TailAction, TailItem, TailMessage, TailRole};
use fleetd_contracts::model::MachineStatus;
use futures::StreamExt;
use futures::channel::mpsc::{self, UnboundedSender};
use gpui::{
    AnyElement, App, ClipboardItem, Context, Div, FocusHandle, KeyDownEvent, Keystroke, ScrollDelta, ScrollStrategy, ScrollWheelEvent, SharedString,
    Stateful, SystemNotification, Task, UniformListScrollHandle, Window, div, point, prelude::*, px, rgb, uniform_list,
};
use zeroize::Zeroize;

use crate::bench::{self, Mode, Probe};
use crate::client;
use crate::fake::{self, LogKind, LogStream};
use crate::keychain::{self, Saved};
use crate::notify::unix_secs;
use crate::seal::{self, Secret};
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Url,
    Key,
}

struct ConnectForm {
    url: String,
    key: String,
    field: Field,
    error: Option<String>,
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
    bar: String,
    form: ConnectForm,
    hub: Option<HubLink>,
    /// Shown above the screen, e.g. that the key could not be saved to the keychain.
    note: Option<String>,
    /// The secret ask whose masked field has the keyboard, and what has been typed into it.
    secret: Option<(String, Secret)>,
    /// The step command last copied, so its button says so.
    copied: Option<String>,
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
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let log_scroll = UniformListScrollHandle::new();
        log_scroll.scroll_to_bottom();
        let mut shell = Self {
            state: State::default(),
            screen: Screen::Loading,
            selected: 0,
            bar: String::new(),
            form: ConnectForm { url: "http://127.0.0.1:4790".into(), key: String::new(), field: Field::Url, error: None },
            hub: None,
            note: None,
            secret: None,
            copied: None,
            log: Vec::new(),
            log_version: 0,
            log_scroll,
            projects_scroll: UniformListScrollHandle::new(),
            follow: true,
            focus,
            bench: None,
            update: None,
        };
        match Mode::from_env() {
            Some(mode) => shell.start_bench(mode, window, cx),
            None => {
                shell.on_notification_click(window, cx);
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
        cx.on_system_notification_response(move |_, cx| {
            cx.activate(true);
            handle.update(cx, |_, window, _| window.activate_window()).ok();
            shell
                .update(cx, |this, cx| {
                    this.go(Screen::Inbox);
                    cx.notify();
                })
                .ok();
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
                    Ok(None) => this.screen = Screen::Connect,
                    Err(e) => {
                        this.form.error = Some(e);
                        this.screen = Screen::Connect;
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
                    this.after_state_change();
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
        self.form.url = saved.url.clone();
        self.hub = Some(HubLink { url: saved.url, tx: out_tx, _tasks: [run, pump, poll] });
        self.state = State::default();
        self.screen = Screen::Inbox;
        self.selected = 0;
    }

    fn send(&self, out: Vec<AppClientMessage>) {
        if let Some(hub) = &self.hub {
            for message in out {
                hub.tx.unbounded_send(message).ok();
            }
        }
    }

    fn submit_connect(&mut self, cx: &mut Context<Self>) {
        let url = self.form.url.trim().to_string();
        let key = self.form.key.trim().to_string();
        if let Err(e) = client::app_url(&url) {
            self.form.error = Some(e);
            return;
        }
        if key.is_empty() {
            self.form.error = Some("Paste a key from `fleetd hub key create --human --name <device>`.".into());
            self.form.field = Field::Key;
            return;
        }
        let saved = Saved { url, key };
        let to_save = saved.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { keychain::save(&to_save) }).await;
            this.update(cx, |this, cx| {
                this.note = result.err().map(|e| format!("{e} Connected for this session only; the key was not stored anywhere."));
                cx.notify();
            })
            .ok();
        })
        .detach();
        self.form.key.clear();
        self.form.error = None;
        self.connect(saved, cx);
    }

    fn disconnect(&mut self, cx: &mut Context<Self>) {
        self.hub = None;
        self.secret = None;
        self.state = State::default();
        self.screen = Screen::Connect;
        self.form.field = Field::Key;
        self.note = None;
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async { keychain::clear() }).await;
            this.update(cx, |this, cx| {
                this.form.error = result.err();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn after_state_change(&mut self) {
        if let Conn::Refused(message) = &self.state.conn {
            self.form.error = Some(message.clone());
            self.form.field = Field::Key;
            self.hub = None;
            self.secret = None;
            self.screen = Screen::Connect;
        }
        // The ask was answered or withdrawn elsewhere: drop (and wipe) what was typed for it.
        if self.secret.as_ref().is_some_and(|(id, _)| !self.state.asks.get(id.as_str()).is_some_and(|a| a.state == AskState::Open)) {
            self.secret = None;
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
        if screen != Screen::Inbox {
            self.secret = None;
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

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        if let Some((_, probe)) = &mut self.bench {
            probe.key_received(Instant::now(), &ks.key);
        }
        let m = &ks.modifiers;
        if m.secondary() && !m.alt {
            match ks.key.as_str() {
                "1" => self.go(Screen::Inbox),
                "2" => self.go(Screen::Projects),
                "3" => self.go(Screen::Machines),
                "v" => {
                    let mut text = cx.read_from_clipboard().and_then(|c| c.text()).unwrap_or_default();
                    match &mut self.secret {
                        Some((_, secret)) => {
                            if !secret.push_str(text.trim_end_matches(['\n', '\r'])) {
                                self.state.echo = Some(Echo { text: format!("A secret is at most {} bytes.", seal::SECRET_MAX_BYTES), ok: false });
                            }
                            text.zeroize();
                        }
                        None => self.type_text(text.trim()),
                    }
                }
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
        if self.screen == Screen::Connect {
            match key {
                "tab" => self.form.field = if self.form.field == Field::Url { Field::Key } else { Field::Url },
                "enter" => self.submit_connect(cx),
                "backspace" => {
                    self.field_mut().pop();
                }
                _ => match printable(ks) {
                    Some(ch) => self.type_text(ch),
                    None => return,
                },
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if let Some((_, secret)) = &mut self.secret {
            match key {
                "enter" => self.submit_secret(),
                "escape" => self.secret = None,
                "backspace" => secret.pop(),
                _ => match printable(ks) {
                    Some(ch) => {
                        if !secret.push_str(ch) {
                            self.state.echo = Some(Echo { text: format!("A secret is at most {} bytes.", seal::SECRET_MAX_BYTES), ok: false });
                        }
                    }
                    None => return,
                },
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        match key {
            "up" | "down" => {
                self.selected =
                    if key == "up" { self.selected.saturating_sub(1) } else { (self.selected + 1).min(self.list_len().saturating_sub(1)) };
                if self.screen == Screen::Projects {
                    self.projects_scroll.scroll_to_item(self.selected, ScrollStrategy::Nearest);
                }
            }
            "escape" if !self.bar.is_empty() => self.bar.clear(),
            "escape" if self.screen == Screen::Project => self.go(Screen::Projects),
            "backspace" => {
                self.bar.pop();
            }
            "enter" if !self.bar.is_empty() => {
                let raw = std::mem::take(&mut self.bar);
                if self.bench.is_some() {
                    // No hub in the bench: echo locally, as typing a reply would.
                    self.push_log(LogRow { kind: LogKind::User, text: format!("› you: {raw}").into() });
                } else {
                    let out = self.state.reply(&raw, None);
                    self.send(out);
                }
            }
            "enter" if self.screen == Screen::Projects => {
                if let Some(key) = self.state.projects.get(self.selected).map(ProjectRow::key) {
                    self.open_project(key);
                }
            }
            _ => match printable(ks) {
                Some(ch) => self.bar.push_str(ch),
                None => return,
            },
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn field_mut(&mut self) -> &mut String {
        match self.form.field {
            Field::Url => &mut self.form.url,
            Field::Key => &mut self.form.key,
        }
    }

    fn type_text(&mut self, text: &str) {
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        if self.screen == Screen::Connect { self.field_mut().push_str(&text) } else { self.bar.push_str(&text) }
    }

    /// Seals what was typed to the sink machine's key and sends only the ciphertext; the typed value is
    /// wiped when `secret` drops at the end of this call, whatever happens.
    fn submit_secret(&mut self) {
        let Some((ask_id, secret)) = self.secret.take() else { return };
        if secret.is_empty() {
            self.secret = Some((ask_id, secret));
            return;
        }
        let Some(ask) = self.state.asks.get(ask_id.as_str()) else { return };
        match self.state.secret_target(ask).and_then(|(machine, key)| Ok((machine, seal::seal(&key, secret.bytes())?))) {
            Ok((machine, sealed)) => {
                let out = self.state.submit_secret(&ask_id, &machine, sealed);
                self.send(out);
            }
            Err(e) => self.state.echo = Some(Echo { text: e, ok: false }),
        }
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
            div()
                .id(label)
                .h(px(30.))
                .px_3()
                .flex()
                .items_center()
                .gap_2()
                .cursor_pointer()
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
            .when_some(self.update.clone(), |d, text| d.child(div().px_3().py_1().whitespace_normal().text_color(rgb(Theme::ACCENT)).child(text)))
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
                        .child(muted(self.hub.as_ref().map(|h| h.url.clone()).unwrap_or_default()))
                        .child(button("disconnect", "Disconnect and forget key", cx.listener(|this, _, _, cx| this.disconnect(cx)))),
                )
            })
            .when(self.bench.is_some(), |d| d.child(div().p_3().child(muted(bench_status))))
    }

    fn connect_screen(&self, window: &Window) -> AnyElement {
        let focused = self.focus.is_focused(window);
        let field = |label: &'static str, which: Field, value: String, placeholder: &'static str| {
            let active = focused && self.form.field == which;
            div().flex().flex_col().gap_1().child(muted(label)).child(
                div()
                    .h(px(32.))
                    .px_2()
                    .flex()
                    .items_center()
                    .border_1()
                    .rounded_sm()
                    .border_color(rgb(if active { Theme::ACCENT } else { Theme::BORDER }))
                    .bg(rgb(Theme::BG))
                    .font_family(MONO_FONT)
                    .child(if value.is_empty() { div().text_color(rgb(Theme::MUTED)).child(placeholder) } else { div().child(value) })
                    .when(active, |d| d.child(caret())),
            )
        };
        let masked = if self.form.key.is_empty() {
            String::new()
        } else {
            format!("{}{}", &self.form.key[..self.form.key.len().min(4)], "•".repeat(self.form.key.len().saturating_sub(4).min(40)))
        };
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .w(px(460.))
                    .p_5()
                    .flex()
                    .flex_col()
                    .gap_4()
                    .bg(rgb(Theme::PANEL))
                    .border_1()
                    .border_color(rgb(Theme::BORDER))
                    .rounded_md()
                    .child(div().text_size(px(16.)).child("Connect to a fleetd hub"))
                    .child(field("Hub URL", Field::Url, self.form.url.clone(), "http://127.0.0.1:4790"))
                    .child(field("Key", Field::Key, masked, "fld_…"))
                    .when_some(self.form.error.clone(), |d, e| d.child(div().text_color(rgb(Theme::RED)).child(e)))
                    .child(div().whitespace_normal().child(muted(
                        "On the hub, create a key for this device with `fleetd hub key create --human --name <device>`, so your answers are recorded as yours.",
                    )))
                    .child(muted("Tab switches fields, Enter connects. The key is kept in the OS keychain, never in a file.")),
            )
            .into_any_element()
    }

    fn inbox_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let items = self.state.inbox();
        let mut body = div().id("inbox").flex_1().min_h_0().overflow_y_scroll().p_3().flex().flex_col().gap_2();
        if let Some(echo) = &self.state.echo {
            body = body.child(div().text_color(rgb(if echo.ok { Theme::GREEN } else { Theme::YELLOW })).child(echo.text.clone()));
        }
        if let Some(e) = &self.state.asks_error {
            body = body.child(div().text_color(rgb(Theme::RED)).child(e.clone()));
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
                let copied = self.copied.as_deref() == Some(command.as_str());
                let to_copy = command.to_string();
                card = card.child(
                    div()
                        .pl_4()
                        .flex()
                        .gap_2()
                        .items_center()
                        .child(div().flex_1().min_w_0().whitespace_normal().font_family(MONO_FONT).text_size(px(12.)).child(command.to_string()))
                        .child(button(
                            SharedString::from(format!("{}-copy-{i}", ask.ask_id)),
                            if copied { "Copied" } else { "Copy" },
                            cx.listener(move |this, _, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(to_copy.clone()));
                                this.copied = Some(to_copy.clone());
                                cx.notify();
                            }),
                        )),
                );
            }
            if let Some(expect) = &step.expect {
                card = card.child(div().pl_4().child(muted(format!("expect: {expect}"))));
            }
        }
        if let Some(gated) = &ask.gated {
            // The exact stored argv, as JSON so spaces and quotes stay visible.
            let argv = serde_json::to_string(&gated.argv).unwrap_or_default();
            card = card
                .child(div().whitespace_normal().font_family(MONO_FONT).text_size(px(12.)).child(argv))
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

    /// Masked entry: the value lives only in a self-wiping buffer, and is sealed to the sink machine's key
    /// here before anything is sent.
    fn secret_entry(&self, ask: &Ask, cx: &mut Context<Self>) -> Div {
        let mut col = div().flex().flex_col().gap_1().child(muted(format!("{} → {}", ask.key, ask.sink.as_deref().unwrap_or("?"))));
        let machine = match self.state.secret_target(ask) {
            Ok((machine, _)) => machine,
            Err(reason) => return col.child(div().text_color(rgb(Theme::YELLOW)).whitespace_normal().child(reason)),
        };
        let typed = self.secret.as_ref().filter(|(id, _)| id == ask.ask_id.as_str()).map(|(_, s)| s.chars());
        let sending = self.state.secret_submitting(&ask.ask_id);
        let open = ask.ask_id.to_string();
        let field = div()
            .id(SharedString::from(format!("{}-secret", ask.ask_id)))
            .flex_1()
            .h(px(30.))
            .px_2()
            .flex()
            .items_center()
            .border_1()
            .rounded_sm()
            .border_color(rgb(if typed.is_some() { Theme::ACCENT } else { Theme::BORDER }))
            .bg(rgb(Theme::BG))
            .font_family(MONO_FONT)
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                if this.secret.as_ref().is_none_or(|(id, _)| *id != open) {
                    this.secret = Some((open.clone(), Secret::default()));
                }
                cx.notify();
            }))
            .child(match typed {
                Some(0) => div().text_color(rgb(Theme::MUTED)).child("Type or paste the value, Enter seals and sends, Esc cancels"),
                Some(n) => div().child("•".repeat(n.min(40))),
                None => div().text_color(rgb(Theme::MUTED)).child("Click to enter the value"),
            })
            .when(typed.is_some(), |d| d.child(caret()));
        let send = button(
            SharedString::from(format!("{}-seal", ask.ask_id)),
            if sending { "Sending…" } else { "Seal & send" },
            cx.listener(|this, _, _, cx| {
                this.submit_secret();
                cx.notify();
            }),
        );
        col = col
            .child(div().flex().gap_2().items_center().child(field).when(typed.is_some_and(|n| n > 0), |d| d.child(send)))
            .child(muted(format!("Encrypted here to {machine}'s key; the hub never sees the value.")));
        col
    }

    fn projects_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(header("Projects", "↑↓ select · Enter opens".into()))
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
        div()
            .id(ix)
            .w_full()
            .h(px(ROW_H))
            .px_3()
            .flex()
            .items_center()
            .gap_3()
            .whitespace_nowrap()
            .overflow_hidden()
            .cursor_pointer()
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
                left = left.child(div().text_color(rgb(Theme::RED)).whitespace_normal().child(e.clone()));
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
                            .child(title)
                            .child(self.machine_chip(&key.0))
                            .when(row.is_some_and(ProjectRow::stale), |d| {
                                d.child(div().text_color(rgb(Theme::YELLOW)).text_size(px(11.5)).child("stale"))
                            }),
                        muted("Esc back"),
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
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .bg(rgb(Theme::BG))
            .child(header_el(
                div().flex().gap_2().items_center().child(div().text_color(rgb(lead_color)).child("●")).child(muted(lead_label)).child(title),
                muted(format!("{} lines · {status}", self.log.len())),
            ))
            .when_some(error, |d, e| d.child(div().px_3().py_1().text_color(rgb(Theme::RED)).child(e)))
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
            let t3 = m.t3.as_ref().map_or("T3 not reachable".to_string(), |t| format!("T3 {}", t.version));
            list = list.child(
                div()
                    .min_h(px(ROW_H))
                    .px_3()
                    .py_1()
                    .flex()
                    .items_center()
                    .gap_3()
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
                    .child(muted(t3))
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
            section = section.child(div().text_color(rgb(Theme::RED)).whitespace_normal().child(e));
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
                    fix_col = fix_col.child(div().whitespace_normal().font_family(MONO_FONT).text_size(px(12.)).child(command.to_string()));
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

    fn reply_bar(&self, window: &Window) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        let echo = self.state.echo.as_ref().filter(|_| self.screen != Screen::Inbox);
        div()
            .h(px(40.))
            .flex_none()
            .px_3()
            .flex()
            .items_center()
            .gap_2()
            .border_t_1()
            .border_color(rgb(if focused { Theme::ACCENT } else { Theme::BORDER }))
            .bg(rgb(Theme::PANEL))
            .font_family(MONO_FONT)
            .text_size(px(13.))
            .child(div().text_color(rgb(Theme::ACCENT)).child("›"))
            .child(if self.bar.is_empty() {
                div().text_color(rgb(Theme::MUTED)).child("Reply to the inbox: 1 go 2 nvm 3 b")
            } else {
                div().text_color(rgb(Theme::TEXT)).child(self.bar.clone())
            })
            .when(focused, |d| d.child(caret()))
            .child(div().flex_1())
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
        let screen = match self.screen {
            Screen::Loading => div().flex_1().into_any_element(),
            Screen::Connect => self.connect_screen(window),
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
            .when_some(banner, |d, text| d.child(div().px_3().py_1().bg(rgb(0x3a3220)).text_color(rgb(Theme::YELLOW)).child(text)))
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
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .when(self.screen != Screen::Connect && self.screen != Screen::Loading, |d| d.child(self.sidebar(cx)))
                    .child(main),
            )
            .when(!matches!(self.screen, Screen::Connect | Screen::Loading), |d| d.child(self.reply_bar(window)))
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

fn caret() -> Div {
    div().w(px(7.)).h(px(16.)).bg(rgb(Theme::ACCENT))
}

fn button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .px_2()
        .py_0p5()
        .rounded_sm()
        .bg(rgb(Theme::BUTTON))
        .text_size(px(12.))
        .cursor_pointer()
        .hover(|d| d.bg(rgb(Theme::SELECTED)))
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
